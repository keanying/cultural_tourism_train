"""质量校验：明细数据集（主键/外键/跨表一致性）+ SFT 训练集（格式/业务约束/数字闭合）。

用法：python -m distill.validate        输出 output/quality_report.json 与 output/quality_report.md
任何一项失败都会在报告中标红并以非零状态码退出。
"""
import json
import math
import os
import re
import sys

import pandas as pd

from . import config
from .io_utils import iter_jsonl_shards, read_csv_shards

ASSIST_RE = re.compile(r"^<thought>\n(.+)\n</thought>\n<answer>\n(.+)\n</answer>$", re.S)


def check(cond, name, results, detail=""):
    results.append({"check": name, "passed": bool(cond), "detail": detail})
    return cond


def validate_datasets(results):
    d = config.DATASET_DIR
    load = lambda n: read_csv_shards(os.path.join(d, n), n)
    prod = load("scenic_product_detail")
    prof = load("visitor_profile")
    orders = load("visitor_consumption")
    traj = load("visitor_trajectory")
    ch = load("channel_distribution")
    ops = load("scenic_daily_ops")
    n = config.DATASET_ROWS
    for name, df in [("scenic_product_detail", prod), ("visitor_profile", prof), ("visitor_consumption", orders),
                     ("visitor_trajectory", traj), ("channel_distribution", ch)]:
        check(len(df) == n, f"{name} 行数={n}", results, f"实际 {len(df)}")
    check(prod["product_id"].is_unique, "产品ID唯一", results)
    check(prof["visitor_id"].is_unique, "游客ID唯一", results)
    check(orders["order_id"].is_unique, "订单ID唯一", results)
    check(traj["trajectory_id"].is_unique, "轨迹ID唯一", results)
    check(orders["visitor_id"].isin(prof["visitor_id"]).all(), "订单→游客 外键完整", results)
    check(orders["product_id"].isin(prod["product_id"]).all(), "订单→产品 外键完整", results)
    check(traj["visitor_id"].isin(prof["visitor_id"]).all(), "轨迹→游客 外键完整", results)
    to = traj["order_id"].dropna()
    to = to[to != ""]
    check(to.isin(orders["order_id"]).all(), "轨迹→订单 外键完整", results)
    linked = orders[orders["order_id"].isin(set(to))]
    check((linked["order_status"] == "已核销").all(), "有轨迹的订单均为已核销", results)
    check(ch["product_id"].isin(prod["product_id"]).all(), "渠道→产品 外键完整", results)
    check((prod["floor_price"] <= prod["list_price"]).all() and (prod["list_price"] <= prod["ceiling_price"]).all(),
          "产品 保底价≤标价≤最高限价", results)
    pay_ok = (orders["paid_amount"] - (orders["original_amount"] - orders["coupon_amount"])).abs().max() < 0.02
    check(pay_ok, "订单 实付=原价-优惠", results)
    ref = orders[orders["order_status"] == "已退款"]
    check((ref["total_spend"] == 0).all(), "退款订单消费额为0", results)
    check((ops["visitors"] <= ops["daily_capacity"]).all(), "日客流≤日最大承载量", results)
    check((ops["online_bookings"] + ops["offline_visitors"] == ops["visitors"]).all(), "线上+线下=日客流", results)
    m = ops.assign(m=ops["date"].str[:7]).groupby(["poi_id", "m"])["visitors"].sum()
    c = ch.groupby(["poi_id", "stat_month"])["tickets_sold"].sum()
    c.index.names = ["poi_id", "m"]
    j = pd.concat([m, c], axis=1, keys=["ops", "ch"]).dropna()
    check((j["ops"] == j["ch"]).all(), "渠道月售票合计=日度客流月合计", results, f"对齐 {len(j)} 个景区-月")
    paid = orders[orders["order_status"] != "已退款"].groupby("visitor_id")["total_spend"].sum().round(2)
    pp = prof.set_index("visitor_id")["total_spend"]
    diff = (pp.reindex(paid.index) - paid).abs().max()
    check(diff < 0.05, "画像消费汇总=订单汇总", results, f"最大偏差 {diff}")
    return {"products": prod, "ops": ops}


def _num(s):
    return float(s.rstrip("%")) / 100 if isinstance(s, str) and s.endswith("%") else float(s)


