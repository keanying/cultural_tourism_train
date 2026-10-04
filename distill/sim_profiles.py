"""数据集四：景区游客画像数据集（visitor_profile）。

游客基础属性按客群逻辑联合采样（年龄与出游类型、城市等级与收入、收入与价格敏感度、
年龄与渠道偏好均相关），消费汇总字段在订单生成后回填，保证与消费数据集一致。
不含任何真实个人身份信息。
"""
import datetime as dt

import numpy as np
import pandas as pd

from . import config
from .channels import AGE_CHANNEL_PRIOR, CHANNELS, age_group
from .geo import CITY
from .segments import CATEGORY_AFFINITY, SEGMENT_AGE, SEGMENT_PARTY, SEGMENTS

SEG_P = [0.22, 0.15, 0.15, 0.10, 0.10, 0.12, 0.06, 0.10]
TIER_W = {1: 10.0, 2: 4.0, 3: 2.0, 4: 0.8}
CATEGORIES = ["主题乐园", "动物园/海洋馆", "博物馆/展馆", "演艺/秀场", "温泉度假", "古镇古村", "宗教寺观",
              "历史遗迹", "滨海海岛", "湖泊水域", "山岳峡谷", "自然生态", "城市地标"]
INTEREST_POOL = {
    "亲子游": ["遛娃", "科普研学", "萌宠互动", "亲子手作", "儿童乐园"],
    "情侣游": ["拍照打卡", "夜景", "浪漫约会", "汉服旅拍", "温泉"],
    "朋友结伴": ["刺激项目", "美食探店", "露营", "漂流", "夜生活"],
    "独自旅行": ["人文历史", "博物馆", "徒步", "摄影", "City Walk"],
    "银发游": ["养生", "慢游", "宗教文化", "赏花", "温泉"],
    "家庭多代游": ["休闲度假", "美食", "古镇", "观光车", "风景名胜"],
    "商务差旅": ["城市地标", "人文历史", "夜景", "高效游览", "美食"],
    "学生游": ["性价比", "拍照打卡", "City Walk", "研学", "音乐节"],
}


def _age_band(a):
    for lo, hi, name in [(18, 24, "18-24"), (25, 29, "25-29"), (30, 34, "30-34"), (35, 39, "35-39"),
                         (40, 49, "40-49"), (50, 59, "50-59")]:
        if lo <= a <= hi:
            return name
    return "60+"


