"""辅助数据集：景区日度客流与运营数据（scenic_daily_ops）。

客流预测、动态定价、经营洞察三个模型都需要“景区 × 日期”级别的连续时间序列，
5 个明细数据集中的订单只是游客样本，无法支撑日度客流，因此单独生成该辅助表。

客流生成模型（乘法结构，参数按景区随机化）：
  期望客流 = 基线 × 月度季节系数(类别/气候) × 日期类型系数 × 节假日系数 × 天气系数
            × 年度趋势 × 节庆活动系数 × 价格弹性项
  实际客流 = min(承载量, 期望客流 × 对数正态噪声)
"""
import datetime as dt

import numpy as np
import pandas as pd

from . import config
from .calendar_cn import (HOLIDAYS, WEEKDAY_CN, all_dates, day_type, school_vacation, season_label,
                          weather, weather_factor)
from .geo import CLIMATE

MONTH_CURVES = {
    "outdoor":   [0.55, 0.70, 0.90, 1.15, 1.20, 1.00, 1.25, 1.30, 1.05, 1.20, 0.85, 0.60],
    "outdoor_cold": [0.45, 0.55, 0.70, 0.95, 1.20, 1.25, 1.45, 1.45, 1.20, 1.00, 0.55, 0.45],
    "tropical":  [1.30, 1.40, 1.10, 0.95, 0.80, 0.75, 1.10, 1.15, 0.70, 0.90, 1.10, 1.25],
    "beach":     [0.40, 0.50, 0.60, 0.80, 1.00, 1.40, 1.90, 1.90, 1.10, 0.90, 0.50, 0.40],
    "indoor":    [0.85, 1.00, 0.85, 0.95, 1.00, 1.00, 1.35, 1.40, 0.95, 1.05, 0.85, 0.80],
    "family":    [0.70, 0.95, 0.80, 1.00, 1.10, 1.00, 1.50, 1.55, 0.90, 1.10, 0.80, 0.70],
    "hotspring": [1.40, 1.30, 1.00, 0.80, 0.70, 0.60, 0.70, 0.70, 0.85, 1.00, 1.20, 1.40],
}
DOW = np.array([0.88, 0.82, 0.84, 0.90, 1.00, 1.60, 1.35])
HOLIDAY_MULT = {"元旦": 1.6, "春节": 2.0, "清明节": 1.7, "劳动节": 2.4, "端午节": 1.8, "中秋节": 1.8,
                "国庆节": 2.8, "国庆中秋": 2.8}
EVENT_NAMES = ["灯会", "音乐节", "花朝节", "非遗文化周", "美食节", "研学季", "啤酒节", "民俗庙会", "星空露营节", "冰雪节"]
SECONDARY_PER_CAPITA = {"主题乐园": 85, "动物园/海洋馆": 55, "温泉度假": 120, "古镇古村": 70, "演艺/秀场": 30,
                        "博物馆/展馆": 25, "滨海海岛": 60, "山岳峡谷": 50, "湖泊水域": 45}

# 预约曲线：截至 D-7 / D-3 / D-1 的累计线上预约占比（普通日 / 节假日）
BOOK_CURVE_NORMAL = np.array([0.18, 0.42, 0.72])
BOOK_CURVE_HOLIDAY = np.array([0.40, 0.65, 0.86])


def month_curve_key(category, province):
    clim = CLIMATE.get(province, "temperate")
    if category in ("博物馆/展馆", "演艺/秀场"):
        return "indoor"
    if category in ("主题乐园", "动物园/海洋馆"):
        return "family"
    if category == "温泉度假":
        return "hotspring"
    if clim == "tropical" and province == "海南":
        return "tropical"
    if category == "滨海海岛":
        return "beach"
    if clim in ("cold", "plateau"):
        return "outdoor_cold"
    return "outdoor"


