"""训练集②：游客人数预测模型（visitor_forecast）

任务：基于近 14 天客流、去年同期季节特征、未来 7 天日历/天气/活动及实时预约量，预测未来 7 天每日客流。
思维链为可复算的“标准化基线 × 季节修正 × 日期/天气/活动系数”结构化预测，再用预约进度信号校准。
系数表写入 system prompt，模型学习的是一套稳定、可解释的推理流程；meta 中保存真实客流用于计算误差。
"""
import datetime as dt

import numpy as np
import pandas as pd

from .. import config
from .common import SftWriter, dumps, make_sample, pct

TASK = "visitor_forecast"

DAY_COEF = {"工作日": 1.00, "周五": 1.15, "周六": 1.85, "周日": 1.55, "调休工作日": 0.95,
            "元旦": 1.8, "春节": 2.3, "清明节": 2.0, "劳动节": 2.8, "端午节": 2.0, "中秋节": 2.0,
            "国庆节": 3.2, "国庆中秋": 3.2}
WEATHER_COEF = {"晴": 1.00, "多云": 1.02, "阴": 0.94, "雾霾": 0.88, "晴热高温": 0.86, "小雨": 0.82,
                "雷阵雨": 0.78, "中雨": 0.66, "大雨": 0.48, "小雪": 0.80, "中雪": 0.62}
EVENT_COEF = 1.3
CURVE = {"普通": {1: 0.72, 2: 0.57, 3: 0.42, 4: 0.36, 5: 0.30, 6: 0.24, 7: 0.18},
         "节假日": {1: 0.86, 2: 0.76, 3: 0.65, 4: 0.59, 5: 0.53, 6: 0.46, 7: 0.40}}
BLEND = {1: 0.6, 2: 0.4, 3: 0.4, 4: 0.2, 5: 0.2, 6: 0.2, 7: 0.2}

SYSTEM = (
    "你是景区客流预测分析师。你的任务是基于【景区信息】【近14天历史客流】【去年同期特征】【未来7天外部特征与预约量】，"
    "预测未来7天每日入园人数。必须严格按以下方法推理并给出可复算的数字：\n"
    "1. 日期系数：工作日(周一至周四)1.00，周五1.15，周六1.85，周日1.55，调休工作日0.95；法定节假日按节日取值："
    "元旦1.8、春节2.3、清明节2.0、劳动节2.8、端午节2.0、中秋节2.0、国庆节/国庆中秋3.2；\n"
    "2. 天气系数：晴1.00、多云1.02、阴0.94、雾霾0.88、晴热高温0.86、小雨0.82、雷阵雨0.78、中雨0.66、大雨0.48、小雪0.80、中雪0.62；"
    "室内景区天气影响减半，即 系数=1-(1-原系数)/2；节庆活动日系数1.3；\n"
    "3. 标准化基线=近14天“实际客流÷(日期系数×天气系数×活动系数)”的平均值；季节修正=去年同期标准化日均÷去年前14日标准化日均"
    "（限制在0.6~1.8，无去年数据取1.0）；模型预测=基线×季节修正×当日各系数；\n"
    "4. 预约校准：提前N天累计线上预约占最终线上预约的比例，普通日 N=1~7 依次为0.72/0.57/0.42/0.36/0.30/0.24/0.18，"
    "节假日为0.86/0.76/0.65/0.59/0.53/0.46/0.40；预约折算客流=已预约量÷进度比例÷历史线上占比；"
    "最终预测=预约权重×预约折算+(1-预约权重)×模型预测，预约权重：提前1天0.6、2~3天0.4、4~7天0.2；"
    "结果四舍五入到十位且不超过日最大承载量；\n"
    "5. 预测区间=最终预测×(1±(8%+2%×提前天数))，上限不超过承载量；承载率≥85%的日期列入承载预警。\n"
    "输出格式：<thought>内给出逐步计算过程，<answer>内输出JSON。"
)


def day_label(day_type, holiday, weekday):
    if day_type == "法定节假日":
        return holiday
    if day_type == "调休工作日":
        return "调休工作日"
    if weekday in ("周五", "周六", "周日"):
        return weekday
    return "工作日"


def wcoef(cond, indoor):
    c = WEATHER_COEF[cond]
    return round(1 - (1 - c) / 2, 3) if indoor else c


def _norm_series(df, indoor):
    coef = []
    for r in df:
        dc = DAY_COEF[day_label(r.day_type, r.holiday_name, r.weekday)]
        wc = wcoef(r.weather, indoor)
        ec = EVENT_COEF if r.event_name else 1.0
        coef.append((dc, wc, ec))
    return coef


