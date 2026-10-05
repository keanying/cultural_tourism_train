"""训练集⑤：经营洞察模型（business_insight）

任务：给定景区某月与对比期（环比上月 / 同比去年同月）的经营指标、日历与天气结构、分渠道售票，
输出“数据解读 + 归因分析 + 经营建议”。
归因方法（可复算、加和闭合）：
  收入：ΔR = ΔV×ARPU0（客流贡献）+ V1×Δ人均门票（票价/结构贡献）+ V1×Δ人均二消（二次消费贡献）
  客流：ln(V1/V0) = ln(日历效应) + ln(天气效应) + ln(活动效应) + 残差；各项按对数占比分摊 ΔV，合计严格等于 ΔV
  渠道：各渠道售票量差额，合计等于客流差额（渠道数据与日度客流严格对齐）
"""
import math

import numpy as np
import pandas as pd

from .. import config
from .common import SftWriter, dumps, make_sample, pct, signed_pct
from .forecast import DAY_COEF, EVENT_COEF, day_label, wcoef

TASK = "business_insight"
BAD = {"中雨", "大雨", "雷阵雨", "中雪"}

SYSTEM = (
    "你是景区经营分析专家。你的任务是基于【本期与对比期经营指标】【日历与天气结构】【分渠道售票】数据，"
    "准确解读经营变化并给出合理归因与可执行建议。必须遵守：\n"
    "1. 所有变化率=(本期-对比期)÷对比期，数字必须由输入数据计算得出，严禁编造；\n"
    "2. 收入归因：ΔR=ΔV×对比期人均消费（客流贡献）+本期客流×Δ人均门票收入（票价与结构贡献）+本期客流×Δ人均二次消费（二消贡献），三项之和等于收入差额；\n"
    "3. 客流归因：日历效应=本期日期系数之和÷对比期日期系数之和，天气效应=本期平均天气系数÷对比期平均天气系数，"
    "活动效应=本期平均活动系数÷对比期平均活动系数（活动日1.3，否则1.0），残差=ln(V1/V0)-各项对数之和；"
    "各因素对客流差额的贡献=ΔV×该项对数÷ln(V1/V0)；环比时残差解释为“季节性及其他因素”，同比时解释为“内生增长（市场需求/营销/口碑）”；\n"
    "4. 日期系数：工作日1.00、周五1.15、周六1.85、周日1.55、调休工作日0.95、元旦1.8、春节2.3、清明/端午/中秋2.0、劳动节2.8、国庆3.2；"
    "天气系数：晴1.00、多云1.02、阴0.94、雾霾0.88、晴热高温0.86、小雨0.82、雷阵雨0.78、中雨0.66、大雨0.48、小雪0.80、中雪0.62（室内景区影响减半）；\n"
    "5. 建议必须对应归因结论，具体可执行。\n"
    "输出格式：<thought>内给出逐步计算，<answer>内输出JSON。"
)

QUESTIONS = [
    "请分析{m}{name}经营数据的{cmp}变化，找出主要原因并给出经营建议。",
    "{m}{name}的收入{cmp}{dir}，请做归因分析并给出改进建议。",
    "请解读{name}{m}的经营表现（{cmp}），指出最需要关注的问题。",
    "{name}{m}客流{cmp}{vdir}，请拆解原因并说明下月应如何应对。",
]


def _share(v, total):
    if not total or round(v) == 0:
        return "0.0%"
    return pct(v / total)