def validate_sft(results):
    stats = {}
    for task in ["combo_recommend", "visitor_forecast", "dynamic_pricing", "channel_placement", "business_insight"]:
        d = os.path.join(config.SFT_DIR, task)
        if not os.path.isdir(d):
            check(False, f"{task} 训练集存在", results)
            continue
        metas = list(iter_jsonl_shards(d, f"{task}_meta"))
        meta_by = {}
        for m in metas:
            meta_by.setdefault(m["split"], []).append(m)
        bad_fmt = bad_logic = total = 0
        examples = []
        lens = []
        for split in ("train", "val", "test"):
            ms = meta_by.get(split, [])
            for i, s in enumerate(iter_jsonl_shards(d, f"{task}_{split}")):
                total += 1
                msgs = s.get("messages", [])
                ok = (len(s) == 1 and len(msgs) == 3 and [x["role"] for x in msgs] == ["system", "user", "assistant"])
                mt = ASSIST_RE.match(msgs[2]["content"]) if ok else None
                try:
                    user = json.loads(msgs[1]["content"])
                    ans_txt = mt.group(2) if mt else None
                    ans = json.loads(ans_txt) if (mt and task != "combo_recommend") else ans_txt
                except Exception:
                    user = ans = None
                if not (ok and mt and user is not None and ans is not None):
                    bad_fmt += 1
                    if len(examples) < 5:
                        examples.append(f"{split}#{i} 格式错误")
                    continue
                lens.append(sum(len(x["content"]) for x in msgs))
                meta = ms[i] if i < len(ms) else {}
                err = _logic(task, user, ans, meta)
                if err:
                    bad_logic += 1
                    if len(examples) < 5:
                        examples.append(f"{split}#{i} {err}")
        check(bad_fmt == 0, f"{task} 格式合规（messages/thought/answer/JSON）", results, f"{bad_fmt}/{total} 不合规")
        check(bad_logic == 0, f"{task} 业务约束与数字闭合", results, f"{bad_logic}/{total} 不通过 {examples}")
        lens.sort()
        stats[task] = {"samples": total, "chars_p50": lens[len(lens) // 2] if lens else 0,
                       "chars_p95": lens[int(len(lens) * 0.95)] if lens else 0, "chars_max": lens[-1] if lens else 0}
    return stats


def _logic(task, user, ans, meta):
    if task == "combo_recommend":
        ids = {p["id"]: p for p in user["available_products"]}
        gt = meta.get("gt_product_id")
        if gt is None:
            return None if "不太适合" in ans or "暂" in ans else "无推荐样本话术不符"
        if gt not in ids:
            return "推荐ID不在库存列表"
        if ids[gt]["name"] not in ans:
            return "话术未包含推荐产品名称"
        up = meta.get("upsell_price")
        from .sft.common import fmt_money
        if up is not None and fmt_money(up) not in ans:
            return "话术价格与计算不一致"
        return None
    if task == "visitor_forecast":
        cap = user["景区信息"]["日最大承载量"]
        p = ans["predictions"]
        if len(p) != 7:
            return "预测天数≠7"
        if any(not (x["lower"] <= x["visitors"] <= x["upper"] <= cap) for x in p):
            return "区间或承载约束不满足"
        if sum(x["visitors"] for x in p) != ans["total_7d"]:
            return "7日合计不闭合"
        return None
    if task == "dynamic_pricing":
        r = user["定价规则"]
        sp = ans["suggested_price"]
        if not (r["最低保底价"] <= sp <= r["最高限价"]):
            return "建议价超出限价"
        cur = r["当前执行价"]
        exp = "raise_price" if sp > cur else ("lower_price" if sp < cur else "keep_price")
        if ans["action"] != exp:
            return "action与价格方向不一致"
        for k in ("action", "suggested_price", "confidence", "reason", "rule_id"):
            if k not in ans:
                return f"缺少字段{k}"
        return None
    if task == "channel_placement":
        b = user["投放目标"]["总预算"]
        tot = sum(x["budget"] for x in ans["allocations"]) + ans["reserved_budget"]
        if abs(tot - b) > 2:
            return "分配合计≠总预算"
        cap = _num(user["约束条件"]["单渠道预算占比上限"])
        if any(x["budget"] > b * cap + 1 for x in ans["allocations"]):
            return "超单渠道占比上限"
        th = user["约束条件"]["最低ROAS门槛"]
        if any(x["last_step_roas"] < th - 0.01 for x in ans["allocations"]):
            return "末步增量ROAS低于门槛"
        names = {x["渠道"] for x in user["近3个月分渠道投放表现"]}
        if any(x["channel"] not in names for x in ans["allocations"]):
            return "出现输入中不存在的渠道"
        return None
    if task == "business_insight":
        a, b = user["本期经营指标"], user["对比期经营指标"]
        dR = a["总收入"] - b["总收入"]
        dV = a["接待人次"] - b["接待人次"]
        sr = sum(x["impact"] for x in ans["revenue_attribution"])
        sv = sum(x["impact_visitors"] for x in ans["visitor_attribution"])
        if abs(sr - dR) > 3:
            return f"收入归因不闭合 {sr} vs {dR}"
        if dV and abs(sv - dV) > 3:
            return f"客流归因不闭合 {sv} vs {dV}"
        sc = sum(x["本期售票"] - x["对比期售票"] for x in user["分渠道售票"])
        if sc != dV:
            return "渠道合计≠客流差额"
        return None
    return None


def main():
    results = []
    validate_datasets(results)
    stats = validate_sft(results)
    passed = all(r["passed"] for r in results)
    rep = {"passed": passed, "checks": results, "sft_length_stats": stats}
    os.makedirs(config.OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(config.OUTPUT_DIR, "quality_report.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2)
    lines = ["# 数据质量校验报告", "", f"总体结论：{'✅ 全部通过' if passed else '❌ 存在未通过项'}", "",
             "| 校验项 | 结果 | 说明 |", "|---|---|---|"]
    for r in results:
        lines.append(f"| {r['check']} | {'✅' if r['passed'] else '❌'} | {r['detail']} |")
    lines += ["", "## 训练集长度统计（字符数，system+user+assistant）", "", "| 任务 | 样本数 | P50 | P95 | 最大 |", "|---|---|---|---|---|"]
    for t, s in stats.items():
        lines.append(f"| {t} | {s['samples']} | {s['chars_p50']} | {s['chars_p95']} | {s['chars_max']} |")
    with open(os.path.join(config.OUTPUT_DIR, "quality_report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