def build() -> pd.DataFrame:
    rng = np.random.default_rng(config.SEED + 4)
    n = config.DATASET_ROWS
    cities = list(CITY)
    cw = np.array([TIER_W[CITY[c]["tier"]] for c in cities])
    src = rng.choice(cities, size=n, p=cw / cw.sum())
    seg = rng.choice(SEGMENTS, size=n, p=SEG_P)
    rows = []
    start, end = dt.date(2019, 1, 1), dt.date(2025, 6, 30)
    span = (end - start).days
    for i in range(n):
        s = seg[i]
        lo, hi = SEGMENT_AGE[s]
        age = int(rng.integers(lo, hi + 1))
        gender = "女" if rng.random() < (0.62 if s in ("亲子游", "情侣游", "独自旅行") else 0.5) else "男"
        city = src[i]
        tier = CITY[city]["tier"]
        party = SEGMENT_PARTY[s][rng.integers(len(SEGMENT_PARTY[s]))]
        a_, c_, o_ = party
        if s == "银发游":
            party_desc = f"{o_}位长者结伴" if o_ > 1 else "长者独自出行"
        else:
            parts = []
            if a_:
                parts.append(f"{a_}大")
            if c_:
                parts.append(f"{c_}小")
            if o_:
                parts.append(f"{o_}老")
            party_desc = "".join(parts) if (c_ or o_) else (f"{a_}人" if a_ > 1 else "1人")
        child_age = int(rng.integers(3, 13)) if c_ else None
        # 收入：城市等级越高越高，银发、学生偏低
        inc_score = {1: 2.4, 2: 1.9, 3: 1.5, 4: 1.1}[tier] + rng.normal(0, 0.6)
        if s == "学生游":
            inc_score -= 1.2
        if s == "商务差旅":
            inc_score += 0.6
        income = "低" if inc_score < 1.0 else ("中" if inc_score < 1.8 else ("中高" if inc_score < 2.6 else "高"))
        sens = {"低": "高", "中": "中", "中高": "中", "高": "低"}[income]
        if rng.random() < 0.2:
            sens = rng.choice(["高", "中", "低"])
        ch_p = np.array(AGE_CHANNEL_PRIOR[age_group(age)])
        chs = rng.choice(CHANNELS, size=2, replace=False, p=ch_p)
        lead = rng.choice(["当天", "1-3天", "4-7天", "7天以上"],
                          p=[0.15, 0.40, 0.28, 0.17] if s != "商务差旅" else [0.40, 0.45, 0.10, 0.05])
        trips = int(np.clip(rng.poisson({"低": 2, "中": 3, "中高": 4, "高": 6}[income]) + 1, 1, 15))
        aff = CATEGORY_AFFINITY[s]
        cw2 = np.array([aff.get(c, 1.0) for c in CATEGORIES]) * rng.uniform(0.6, 1.4, len(CATEGORIES))
        pref = [CATEGORIES[j] for j in np.argsort(-cw2)[:3]]
        tags = list(rng.choice(INTEREST_POOL[s], size=3, replace=False))
        member = rng.choice(["普通会员", "银卡", "金卡", "铂金卡"],
                            p=[0.5, 0.28, 0.16, 0.06] if income in ("低", "中") else [0.3, 0.3, 0.26, 0.14])
        device = rng.choice(["iOS", "Android", "小程序", "PC"],
                            p=[0.42, 0.42, 0.12, 0.04] if age < 50 else [0.25, 0.50, 0.17, 0.08])
        reg = start + dt.timedelta(days=int(rng.integers(0, span)))
        rows.append({
            "visitor_id": f"V{i + 1:07d}",
            "gender": gender,
            "age": age,
            "age_band": _age_band(age),
            "source_province": CITY[city]["province"],
            "source_city": city,
            "city_tier": f"{tier}线" if tier < 4 else "4线及以下",
            "travel_type": s,
            "party_structure": party_desc,
            "adults": a_, "children": c_, "seniors": o_,
            "child_age": child_age,
            "income_level": income,
            "price_sensitivity": sens,
            "member_level": member,
            "preferred_channel": chs[0],
            "secondary_channel": chs[1],
            "booking_lead_pref": lead,
            "annual_trip_freq": trips,
            "preferred_categories": "|".join(pref),
            "interest_tags": "|".join(tags),
            "device_type": device,
            "register_date": reg.isoformat(),
        })
    return pd.DataFrame(rows)


def backfill_from_orders(profiles: pd.DataFrame, orders: pd.DataFrame) -> pd.DataFrame:
    """用消费数据回填画像中的消费汇总字段。"""
    valid = orders[orders["order_status"] != "已退款"]
    g = valid.groupby("visitor_id")
    agg = pd.DataFrame({
        "total_orders": g.size(),
        "total_spend": g["total_spend"].sum().round(2),
        "last_visit_date": g["visit_date"].max(),
        "favorite_province": g["poi_province"].agg(lambda s: s.value_counts().index[0]),
    })
    refunds = orders[orders["order_status"] == "已退款"].groupby("visitor_id").size()
    out = profiles.merge(agg, left_on="visitor_id", right_index=True, how="left")
    out["total_orders"] = out["total_orders"].fillna(0).astype(int)
    out["total_spend"] = out["total_spend"].fillna(0.0)
    out["avg_order_amount"] = np.where(out["total_orders"] > 0, (out["total_spend"] / out["total_orders"].clip(lower=1)).round(2), 0.0)
    out["refund_orders"] = out["visitor_id"].map(refunds).fillna(0).astype(int)
    v = out["total_spend"]
    pos = v[v > 0]
    q90, q60 = pos.quantile(0.9), pos.quantile(0.6)
    out["value_tier"] = np.select([v >= q90, v >= q60, v > 0], ["高价值", "中价值", "低价值"], "未消费")
    return out