def _interp_booked(row, lead):
    """把 D-7/D-3/D-1 三个快照与最终线上预约线性插值到任意提前天数。"""
    pts = {7: row.booked_by_d7, 3: row.booked_by_d3, 1: row.booked_by_d1, 0: row.online_bookings}
    if lead in pts:
        return int(pts[lead])
    if 3 < lead < 7:
        a, b = pts[7], pts[3]
        return int(round(b + (a - b) * (lead - 3) / 4))
    a, b = pts[3], pts[1]
    return int(round(b + (a - b) * (lead - 1) / 2))


def build(ops: pd.DataFrame, n_samples: int = None):
    n_samples = n_samples or config.SFT_SAMPLES
    rng = np.random.default_rng(config.SEED + 202)
    ops = ops.sort_values(["poi_id", "date"]).reset_index(drop=True)
    by_poi = {k: list(g.itertuples(index=False)) for k, g in ops.groupby("poi_id")}
    poi_ids = list(by_poi)
    nd = len(next(iter(by_poi.values())))
    writer = SftWriter(TASK)
    errs = []
    while writer.n < n_samples:
        pid = poi_ids[rng.integers(len(poi_ids))]
        g = by_poi[pid]
        t0 = int(rng.integers(14, nd - 7))
        hist = g[t0 - 14:t0]
        fut = g[t0:t0 + 7]
        p = g[t0]
        indoor = bool(p.is_indoor)
        cap = int(p.daily_capacity)

        hcoef = _norm_series(hist, indoor)
        hnorm = [r.visitors / (dc * wc * ec) for r, (dc, wc, ec) in zip(hist, hcoef)]
        B = float(np.mean(hnorm))
        online_ratio = sum(r.online_bookings for r in hist) / max(sum(r.visitors for r in hist), 1)

        # 去年同期（对齐星期：-364 天）
        ly = None
        if t0 - 364 - 14 >= 0:
            ly_t = g[t0 - 364:t0 - 364 + 7]
            ly_p = g[t0 - 364 - 14:t0 - 364]
            a = np.mean([r.visitors / (dc * wc * ec) for r, (dc, wc, ec) in zip(ly_t, _norm_series(ly_t, indoor))])
            b = np.mean([r.visitors / (dc * wc * ec) for r, (dc, wc, ec) in zip(ly_p, _norm_series(ly_p, indoor))])
            ly = (round(float(a)), round(float(b)))
        S = round(float(np.clip(ly[0] / ly[1], 0.6, 1.8)), 3) if ly else 1.0

        fcoef = _norm_series(fut, indoor)
        user_obj = {
            "景区信息": {"名称": p.poi_name, "城市": p.city, "类别": p.scenic_category,
                     "是否室内": indoor, "日最大承载量": cap},
            "预测发布日期": (dt.date.fromisoformat(p.date) - dt.timedelta(days=1)).isoformat(),
            "近14天历史客流": [
                {"日期": r.date, "星期": r.weekday, "日期类型": day_label(r.day_type, r.holiday_name, r.weekday),
                 "天气": r.weather, "节庆活动": r.event_name or "无", "实际客流": int(r.visitors), "线上预约量": int(r.online_bookings)}
                for r in hist],
            "去年同期特征": ({"去年同期7日标准化日均": ly[0], "去年前14日标准化日均": ly[1]} if ly else None),
            "未来7天特征": [],
        }
        th = [f"1. 读取景区与预测窗口：{p.poi_name}（{p.scenic_category}，{'室内，天气影响减半' if indoor else '室外'}），"
              f"日最大承载量{cap}人；预测区间{fut[0].date}至{fut[-1].date}。"]
        hol = sorted({r.holiday_name for r in fut if r.holiday_name})
        if hol:
            th[-1] += f"窗口内含法定节假日：{'、'.join(hol)}。"
        parts = [f"{r.date[5:]} {int(r.visitors)}/({dc}×{wc}{'×1.3' if ec != 1 else ''})={round(v)}"
                 for r, (dc, wc, ec), v in zip(hist, hcoef, hnorm)]
        th.append("2. 计算标准化基线：" + "；".join(parts) + f"。平均得基线B={round(B)}人；历史线上预约占比R={online_ratio:.3f}。")
        if ly:
            th.append(f"3. 季节修正：去年同期标准化日均{ly[0]}÷去年前14日标准化日均{ly[1]}={ly[0] / ly[1]:.3f}，"
                      f"{'超出范围截断为' if S != round(ly[0] / ly[1], 3) else '取'}S={S}。")
        else:
            th.append("3. 季节修正：无去年同期数据，S=1.0。")
        th.append("4. 逐日计算模型预测与预约校准：")
        preds = []
        drivers = []
        hol_days, evt_days = {}, {}
        for j, (r, (dc, wc, ec)) in enumerate(zip(fut, fcoef)):
            lead = j + 1
            label = day_label(r.day_type, r.holiday_name, r.weekday)
            kind = "节假日" if r.day_type == "法定节假日" else "普通"
            booked = _interp_booked(r, lead)
            curve = CURVE[kind][lead]
            fm = B * S * dc * wc * ec
            fb = booked / curve / max(online_ratio, 1e-6)
            w = BLEND[lead]
            f = w * fb + (1 - w) * fm
            final = int(min(cap, round(f / 10) * 10))
            band = 0.08 + 0.02 * lead
            lo, hi = int(round(final * (1 - band))), int(min(cap, round(final * (1 + band))))
            preds.append({"date": r.date, "visitors": final, "lower": lo, "upper": hi, "load_rate": pct(final / cap)})
            errs.append(abs(final - r.visitors) / max(r.visitors, 1))
            user_obj["未来7天特征"].append({"日期": r.date, "星期": r.weekday, "日期类型": label, "天气预报": r.weather,
                                       "最高气温": int(r.temp_high), "节庆活动": r.event_name or "无",
                                       "提前天数": lead, "当前已预约量": booked})
            capped = "，触及承载上限" if final == cap and f > cap else ""
            th.append(f"   - {r.date}（{label}，{r.weather}{'，' + r.event_name if r.event_name else ''}）：模型预测={round(B)}×{S}×{dc}×{wc}"
                      f"{'×1.3' if ec != 1 else ''}={round(fm)}；预约折算={booked}÷{curve}÷{online_ratio:.3f}={round(fb)}；"
                      f"融合={w}×{round(fb)}+{round(1 - w, 1)}×{round(fm)}={round(f)}，取整{final}{capped}。")
            if r.day_type == "法定节假日":
                hol_days.setdefault((r.holiday_name, dc), []).append(r.date)
            if WEATHER_COEF[r.weather] <= 0.7:
                drivers.append(f"{r.date}预报{r.weather}，天气系数{wc}")
            if r.event_name:
                evt_days.setdefault(r.event_name, []).append(r.date)
            if lead <= 2 and fm > 0 and abs(fb / fm - 1) >= 0.15:
                drivers.append(f"{r.date}预约进度{'快于' if fb > fm else '慢于'}常规（预约折算{round(fb)}，模型预测{round(fm)}）")
        def span(ds):
            return ds[0] if len(ds) == 1 else f"{ds[0]}至{ds[-1]}"
        drivers = ([f"{span(ds)}为{h}，日期系数{c}" for (h, c), ds in hol_days.items()]
                   + [f"{span(ds)}有{e}活动，活动系数1.3" for e, ds in evt_days.items()] + drivers)
        if abs(S - 1) >= 0.15:
            drivers.append(f"季节修正系数{S}，{'进入旺季' if S > 1 else '进入淡季'}")
        if not drivers:
            drivers.append("窗口内无节假日与极端天气，客流以常规周内波动为主")
        alerts = [x["date"] for x in preds if x["visitors"] / cap >= 0.85]
        total = sum(x["visitors"] for x in preds)
        peak = max(preds, key=lambda x: x["visitors"])
        th.append(f"5. 承载校验与区间：7日合计{total}人，峰值{peak['date']}（{peak['visitors']}人，承载率{peak['load_rate']}）；"
                  + (f"承载率≥85%的日期：{'、'.join(alerts)}，需启动限流预案。" if alerts else "无日期承载率≥85%。")
                  + "区间按±(8%+2%×提前天数)计算。")
        answer = {"predictions": preds, "total_7d": total, "peak_date": peak["date"], "capacity_alerts": alerts,
                  "key_drivers": drivers[:5]}
        sid = f"{TASK}-{writer.n + 1:07d}"
        meta = {"poi_id": pid, "start_date": fut[0].date, "actual": [int(r.visitors) for r in fut],
                "pred": [x["visitors"] for x in preds], "source": "rule_engine"}
        writer.add(sid, make_sample(SYSTEM, user_obj, th, dumps(answer)), meta)
    info = writer.close()
    info["stats"] = {"teacher_mape_vs_actual": round(float(np.mean(errs)), 4)}
    return info
