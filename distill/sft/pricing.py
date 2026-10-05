"""训练集③：票务产品动态定价模型（dynamic_pricing）

输入字段沿用客户样例（目标日期/预订数据/当日预测客流量/外部时空特征/定价规则），
补充“距离目标日天数”“产品信息”“竞品均价”以覆盖临期清库存、竞品约束场景。
决策由显式规则表给出（写入 system prompt），思维链包含指标计算、规则匹配、公式套用、
合规性自检（限价 + 竞品）与收益测算，输出 JSON 保留客户要求的 5 个字段并扩展测算字段。
动作分布按配额采样，避免“维持原价”样本过多导致模型偏置。
"""
import numpy as np
import pandas as pd

from .. import config
from .common import SftWriter, dumps, fmt_money, make_sample, num, pct, signed_pct

TASK = "dynamic_pricing"

SYSTEM = (
    "你是景区收益管理策略分析师。你的任务是基于提供的【每日预订数据】、【当日预测客流量】、【外部时空特征】和【定价规则】，"
    "输出最优的动态定价建议。严禁超出最高/最低限价，必须在思维链中进行合规性自检。\n"
    "指标口径：已售=昨日累计预订量+今日实时预订量；售出率=已售÷总库存；需求比=当日预测客流量÷总库存；"
    "进度指数=已售÷(当日预测客流量×常规预售进度)。常规预售进度（距目标日0/1/2/3天）：普通日60%/50%/40%/30%，"
    "节假日（含周末）68%/62%/55%/48%。\n"
    "定价规则（按顺序匹配，命中即停止）：\n"
    "R1 LAST_MINUTE_SURGE_V1：售出率≥85%且需求比≥0.95 → 现价×溢价系数；\n"
    "R2 DEMAND_SURGE_V1：需求比≥1.0且进度指数≥1.0 → 现价×(1+(溢价系数-1)/2)；\n"
    "R3 PACE_AHEAD_V1：进度指数≥1.3且需求比≥0.8 → 现价×(1+(溢价系数-1)/3)；\n"
    "R4 LAST_MINUTE_CLEARANCE_V1：距目标日≤1天且需求比<0.5且售出率<30% → 现价×折扣系数；\n"
    "R5 SLOW_PACE_DISCOUNT_V1：进度指数<0.7且需求比<0.8 → 现价×(1-(1-折扣系数)/2)；\n"
    "R6 HOLD_V1：以上均未命中 → 维持现价。\n"
    "约束：价格四舍五入到元；上调后不得高于竞品均价×1.3（超出则取max(现价, 竞品均价×1.3)）；最终价必须在[最低保底价, 最高限价]内。\n"
    "收益测算：价格弹性在节假日/旺季取0.6，其他取1.4；剩余需求=max(预测客流-已售,0)，调价后需求=剩余需求×(新价/现价)^(-弹性)，"
    "新增售出=min(需求, 剩余库存)。\n"
    "输出格式：<thought>内给出完整推理，<answer>内输出JSON。"
)

PACE = {"普通": {0: 0.60, 1: 0.50, 2: 0.40, 3: 0.30}, "节假日": {0: 0.68, 1: 0.62, 2: 0.55, 3: 0.48}}
CONF = {"R1": 0.95, "R2": 0.9, "R3": 0.85, "R4": 0.9, "R5": 0.85, "R6": 0.8}
RULE_ID = {"R1": "LAST_MINUTE_SURGE_V1", "R2": "DEMAND_SURGE_V1", "R3": "PACE_AHEAD_V1",
           "R4": "LAST_MINUTE_CLEARANCE_V1", "R5": "SLOW_PACE_DISCOUNT_V1", "R6": "HOLD_V1"}
QUOTA = {"raise_price": 0.36, "lower_price": 0.36, "keep_price": 0.28}
PEAK_WORDS = ("旺季", "黄金周", "小长假")


def round_half_up(x):
    return int(np.floor(x + 0.5))