def select_core_pois(pois: pd.DataFrame, product_detail: pd.DataFrame, n: int, rng) -> pd.DataFrame:
    shelf = product_detail[product_detail["ticket_type"] <= 8]
    cnt = shelf.groupby("poi_id").size()
    base = product_detail[product_detail["is_base_ticket"]].sort_values("sales_volume", ascending=False)
    base = base.drop_duplicates("poi_id").set_index("poi_id")
    elig = pois[pois["poi_id"].isin(cnt[cnt >= 4].index) & pois["poi_id"].isin(base.index)].copy()
    elig = elig.sort_values("popularity", ascending=False).head(n * 4)
    w = elig["popularity"].values ** 2
    pick = rng.choice(len(elig), size=min(n, len(elig)), replace=False, p=w / w.sum())
    core = elig.iloc[np.sort(pick)].copy()
    core["base_product_id"] = core["poi_id"].map(base["product_id"])
    core["base_price"] = core["poi_id"].map(base["list_price"])
    core["base_ceiling"] = core["poi_id"].map(base["ceiling_price"])
    core["base_floor"] = core["poi_id"].map(base["floor_price"])
    core["base_premium"] = core["poi_id"].map(base["premium_coef"])
    return core.reset_index(drop=True)


def build(pois: pd.DataFrame, product_detail: pd.DataFrame):
    rng = np.random.default_rng(config.SEED + 7)
    core = select_core_pois(pois, product_detail, config.CORE_POI_COUNT, rng)
    dates = all_dates()
    nd = len(dates)
    dtypes = [day_type(d) for d in dates]
    hol = [HOLIDAYS.get(d) for d in dates]
    sv = [school_vacation(d) for d in dates]
    slabel = [season_label(d) for d in dates]
    months = np.array([d.month for d in dates])
    dows = np.array([d.weekday() for d in dates])
    t_years = np.arange(nd) / 365.0

    # 节假日内的形状：首日 0.9，中段 1.05，末日 0.75
    hol_shape = np.ones(nd)
    i = 0
    while i < nd:
        if hol[i]:
            j = i
            while j + 1 < nd and hol[j + 1] == hol[i]:
                j += 1
            if j > i:
                hol_shape[i] = 0.9
                hol_shape[i + 1:j] = 1.05
                hol_shape[j] = 0.75
            i = j + 1
        else:
            i += 1

    frames = []
    for _, p in core.iterrows():
        cap = int(p["daily_capacity"])
        indoor = bool(p["indoor"])
        curve = np.array(MONTH_CURVES[month_curve_key(p["category"], p["province"])])
        base = cap * rng.uniform(0.10, 0.28)
        growth = rng.normal(0.06, 0.08)
        elasticity = rng.uniform(0.15, 0.5)
        online_ratio = rng.uniform(0.55, 0.88)
        book_noise = rng.uniform(0.85, 1.15)

        wx = [weather(p["city"], d) for d in dates]
        wcond = [w["weather"] for w in wx]
        wfac = np.array([weather_factor(c, indoor) for c in wcond])

        f_day = np.empty(nd)
        for k in range(nd):
            if dtypes[k] == "法定节假日":
                hm = HOLIDAY_MULT[hol[k]]
                if hol[k] == "春节" and curve[0] < 0.6:
                    hm *= 0.8  # 寒冷地区户外景区春节增幅有限
                f_day[k] = hm * hol_shape[k]
            elif dtypes[k] == "调休工作日":
                f_day[k] = 0.85
            else:
                f_day[k] = DOW[dows[k]]
        # 暑假工作日对亲子类景区额外加成
        if p["category"] in ("主题乐园", "动物园/海洋馆", "博物馆/展馆"):
            f_day *= np.where(np.array([s == "暑假" for s in sv]) & (dows < 5), 1.25, 1.0)

        # 节庆活动：每年 2~3 个，持续 3~14 天
        event = np.array([""] * nd, dtype=object)
        f_event = np.ones(nd)
        for year_start in (0, 366):
            for _ in range(int(rng.integers(2, 4))):
                s0 = year_start + int(rng.integers(0, 340))
                ln = int(rng.integers(3, 15))
                name = str(rng.choice(EVENT_NAMES))
                f_event[s0:s0 + ln] = rng.uniform(1.15, 1.45)
                event[s0:s0 + ln] = name

        # 执行票价：30% 景区在节假日实施溢价；15% 景区 2025 年起调价 +10%
        p0 = float(p["base_price"])
        price = np.full(nd, p0)
        if rng.random() < 0.15:
            price[np.array([d.year == 2025 for d in dates])] = round(p0 * 1.1)
        if rng.random() < 0.30:
            surge = min(float(p["base_premium"]), 1.2)
            price = np.where(np.array(dtypes) == "法定节假日", np.minimum(np.round(price * surge), p["base_ceiling"]), price)
        f_price = (price / p0) ** (-elasticity)

        expected = base * curve[months - 1] * f_day * wfac * (1 + growth) ** t_years * f_event * f_price
        actual = np.minimum(cap, np.round(expected * rng.lognormal(0, 0.07, nd))).astype(int)
        online = np.round(actual * np.clip(online_ratio + rng.normal(0, 0.03, nd), 0.3, 0.97)).astype(int)
        is_hol = np.array([t == "法定节假日" for t in dtypes])
        curve_b = np.where(is_hol[:, None], BOOK_CURVE_HOLIDAY, BOOK_CURVE_NORMAL) * book_noise
        curve_b = np.clip(curve_b * rng.uniform(0.92, 1.08, (nd, 3)), 0, 0.99)
        curve_b = np.maximum.accumulate(curve_b, axis=1)
        booked = np.round(online[:, None] * curve_b).astype(int)

        bad = np.array([c in ("中雨", "大雨", "中雪", "雷阵雨") for c in wcond])
        refund = np.round(online * (0.02 + 0.06 * bad) * rng.uniform(0.6, 1.4, nd)).astype(int)
        disc = rng.uniform(0.82, 0.95)  # 儿童/老人优惠与渠道折扣带来的平均实收折扣
        ticket_rev = np.round(actual * price * disc, 2)
        spc = SECONDARY_PER_CAPITA.get(p["category"], 40) * rng.uniform(0.7, 1.3)
        sec_rev = np.round(actual * spc * rng.lognormal(0, 0.08, nd), 2)
        load = actual / cap
        rating = np.clip(4.7 - 0.5 * np.clip(load - 0.8, 0, 1) * 2 - 0.15 * bad + rng.normal(0, 0.06, nd), 3.0, 5.0)
        complaints = rng.poisson(actual * 0.0006 * (1 + 3 * np.clip(load - 0.8, 0, 1)))
        comp_price = np.round(p0 * rng.uniform(0.85, 1.15) * (1 + rng.normal(0, 0.02, nd)))
        mkt = np.round(base * p0 * rng.uniform(0.01, 0.04) * (1 + 0.8 * np.roll(is_hol, -5)), 2)

        frames.append(pd.DataFrame({
            "date": [d.isoformat() for d in dates],
            "poi_id": p["poi_id"],
            "poi_name": p["poi_name"],
            "province": p["province"],
            "city": p["city"],
            "scenic_category": p["category"],
            "is_indoor": indoor,
            "weekday": [WEEKDAY_CN[d] for d in dows],
            "day_type": dtypes,
            "holiday_name": [h or "" for h in hol],
            "school_vacation": [s or "" for s in sv],
            "season_label": slabel,
            "weather": wcond,
            "temp_high": [w["temp_high"] for w in wx],
            "temp_low": [w["temp_low"] for w in wx],
            "event_name": event,
            "base_product_id": p["base_product_id"],
            "list_price": p0,
            "executed_price": price,
            "competitor_avg_price": comp_price,
            "daily_capacity": cap,
            "visitors": actual,
            "load_rate": np.round(load, 4),
            "is_sold_out": actual >= cap,
            "online_bookings": online,
            "offline_visitors": actual - online,
            "booked_by_d7": booked[:, 0],
            "booked_by_d3": booked[:, 1],
            "booked_by_d1": booked[:, 2],
            "refund_orders": refund,
            "ticket_revenue": ticket_rev,
            "secondary_revenue": sec_rev,
            "total_revenue": np.round(ticket_rev + sec_rev, 2),
            "avg_spend_per_visitor": np.round((ticket_rev + sec_rev) / np.maximum(actual, 1), 2),
            "marketing_spend": mkt,
            "satisfaction_score": np.round(rating, 2),
            "complaint_count": complaints,
        }))
    ops = pd.concat(frames, ignore_index=True)
    return core, ops
