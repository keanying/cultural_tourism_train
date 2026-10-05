"""离线评测：对微调后模型在 test 集上的输出打分，对应客户“怎么算合格”的验收口径。

预测文件格式（JSONL，每行一条，与 test 集顺序一致或带 index）：
  {"index": 0, "output": "<thought>...</thought>\n<answer>...</answer>"}
用法：
  python -m distill.evaluate --task dynamic_pricing --pred preds.jsonl
  python -m distill.evaluate --task dynamic_pricing --self-check     # 用参考答案自测评测脚本（应为满分）

指标：
  combo_recommend   推荐命中率（离线代理“被点击/购买比例”）、幻觉率（推荐不在库存）、约束违规率
  visitor_forecast  对真实客流的 MAPE / 加权误差、区间覆盖率
  dynamic_pricing   规则命中准确率、动作准确率、价格 MAE、限价合规率、预计收入达成率
  channel_placement 约束合规率、预算分配偏差、按输入数据复算的预期 GMV 达成率
  business_insight  归因闭合率、核心指标数值准确率、主因判断一致率
"""
import argparse
import json
import math
import os
import re

import numpy as np

from . import config
from .io_utils import iter_jsonl_shards
from .sft.common import fmt_money

ANS_RE = re.compile(r"<answer>\s*(.+?)\s*</answer>", re.S)


def _answer(text):
    m = ANS_RE.search(text or "")
    return m.group(1) if m else None


def _json(text):
    try:
        return json.loads(text)
    except Exception:
        return None


def load_test(task):
    d = os.path.join(config.SFT_DIR, task)
    samples = list(iter_jsonl_shards(d, f"{task}_test"))
    metas = [m for m in iter_jsonl_shards(d, f"{task}_meta") if m["split"] == "test"]
    return samples, metas