def decide(f):
    """f: 特征 dict。返回决策全过程（供思维链与答案共同使用）。"""
    sold = f["yday"] + f["today"]
    st = sold / f["inv"]
    dr = f["forecast"] / f["inv"]
    kind = "节假日" if f["is_holiday"] else "普通"
    pace_std = PACE[kind][f["k"]]
    pi = sold / (f["forecast"] * pace_std) if f["forecast"] > 0 else 0
    p, prem, disc = f["price"], f["premium"], f["discount"]
    if st >= 0.85 and dr >= 0.95:
        rule, mult, formula = "R1", prem, f"{fmt_money(p)}×{prem}"
    elif dr >= 1.0 and pi >= 1.0:
        mult = 1 + (prem - 1) / 2
        rule, formula = "R2", f"{fmt_money(p)}×(1+({prem}-1)/2)={fmt_money(p)}×{round(mult, 4)}"
    elif pi >= 1.3 and dr >= 0.8:
        mult = 1 + (prem - 1) / 3
        rule, formula = "R3", f"{fmt_money(p)}×(1+({prem}-1)/3)={fmt_money(p)}×{round(mult, 4)}"
    elif f["k"] <= 1 and dr < 0.5 and st < 0.3:
        rule, mult, formula = "R4", disc, f"{fmt_money(p)}×{disc}"
    elif pi < 0.7 and dr < 0.8:
        mult = 1 - (1 - disc) / 2
        rule, formula = "R5", f"{fmt_money(p)}×(1-(1-{disc})/2)={fmt_money(p)}×{round(mult, 4)}"
    else:
        rule, mult, formula = "R6", 1.0, f"维持{fmt_money(p)}"
    raw = p * mult
    new = round_half_up(raw)
    notes = []
    comp_cap = f["comp"] * 1.3
    if new > p and new > comp_cap:
        new2 = max(round_half_up(p), round_half_up(comp_cap))
        notes.append(("comp", new, new2))
        new = new2
    if new > f["ceiling"]:
        notes.append(("ceiling", new, int(f["ceiling"])))
        new = int(f["ceiling"])
    if new < f["floor"]:
        notes.append(("floor", new, int(f["floor"])))
        new = int(f["floor"])
    action = "raise_price" if new > p else ("lower_price" if new < p else "keep_price")
    peak = f["is_holiday"] or any(w in f["season"] for w in PEAK_WORDS)
    e = 0.6 if peak else 1.4
    remain_inv = max(f["inv"] - sold, 0)
    d_rem = max(f["forecast"] - sold, 0)
    d_new = d_rem * (new / p) ** (-e) if p > 0 else d_rem
    add_old = min(d_rem, remain_inv)
    add_new = min(d_new, remain_inv)
    rev_old = add_old * p
    rev_new = add_new * new
    conf = CONF[rule] - (0.05 if notes else 0)
    return dict(sold=sold, st=st, dr=dr, kind=kind, pace_std=pace_std, pi=pi, rule=rule, mult=mult, formula=formula,
                raw=raw, new=new, notes=notes, action=action, e=e, remain_inv=remain_inv, d_rem=d_rem, d_new=d_new,
                add_old=add_old, add_new=add_new, rev_old=rev_old, rev_new=rev_new, conf=round(conf, 2))


CHANNEL_STRATEGY = {
    "R1": "全渠道同步上调；官网/小程序会员可保留少量原价额度以维护会员权益，线下窗口同步执行新价。",
    "R2": "OTA与官网同步上调，抖音团购等低价渠道暂停新增库存投放，避免低价渠道抢占剩余库存。",
    "R3": "优先在OTA与官网上调，旅行社分销按合同价执行不变，持续监控预订速度。",
    "R4": "折扣价优先投放OTA尾单特惠与抖音团购等价格敏感渠道，线下窗口维持原价，避免冲击已购用户。",
    "R5": "以官网/小程序限时券形式定向发放给价格敏感客群，OTA同步折扣价，节省渠道佣金。",
    "R6": "各渠道维持现价，持续监控预订速度，若进度变化再触发调价。",
}