def _period_stats(d: pd.DataFrame, indoor: bool):
    dcs = [DAY_COEF[day_label(r.day_type, r.holiday_name, r.weekday)] for r in d.itertuples(index=False)]
    wcs = [wcoef(w, indoor) for w in d["weather"]]
    ecs = [EVENT_COEF if e else 1.0 for e in d["event_name"]]
    V = int(d["visitors"].sum())
    return {
        "days": len(d), "V": V,
        "ticket": float(d["ticket_revenue"].sum()), "sec": float(d["secondary_revenue"].sum()),
        "R": float(d["total_revenue"].sum()),
        "online": float(d["online_bookings"].sum()) / max(V, 1),
        "refund": int(d["refund_orders"].sum()), "sat": float(d["satisfaction_score"].mean()),
        "complaints": int(d["complaint_count"].sum()), "mkt": float(d["marketing_spend"].sum()),
        "price": float(d["executed_price"].mean()), "max_load": float(d["load_rate"].max()),
        "hol": int((d["day_type"] == "法定节假日").sum()), "wkd": int((d["day_type"] == "周末").sum()),
        "bad": int(d["weather"].isin(BAD).sum()), "evt": int((d["event_name"] != "").sum()),
        "sum_dc": round(sum(dcs), 2), "avg_wc": round(float(np.mean(wcs)), 4), "avg_ec": round(float(np.mean(ecs)), 4),
    }