def eval_task(task, samples, metas, outputs):
    res = {"n": len(samples)}
    parse_fail = 0
    if task == "combo_recommend":
        hit = halluc = viol = 0
        for s, m, o in zip(samples, metas, outputs):
            user = json.loads(s["messages"][1]["content"])
            ans = _answer(o)
            if ans is None:
                parse_fail += 1
                continue
            by_name = {p["name"]: p["id"] for p in user["available_products"]}
            quoted = re.findall(r"「(.+?)」", ans)
            pred = next((by_name[q] for q in quoted if q in by_name), None)
            no_rec = any(w in ans for w in ("不太适合", "暂无", "不给您硬推"))
            if pred is None and not no_rec:  # 商品名自身含「」等情况，退回最长名称子串匹配
                names = sorted(user["available_products"], key=lambda p: -len(p["name"]))
                pred = next((p["id"] for p in names if p["name"] in ans), None)
            if pred is None and not no_rec:
                ids = re.findall(r"P\d{7}", ans)
                pred = ids[-1] if ids else None
                if pred and pred not in {p["id"] for p in user["available_products"]}:
                    halluc += 1
            gt = m["gt_product_id"]
            if pred == gt or (gt is None and pred is None):
                hit += 1
            if pred and pred in m.get("excluded", {}):
                viol += 1
        res.update(hit_rate=hit / len(samples), hallucination_rate=halluc / len(samples),
                   constraint_violation_rate=viol / len(samples))
    elif task == "visitor_forecast":
        ape, cover, cnt = [], 0, 0
        abs_err = act_sum = 0
        for s, m, o in zip(samples, metas, outputs):
            a = _json(_answer(o))
            if not a or len(a.get("predictions", [])) != 7:
                parse_fail += 1
                continue
            for p, act in zip(a["predictions"], m["actual"]):
                ape.append(abs(p["visitors"] - act) / max(act, 1))
                abs_err += abs(p["visitors"] - act)
                act_sum += act
                cover += p["lower"] <= act <= p["upper"]
                cnt += 1
        res.update(mape=float(np.mean(ape)) if ape else None, wape=abs_err / act_sum if act_sum else None,
                   interval_coverage=cover / cnt if cnt else None)
    elif task == "dynamic_pricing":
        rule = act = comp = 0
        mae = []
        for s, m, o in zip(samples, metas, outputs):
            user = json.loads(s["messages"][1]["content"])
            a = _json(_answer(o))
            if not a:
                parse_fail += 1
                continue
            r = user["定价规则"]
            rule += a.get("rule_id") == m["rule"]
            act += a.get("action") == m["action"]
            sp = a.get("suggested_price", 0)
            comp += r["最低保底价"] <= sp <= r["最高限价"]
            mae.append(abs(sp - m["suggested_price"]))
        res.update(rule_accuracy=rule / len(samples), action_accuracy=act / len(samples),
                   price_mae=float(np.mean(mae)) if mae else None, compliance_rate=comp / len(samples))
    elif task == "channel_placement":
        ok = 0
        ratio, l1 = [], []
        for s, m, o in zip(samples, metas, outputs):
            user = json.loads(s["messages"][1]["content"])
            a = _json(_answer(o))
            if not a:
                parse_fail += 1
                continue
            b = user["投放目标"]["总预算"]
            cap = float(user["约束条件"]["单渠道预算占比上限"].rstrip("%")) / 100
            alloc = {x["channel"]: x["budget"] for x in a.get("allocations", [])}
            tot = sum(alloc.values()) + a.get("reserved_budget", 0)
            ok += abs(tot - b) <= 2 and all(v <= b * cap + 1 for v in alloc.values())
            gm = _replay_gmv(user, alloc)
            gt = _replay_gmv(user, m["allocation"])
            ratio.append(gm / gt if gt else (1.0 if gm == 0 else 0.0))
            chans = set(alloc) | set(m["allocation"])
            l1.append(sum(abs(alloc.get(c, 0) - m["allocation"].get(c, 0)) for c in chans) / b)
        res.update(constraint_pass_rate=ok / len(samples), gmv_attainment=float(np.mean(ratio)) if ratio else None,
                   allocation_l1_share=float(np.mean(l1)) if l1 else None)
    elif task == "business_insight":
        closed = metric_ok = top_ok = 0
        for s, m, o, ref in zip(samples, metas, outputs, (x["messages"][2]["content"] for x in samples)):
            user = json.loads(s["messages"][1]["content"])
            a = _json(_answer(o))
            r = _json(_answer(ref))
            if not a:
                parse_fail += 1
                continue
            dR = user["本期经营指标"]["总收入"] - user["对比期经营指标"]["总收入"]
            sr = sum(x.get("impact", 0) for x in a.get("revenue_attribution", []))
            closed += abs(sr - dR) <= 3
            km = {x["metric"]: x["change"] for x in a.get("key_metrics", [])}
            rk = {x["metric"]: x["change"] for x in r["key_metrics"]}
            metric_ok += sum(km.get(k) == v for k, v in rk.items()) / len(rk)
            top = lambda z: max(z["visitor_attribution"], key=lambda x: abs(x["impact_visitors"]))["factor"] if z.get("visitor_attribution") else None
            top_ok += top(a) == top(r)
        res.update(attribution_closure_rate=closed / len(samples), key_metric_accuracy=metric_ok / len(samples),
                   main_factor_agreement=top_ok / len(samples))
    res["parse_fail_rate"] = parse_fail / len(samples) if samples else 0
    return res


def _replay_gmv(user, alloc):
    from .sft.placement import gmv_fn
    rows = {x["渠道"]: x for x in user["近3个月分渠道投放表现"]}
    segs = [float(x["目标客群占比"].rstrip("%")) / 100 for x in rows.values()]
    mean = sum(segs) / len(segs)
    tot = 0.0
    for c, s in alloc.items():
        if c not in rows or s <= 0:
            continue
        x = rows[c]
        match = round(float(x["目标客群占比"].rstrip("%")) / 100 / mean, 3)
        eff = round(x["ROAS"] * match, 3)
        K = round(x["营销费用"] / 3 * 2)
        tot += gmv_fn(eff, K, s)
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--pred")
    ap.add_argument("--self-check", action="store_true")
    a = ap.parse_args()
    samples, metas = load_test(a.task)
    if a.self_check:
        outputs = [s["messages"][2]["content"] for s in samples]
    else:
        preds = [json.loads(l) for l in open(a.pred, encoding="utf-8")]
        preds.sort(key=lambda x: x.get("index", 0))
        outputs = [p["output"] for p in preds]
        n = min(len(outputs), len(samples))
        samples, metas, outputs = samples[:n], metas[:n], outputs[:n]
    print(json.dumps(eval_task(a.task, samples, metas, outputs), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