def build(ops: pd.DataFrame, core: pd.DataFrame, product_detail: pd.DataFrame, n_samples: int = None):
    n_samples = n_samples or config.SFT_SAMPLES
    rng = np.random.default_rng(config.SEED + 303)
    base_ids = set(ops["base_product_id"])
    pmeta = product_detail[product_detail["product_id"].isin(base_ids)].set_index("product_id").to_dict("index")
    core = core.set_index("poi_id")
    ops = ops.to_dict("records")
    quota_left = {a: int(n_samples * q) for a, q in QUOTA.items()}
    quota_left["keep_price"] += n_samples - sum(quota_left.values())
    writer = SftWriter(TASK)
    tries = 0
    while writer.n < n_samples:
        tries += 1
        r = ops[rng.integers(len(ops))]
        prod = pmeta[r["base_product_id"]]
        k = int(rng.integers(0, 4))
        forecast = int(round(r["visitors"] * rng.lognormal(0, 0.08) / 10) * 10)
        if forecast <= 0:
            continue
        # 预售累计曲线（D-7/D-3/D-1/D0 线性插值）
        pts = {7: r["booked_by_d7"], 3: r["booked_by_d3"], 1: r["booked_by_d1"], 0: r["online_bookings"]}

        def cum(lead):
            if lead in pts:
                return pts[lead]
            if lead == 2:
                return (pts[3] + pts[1]) / 2
            return pts[3] + (pts[7] - pts[3]) * (lead - 3) / 4
        yday = int(round(cum(k + 1)))
        today = int(round((cum(k) - cum(k + 1)) * rng.uniform(0.3, 0.9)))
        inv = int(round(forecast * rng.uniform(0.75, 2.6) / 10) * 10)
        inv = max(inv, yday + today + 10)
        price = float(r["executed_price"])
        f = dict(yday=yday, today=max(today, 0), inv=inv, forecast=forecast, k=k,
                 is_holiday=r["day_type"] in ("法定节假日", "周末"), season=r["season_label"],
                 price=price, premium=float(prod["premium_coef"]), discount=float(prod["discount_coef"]),
                 ceiling=float(prod["ceiling_price"]), floor=float(prod["floor_price"]),
                 comp=float(r["competitor_avg_price"]))
        if not (f["floor"] <= price <= f["ceiling"]):
            continue
        d = decide(f)
        if quota_left[d["action"]] <= 0:
            continue
        quota_left[d["action"]] -= 1

        user_obj = {
            "目标日期": r["date"],
            "距离目标日天数": k,
            "产品信息": {"名称": prod["product_name"], "景区": r["poi_name"], "城市": r["city"], "类别": r["scenic_category"]},
            "预订数据": {"今日实时预订量": f["today"], "昨日累计预订量": yday, "总库存": inv},
            "当日预测客流量": forecast,
            "外部时空特征": {"是否节假日": bool(f["is_holiday"]), "天气预报": r["weather"], "当前季节": r["season_label"]},
            "竞品均价": num(f["comp"]),
            "定价规则": {"当前执行价": num(price), "最高限价": num(f["ceiling"]), "最低保底价": num(f["floor"]),
                     "溢价系数": f["premium"], "折扣系数": f["discount"]},
        }
        hol = "节假日（含周末）" if f["is_holiday"] else "非节假日"
        th = [
            f"1. 读取外部时空特征：目标日期{r['date']}，距今{k}天，{hol}，天气{r['weather']}，季节标签为{r['season_label']}；"
            f"{'属于强需求场景' if f['is_holiday'] or any(w in r['season_label'] for w in PEAK_WORDS) else '属于常规需求场景'}。",
            "2. 评估预订数据与预测客流：",
            f"   - 已售：昨日累计{yday} + 今日实时{f['today']} = {d['sold']}张；售出率：{d['sold']}/{inv} = {pct(d['st'])}。",
            f"   - 需求比：预测客流{forecast}/总库存{inv} = {d['dr']:.2f}。",
            f"   - 进度指数：{d['sold']}/({forecast}×{pct(d['pace_std'], 0)}) = {d['pi']:.2f}（{d['kind']}日距目标{k}天的常规进度为{pct(d['pace_std'], 0)}）。",
        ]
        why = {
            "R1": f"售出率{pct(d['st'])}≥85%且需求比{d['dr']:.2f}≥0.95，库存告急，命中R1 {RULE_ID['R1']}。",
            "R2": f"未达R1；需求比{d['dr']:.2f}≥1.0且进度指数{d['pi']:.2f}≥1.0，需求超过供给，命中R2 {RULE_ID['R2']}。",
            "R3": f"未达R1/R2；进度指数{d['pi']:.2f}≥1.3且需求比{d['dr']:.2f}≥0.8，预订明显快于常规，命中R3 {RULE_ID['R3']}。",
            "R4": f"未触发上调规则；距目标日{k}天≤1、需求比{d['dr']:.2f}<0.5且售出率{pct(d['st'])}<30%，临期滞销，命中R4 {RULE_ID['R4']}。",
            "R5": f"未触发上调规则与R4；进度指数{d['pi']:.2f}<0.7且需求比{d['dr']:.2f}<0.8，预订偏慢，命中R5 {RULE_ID['R5']}。",
            "R6": f"售出率{pct(d['st'])}、需求比{d['dr']:.2f}、进度指数{d['pi']:.2f}均未触发R1~R5阈值，命中R6 {RULE_ID['R6']}，维持现价。",
        }[d["rule"]]
        th.append(f"3. 确定定价策略：{why}")
        if d["rule"] != "R6":
            th.append(f"4. 套用定价公式：{d['formula']} = {d['raw']:.2f}元，四舍五入为{round_half_up(d['raw'])}元。")
        else:
            th.append(f"4. 套用定价公式：维持当前执行价{fmt_money(price)}元。")
        chk = []
        comp_cap = f["comp"] * 1.3
        comp_note = [n for n in d["notes"] if n[0] == "comp"]
        if comp_note:
            chk.append(f"   - 竞品约束：{comp_note[0][1]}元>竞品均价{fmt_money(f['comp'])}×1.3={comp_cap:.1f}元，调整为max({fmt_money(price)}, {round_half_up(comp_cap)})={comp_note[0][2]}元。")
        elif d["action"] == "raise_price" or round_half_up(d["raw"]) > price:
            chk.append(f"   - 竞品约束：{round_half_up(d['raw'])}元≤竞品均价×1.3={comp_cap:.1f}元，合规。")
        else:
            chk.append("   - 竞品约束：未上调，不适用。")
        ceil_note = [n for n in d["notes"] if n[0] == "ceiling"]
        floor_note = [n for n in d["notes"] if n[0] == "floor"]
        cand = d["new"] if not (ceil_note or floor_note) else (ceil_note or floor_note)[0][1]
        if ceil_note:
            chk.append(f"   - 检查最高限价：{ceil_note[0][1]}元>最高限价{fmt_money(f['ceiling'])}元，截断为{ceil_note[0][2]}元。")
        else:
            chk.append(f"   - 检查最高限价：{cand}元≤最高限价{fmt_money(f['ceiling'])}元，合规。")
        if floor_note:
            chk.append(f"   - 检查最低保底价：{floor_note[0][1]}元<最低保底价{fmt_money(f['floor'])}元，抬升为{floor_note[0][2]}元。")
        else:
            chk.append(f"   - 检查最低保底价：{d['new']}元≥最低保底价{fmt_money(f['floor'])}元，合规。")
        th.append("5. 合规性自检：")
        th += chk
        ratio = d["new"] / price
        th.append(f"6. 收益测算：{'节假日/旺季' if d['e'] == 0.6 else '非旺季'}弹性取{d['e']}；剩余库存{d['remain_inv']}张，"
                  f"剩余需求max({forecast}-{d['sold']},0)={round(d['d_rem'])}；调价后需求={round(d['d_rem'])}×({d['new']}/{fmt_money(price)})^(-{d['e']})={round(d['d_new'])}；"
                  f"维持原价新增收入=min({round(d['d_rem'])},{d['remain_inv']})×{fmt_money(price)}={round(d['rev_old'])}元，"
                  f"调价后新增收入=min({round(d['d_new'])},{d['remain_inv']})×{d['new']}={round(d['rev_new'])}元。")
        delta = d["rev_new"] - d["rev_old"]
        act_cn = {"raise_price": "上调至", "lower_price": "下调至", "keep_price": "维持"}[d["action"]]
        th.append(f"7. 确定最终建议：建议将{r['date'][5:7].lstrip('0')}月{r['date'][8:].lstrip('0')}日的票价{act_cn}{d['new']}元"
                  f"（较现价{signed_pct(ratio - 1)}），预计新增收入变化{'+' if delta >= 0 else ''}{round(delta)}元。")

        reason_core = {
            "R1": f"售出率已达{pct(d['st'])}，预测客流{forecast}人接近或超过总库存{inv}，库存告急",
            "R2": f"预测客流{forecast}人超过总库存{inv}，且预订进度指数{d['pi']:.2f}高于常规",
            "R3": f"预订进度指数{d['pi']:.2f}，明显快于常规节奏",
            "R4": f"距目标日仅{k}天，售出率{pct(d['st'])}，需求比{d['dr']:.2f}，存在临期滞销风险",
            "R5": f"预订进度指数{d['pi']:.2f}，慢于常规节奏，需求比{d['dr']:.2f}",
            "R6": f"售出率{pct(d['st'])}、需求比{d['dr']:.2f}、进度指数{d['pi']:.2f}处于正常区间",
        }[d["rule"]]
        ctx = f"{r['season_label']}{'、' + r['weather'] if r['weather'] else ''}"
        limit = "，已按约束截断" if d["notes"] else f"，在{fmt_money(f['floor'])}~{fmt_money(f['ceiling'])}元限价区间内"
        reason = f"{ctx}；{reason_core}。{act_cn}{d['new']}元{limit}。"
        answer = {
            "action": d["action"], "suggested_price": d["new"], "confidence": d["conf"], "reason": reason,
            "rule_id": RULE_ID[d["rule"]],
            "current_price": num(price), "price_change_pct": signed_pct(ratio - 1),
            "compliance_check": {"within_price_limit": True, "competitor_guard": "触发" if comp_note else "通过"},
            "expected_revenue_change": round(delta),
            "channel_strategy": CHANNEL_STRATEGY[d["rule"]] if d["action"] != "keep_price" or d["rule"] == "R6"
            else "规则建议价受约束后与现价一致，各渠道维持现价。",
        }
        sid = f"{TASK}-{writer.n + 1:07d}"
        meta = {"poi_id": r["poi_id"], "date": r["date"], "rule": RULE_ID[d["rule"]], "action": d["action"],
                "suggested_price": d["new"], "current_price": price, "actual_visitors": int(r["visitors"]),
                "source": "rule_engine"}
        writer.add(sid, make_sample(SYSTEM, user_obj, th, dumps(answer)), meta)
    info = writer.close()
    info["stats"] = {"sampling_tries": tries}
    return info