def build(ops: pd.DataFrame, channels: pd.DataFrame, n_samples: int = None):
    n_samples = n_samples or config.SFT_SAMPLES
    rng = np.random.default_rng(config.SEED + 505)
    ops = ops.copy()
    ops["month"] = ops["date"].str[:7]
    by = {k: g for k, g in ops.groupby(["poi_id", "month"])}
    ch_m = {}
    for (p_, m_, c_), v_ in channels.groupby(["poi_id", "stat_month", "channel"])["tickets_sold"].sum().items():
        ch_m.setdefault((p_, m_), {})[c_] = int(v_)
    stat_cache = {}

    def stats(pid_, m_, indoor_):
        if (pid_, m_) not in stat_cache:
            stat_cache[(pid_, m_)] = _period_stats(by[(pid_, m_)], indoor_)
        return stat_cache[(pid_, m_)]
    months = sorted(ops["month"].unique())
    pois = ops["poi_id"].unique()
    writer = SftWriter(TASK)
    while writer.n < n_samples:
        pid = pois[rng.integers(len(pois))]
        mi = int(rng.integers(1, len(months)))
        yoy = mi >= 12 and rng.random() < 0.45
        m1, m0 = months[mi], months[mi - 12] if yoy else months[mi - 1]
        d1, d0 = by[(pid, m1)], by[(pid, m0)]
        indoor = bool(d1["is_indoor"].iloc[0])
        name = d1["poi_name"].iloc[0]
        a, b = stats(pid, m1, indoor), stats(pid, m0, indoor)
        cmp = "同比" if yoy else "环比"
        cmp_label = "去年同月" if yoy else "上月"

        def kpi(s):
            return {"接待人次": s["V"], "门票收入": round(s["ticket"]), "二次消费收入": round(s["sec"]),
                    "总收入": round(s["ticket"]) + round(s["sec"]),
                    "人均消费": round((round(s["ticket"]) + round(s["sec"])) / max(s["V"], 1), 2), "平均执行票价": round(s["price"], 2),
                    "线上预约占比": pct(s["online"]), "退款单量": s["refund"], "满意度均分": round(s["sat"], 2),
                    "投诉量": s["complaints"], "营销费用": round(s["mkt"]), "最高承载率": pct(s["max_load"])}

        def cal(s):
            return {"天数": s["days"], "法定节假日天数": s["hol"], "周末天数": s["wkd"], "中雨及以上天数": s["bad"],
                    "节庆活动天数": s["evt"], "日期系数之和": s["sum_dc"], "平均天气系数": s["avg_wc"],
                    "平均活动系数": s["avg_ec"]}

        c1, c0 = ch_m.get((pid, m1), {}), ch_m.get((pid, m0), {})
        chans = sorted(set(c1) | set(c0))
        ch_rows = []
        for c in chans:
            t1 = c1.get(c, 0)
            t0 = c0.get(c, 0)
            ch_rows.append({"渠道": c, "本期售票": t1, "对比期售票": t0})
        dirR = "增长" if a["R"] >= b["R"] else "下滑"
        dirV = "上升" if a["V"] >= b["V"] else "下降"
        q = QUESTIONS[rng.integers(len(QUESTIONS))].format(m=f"{m1[:4]}年{int(m1[5:])}月", name=name, cmp=cmp,
                                                             dir=dirR, vdir=dirV)
        user_obj = {
            "分析问题": q,
            "景区信息": {"名称": name, "城市": d1["city"].iloc[0], "类别": d1["scenic_category"].iloc[0], "是否室内": indoor,
                     "日最大承载量": int(d1["daily_capacity"].iloc[0])},
            "对比口径": f"{cmp}（本期{m1}，对比期{m0}）",
            "本期经营指标": kpi(a), "对比期经营指标": kpi(b),
            "本期日历与天气": cal(a), "对比期日历与天气": cal(b),
            "分渠道售票": ch_rows,
        }

        # ---------- 计算 ----------
        V1, V0 = a["V"], b["V"]
        R1 = round(a["ticket"]) + round(a["sec"])
        R0 = round(b["ticket"]) + round(b["sec"])
        dV, dR = V1 - V0, R1 - R0
        arpu0 = R0 / max(V0, 1)
        tpc1, tpc0 = round(a["ticket"]) / max(V1, 1), round(b["ticket"]) / max(V0, 1)
        spc1, spc0 = round(a["sec"]) / max(V1, 1), round(b["sec"]) / max(V0, 1)
        c_v = dV * arpu0
        c_t = V1 * (tpc1 - tpc0)
        c_s = V1 * (spc1 - spc0)
        L = math.log(V1 / V0) if V0 > 0 and V1 > 0 else 0.0
        l_cal = math.log(a["sum_dc"] / b["sum_dc"])
        l_w = math.log(a["avg_wc"] / b["avg_wc"])
        l_e = math.log(a["avg_ec"] / b["avg_ec"])
        l_r = L - l_cal - l_w - l_e
        resid_name = "内生增长（市场需求/营销/口碑）" if yoy else "季节性及其他因素"
        factors = [("日历效应", l_cal), ("天气效应", l_w), ("活动效应", l_e), (resid_name, l_r)]
        if abs(L) >= 0.005:
            v_contrib = [(n, dV * l / L) for n, l in factors]
        else:  # 客流基本持平：对数比过小时分摊不稳定，差额全部计入残差项
            v_contrib = [(n, 0.0) for n, _ in factors[:-1]] + [(resid_name, float(dV))]

        th = [f"1. 明确分析口径：{name}，本期{m1}，对比期{m0}（{cmp}）；{'室内景区，天气影响减半' if indoor else '室外景区'}。"]
        rows_km = []
        for label, k1, k0, money in [("接待人次", V1, V0, False), ("总收入", R1, R0, True),
                                     ("门票收入", round(a["ticket"]), round(b["ticket"]), True),
                                     ("二次消费收入", round(a["sec"]), round(b["sec"]), True),
                                     ("人均消费", round(R1 / max(V1, 1), 2), round(arpu0, 2), True),
                                     ("满意度均分", round(a["sat"], 2), round(b["sat"], 2), False),
                                     ("投诉量", a["complaints"], b["complaints"], False),
                                     ("退款单量", a["refund"], b["refund"], False)]:
            chg = (k1 - k0) / k0 if k0 else 0.0
            rows_km.append({"metric": label, "current": k1, "previous": k0, "change": signed_pct(chg)})
        th.append("2. 核心指标变化：" + "；".join(f"{r['metric']} {r['current']} vs {r['previous']}（{r['change']}）" for r in rows_km) + "。")
        th.append(f"3. 收入拆解：ΔR={R1}-{R0}={dR}元。客流贡献=ΔV×对比期人均={dV}×{arpu0:.2f}={round(c_v)}元；"
                  f"票价与结构贡献=V1×Δ人均门票={V1}×({tpc1:.2f}-{tpc0:.2f})={round(c_t)}元；"
                  f"二消贡献=V1×Δ人均二消={V1}×({spc1:.2f}-{spc0:.2f})={round(c_s)}元；合计{round(c_v + c_t + c_s)}元，与ΔR一致。")
        th.append(f"4. 客流归因：ln(V1/V0)=ln({V1}/{V0})={L:.4f}。日历效应={a['sum_dc']}/{b['sum_dc']}，对数{l_cal:.4f}"
                  f"（法定节假日{a['hol']}vs{b['hol']}天，周末{a['wkd']}vs{b['wkd']}天）；天气效应={a['avg_wc']}/{b['avg_wc']}，对数{l_w:.4f}"
                  f"（中雨及以上{a['bad']}vs{b['bad']}天）；活动效应={a['avg_ec']}/{b['avg_ec']}，对数{l_e:.4f}；残差{l_r:.4f}。")
        if abs(L) >= 0.005:
            th.append("   贡献分摊：" + "；".join(f"{n}{round(v):+d}人" for n, v in v_contrib) + f"，合计{dV:+d}人。")
        else:
            th.append(f"   客流基本持平（|ln比|<0.005），对数分摊不稳定，差额{dV:+d}人全部计入{resid_name}。")
        ch_sorted = sorted(ch_rows, key=lambda r: -abs(r["本期售票"] - r["对比期售票"]))
        th.append("5. 渠道结构：" + "；".join(f"{r['渠道']}{r['本期售票'] - r['对比期售票']:+d}张" for r in ch_sorted[:4])
                  + f"；渠道合计变化{sum(r['本期售票'] - r['对比期售票'] for r in ch_rows):+d}张，与客流差额一致。")

        # ---------- 风险与建议 ----------
        recs, risks = [], []
        thr = 0.03 * V0
        vc = dict(v_contrib)
        if vc["天气效应"] < -thr:
            risks.append(f"恶劣天气拖累客流约{-round(vc['天气效应'])}人")
            recs.append("建立雨天预案：增加室内/风雨连廊动线与雨具租赁，雨天定向发放次日返场券，对冲天气损失。")
        if vc["日历效应"] < -thr:
            risks.append(f"假期/周末天数减少导致客流减少约{-round(vc['日历效应'])}人")
            recs.append("平日引流：针对周边客群推出工作日特惠与研学/银发团队产品，平滑周内客流。")
        if vc[resid_name] < -thr:
            risks.append(f"{resid_name}拖累客流约{-round(vc[resid_name])}人")
            recs.append("加强需求端营销：在增量最大的渠道追加投放，联合OTA做目的地专题，提升会员复购。" if yoy
                        else "提前布局淡旺季切换：根据季节性走势调整营销节奏与产品组合。")
        if spc0 > 0 and (spc1 - spc0) / spc0 < -0.05:
            risks.append(f"人均二次消费下降{pct(abs((spc1 - spc0) / spc0))}")
            recs.append("提升二次消费：优化餐饮与文创点位，上线“门票+餐饮/项目”组合套餐，在高峰时段增设流动售卖。")
        if tpc0 > 0 and (tpc1 - tpc0) / tpc0 < -0.05:
            risks.append(f"人均门票收入下降{pct(abs((tpc1 - tpc0) / tpc0))}")
            recs.append("修复票价结构：检查低价渠道与优惠券占比，控制折扣深度，引导购买高价值组合票。")
        if a["sat"] - b["sat"] <= -0.05 or (b["complaints"] and (a["complaints"] - b["complaints"]) / b["complaints"] > 0.2):
            risks.append(f"体验指标走弱（满意度{round(a['sat'], 2)} vs {round(b['sat'], 2)}，投诉{a['complaints']} vs {b['complaints']}）")
            if a["max_load"] >= 0.8:
                recs.append(f"改善体验：最高承载率{pct(a['max_load'])}，高峰日实施分时预约与限流，增加引导与保洁人手。")
            else:
                recs.append("改善体验：排查排队、讲解、卫生等差评高发环节并逐项整改，建立游客反馈闭环。")
        if b["refund"] and (a["refund"] - b["refund"]) / b["refund"] > 0.3:
            risks.append(f"退款单量上升{pct((a['refund'] - b['refund']) / b['refund'])}")
            recs.append("降低退款：对恶劣天气日提前推送改期通知，提供免费改期替代退款。")
        if ch_rows:
            worst = min(ch_rows, key=lambda r: r["本期售票"] - r["对比期售票"])
            best = max(ch_rows, key=lambda r: r["本期售票"] - r["对比期售票"])
            if worst["本期售票"] - worst["对比期售票"] < 0 and worst["对比期售票"] > 0:
                drop = (worst["本期售票"] - worst["对比期售票"]) / worst["对比期售票"]
                if drop < -0.15:
                    risks.append(f"{worst['渠道']}售票下降{pct(abs(drop))}")
                    recs.append(f"排查{worst['渠道']}渠道：核对价格是否倒挂、资源位与库存是否下线，必要时补充专项投放。")
            if best["本期售票"] - best["对比期售票"] > 0:
                recs.append(f"放大增长渠道：{best['渠道']}贡献最大增量（{best['本期售票'] - best['对比期售票']:+d}张），可适度追加预算并复制其内容/活动玩法。")
        if a["max_load"] >= 0.9:
            recs.append(f"最高承载率达{pct(a['max_load'])}，节假日需启动动态定价与限流预案，平衡收益与体验。")
        if not recs:
            recs.append("经营平稳：保持现有渠道与产品节奏，持续监控客流与满意度指标。")
        th.append("6. 风险识别与建议：" + ("；".join(risks) if risks else "无显著风险项") + "。据此给出对应建议。")

        main = sorted(v_contrib, key=lambda x: -abs(x[1]))
        rv = [("客流变化", c_v), ("票价与结构", c_t), ("二次消费", c_s)]
        mainR = max(rv, key=lambda x: abs(x[1]))
        chgR = (R1 - R0) / R0 if R0 else 0
        summary = (f"{m1}{name}总收入{R1}元，{cmp}{signed_pct(chgR)}；接待{V1}人次，{cmp}{signed_pct((V1 - V0) / V0 if V0 else 0)}。"
                   f"收入变化主要来自{mainR[0]}（{round(mainR[1]):+d}元）")
        if abs(L) >= 0.005:
            summary += f"；客流变化中{main[0][0]}影响最大（{round(main[0][1]):+d}人）"
            if len(main) > 1 and abs(main[1][1]) > 0.2 * abs(main[0][1]):
                summary += f"，其次为{main[1][0]}（{round(main[1][1]):+d}人）"
        summary += "。"
        answer = {
            "summary": summary,
            "key_metrics": rows_km,
            "revenue_attribution": [{"factor": n, "impact": round(v), "share": _share(v, dR)} for n, v in rv],
            "visitor_attribution": [{"factor": n, "impact_visitors": round(v), "share": _share(v, dV)} for n, v in v_contrib],
            "channel_changes": [{"channel": r["渠道"], "current": r["本期售票"], "previous": r["对比期售票"],
                                 "change": r["本期售票"] - r["对比期售票"]} for r in ch_sorted[:4]],
            "risks": risks,
            "recommendations": recs[:5],
        }
        sid = f"{TASK}-{writer.n + 1:07d}"
        meta = {"poi_id": pid, "month": m1, "compare_month": m0, "compare": cmp, "delta_revenue": dR, "delta_visitors": dV,
                "source": "rule_engine"}
        writer.add(sid, make_sample(SYSTEM, user_obj, th, dumps(answer)), meta)
    return writer.close()
