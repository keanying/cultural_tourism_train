"""数据集二：景区产品详情数据集（scenic_product_detail）。

以携程真实商品为主体（名称、价格、销量、费用包含、购买须知均为真实采集值），
补充解析字段（退改、预订时效、适用人群、特征标签）与业务派生字段
（成本价、限价区间、溢价/折扣系数、日库存、目标客群），派生字段在数据字典中标注。
"""
import numpy as np
import pandas as pd

from . import config
from .segments import SEGMENTS, feature_score

COST_RATIO = {1: (0.12, 0.30), 2: (0.35, 0.55), 3: (0.30, 0.50), 4: (0.40, 0.60), 5: (0.35, 0.55),
              6: (0.55, 0.75), 7: (0.25, 0.45), 8: (0.30, 0.50), 9: (0.62, 0.80), 10: (0.45, 0.70), 11: (0.65, 0.85)}
PREMIUM_COEFS = np.array([1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5])
DISCOUNT_COEFS = np.array([0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9])


def _select_rows(products: pd.DataFrame, n: int, rng) -> pd.DataFrame:
    """优先保留货架商品与一日游，其余从当地特色/跟团司导按销量加权抽样补足。"""
    core = products[products["ticket_type"] <= 9]
    rest = products[products["ticket_type"] >= 10]
    need = n - len(core)
    if need <= 0:
        return core.sample(n, random_state=config.SEED)
    w = np.log1p(rest["sales_volume"].fillna(0).values) + 0.5
    idx = rng.choice(len(rest), size=need, replace=False, p=w / w.sum())
    return pd.concat([core, rest.iloc[idx]], ignore_index=True)


def build(pois: pd.DataFrame, products: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(config.SEED + 2)
    df = _select_rows(products, config.DATASET_ROWS, rng)
    df = df.merge(pois[["poi_id", "grade_inferred", "daily_capacity", "popularity"]], on="poi_id", how="left")
    df = df.sort_values(["poi_id", "ticket_type", "ticket_price"]).reset_index(drop=True)
    n = len(df)
    df["product_id"] = [f"P{i:07d}" for i in range(1, n + 1)]

    price = df["ticket_price"].values
    lo = np.array([COST_RATIO[t][0] for t in df["ticket_type"]])
    hi = np.array([COST_RATIO[t][1] for t in df["ticket_type"]])
    df["cost_price"] = np.round(price * rng.uniform(lo, hi), 2)
    df["floor_price"] = np.minimum(np.maximum(np.ceil(price * rng.uniform(0.6, 0.85, n)), np.ceil(df["cost_price"] * 1.05)), price)
    df["ceiling_price"] = np.ceil(price * rng.uniform(1.3, 1.8, n))
    df["premium_coef"] = rng.choice(PREMIUM_COEFS, n)
    df["discount_coef"] = rng.choice(DISCOUNT_COEFS, n)

    # 日库存：基础门票按景区承载量的线上配额；其他商品按销量规模
    cap = df["daily_capacity"].fillna(3000).values
    sales = df["sales_volume"].fillna(0).values
    base_inv = np.where(df["ticket_type"] == 1, cap * rng.uniform(0.35, 0.7, n),
                        np.clip(np.sqrt(sales + 1) * rng.uniform(3, 8, n), 20, cap * 0.3))
    df["daily_inventory"] = (np.round(base_inv / 10) * 10).astype(int).clip(min=10)

    # 是否基础门票：景点门票且名称不含“+”组合
    df["is_base_ticket"] = (df["ticket_type"] == 1) & ~df["ticket_name"].str.contains(r"\+|＋|套餐|联票")

    # 目标客群：特征打分最高的 2 个客群（得分需 > 0）
    feats = df["features"].str.split("|").map(lambda x: [f for f in x if f])
    targets = []
    for fs in feats:
        sc = sorted(((feature_score(s, fs), s) for s in SEGMENTS), reverse=True)
        top = [s for v, s in sc[:2] if v > 0]
        targets.append("|".join(top) if top else "大众游客")
    df["target_segments"] = targets

    out = pd.DataFrame({
        "product_id": df["product_id"],
        "source_ticket_id": df["ticket_id"],
        "poi_id": df["poi_id"],
        "poi_name": df["poi_name"],
        "province": df["province"],
        "city": df["city"],
        "scenic_category": df["category"],
        "scenic_grade_inferred": df["grade_inferred"],
        "ticket_type": df["ticket_type"],
        "ticket_type_name": df["ticket_type_name"],
        "product_name": df["ticket_name"],
        "list_price": df["ticket_price"].round(2),
        "sales_volume": df["sales_volume"],
        "sales_volume_raw": df["ticket_sales_volume"],
        "is_base_ticket": df["is_base_ticket"],
        "feature_tags": df["features"],
        "target_segments": df["target_segments"],
        "applicable_crowd": df["applicable_crowd"],
        "duration_hours": df["duration_hours"],
        "booking_advance": df["booking_advance"],
        "refund_policy": df["refund_policy"],
        "entry_method": df["entry_method"],
        "ticket_issue_speed": df["ticket_issue_speed"],
        "need_id_card": df["need_id_card"],
        "cost_price": df["cost_price"],
        "floor_price": df["floor_price"],
        "ceiling_price": df["ceiling_price"],
        "premium_coef": df["premium_coef"],
        "discount_coef": df["discount_coef"],
        "daily_inventory": df["daily_inventory"],
        "cost_inclusion": df["cost_inclusion"],
        "purchase_notes": df["purchase_notes"],
        "data_source": "ctrip_real+derived",
    })
    return out
