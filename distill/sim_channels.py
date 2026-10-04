"""数据集一：景区分销渠道数据集（channel_distribution）。

粒度：统计月 × 核心景区 × 商品 × 渠道。
销量与日度运营表严格对齐：同一景区同月，各渠道各商品售票量之和 = 当月接待人次；
线下窗口 = 线下入园人次；其余渠道分摊线上预约量。
漏斗（曝光→点击→订单）、佣金、营销费用、ROAS 与客群结构按渠道特征生成。
"""
import math

import numpy as np
import pandas as pd

from . import config
from .channels import CHANNEL_META, CHANNEL_SEGMENT_TILT, CHANNELS
from .segments import CATEGORY_AFFINITY, SEGMENTS

ONLINE_CHANNELS = [c for c in CHANNELS if c != "线下窗口"]
ONLINE_PRIOR = np.array([0.26, 0.20, 0.07, 0.15, 0.04, 0.07, 0.12, 0.09])
LEAD_DAYS = {"携程": 4.5, "美团": 1.8, "飞猪": 5.0, "抖音团购": 6.5, "小红书": 7.0, "同程旅行": 4.0,
             "景区官网/小程序": 2.5, "线下窗口": 0.0, "旅行社分销": 12.0}
REFUND_RATE = {"携程": 0.05, "美团": 0.04, "飞猪": 0.06, "抖音团购": 0.12, "小红书": 0.08, "同程旅行": 0.05,
               "景区官网/小程序": 0.03, "线下窗口": 0.0, "旅行社分销": 0.07}


def build(core: pd.DataFrame, ops: pd.DataFrame, product_detail: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(config.SEED + 11)
    ops = ops.copy()
    ops["month"] = ops["date"].str[:7]
    monthly = ops.groupby(["poi_id", "month"]).agg(online=("online_bookings", "sum"),
                                                     offline=("offline_visitors", "sum")).reset_index()
    months = sorted(monthly["month"].unique())
    nm = len(months)
    shelf = product_detail[(product_detail["ticket_type"] <= 8)]

    # 1) 结构化上架关系：(景区, 商品, 渠道)
    triplets = []
    for _, p in core.iterrows():
        prods = shelf[(shelf["poi_id"] == p["poi_id"]) & (shelf["product_id"] != p["base_product_id"])]
        prods = prods.sort_values("sales_volume", ascending=False).head(3)
        plist = [p["base_product_id"]] + prods["product_id"].tolist()
        for j, pid in enumerate(plist):
            for ch in CHANNELS:
                if ch == "线下窗口" and j > 0:
                    continue
                triplets.append((p["poi_id"], pid, ch, j == 0))
    trip = pd.DataFrame(triplets, columns=["poi_id", "product_id", "channel", "is_base"])
    target = config.DATASET_ROWS
    k_need = math.ceil(target / nm)
    if len(trip) > k_need:
        # 非基础商品的部分渠道未上架：随机下架补足到目标行数
        non_base = trip.index[~trip["is_base"]].to_numpy()
        drop = rng.choice(non_base, size=len(trip) - k_need, replace=False)
        trip = trip.drop(drop).reset_index(drop=True)
    trip["start_month_idx"] = 0
    extra = k_need * nm - target
    if extra > 0:
        cand = trip.index[~trip["is_base"]].to_numpy()
        trip.loc[rng.choice(cand), "start_month_idx"] = extra  # 该商品在该渠道为期中上架
    print(f"[channels] listings={len(trip)} months={nm} rows={len(trip) * nm - extra}")

    # 2) 景区级参数
    pmeta = product_detail.set_index("product_id")
    cmeta = core.set_index("poi_id")
    rows = []
    for poi_id, g in trip.groupby("poi_id", sort=False):
        cat = cmeta.loc[poi_id, "category"]
        seg_base = np.array([CATEGORY_AFFINITY[s].get(cat, 1.0) for s in SEGMENTS]) * rng.uniform(0.7, 1.3, len(SEGMENTS))
        on_share = rng.dirichlet(ONLINE_PRIOR * 40)
        drift = rng.normal(0, 0.04, (nm, len(ONLINE_CHANNELS))).cumsum(axis=0)
        drift[:, ONLINE_CHANNELS.index("抖音团购")] += np.linspace(0, 0.35, nm)  # 内容电商份额上升
        ch_param = {}
        for ch in CHANNELS:
            ctype, com, pf, ctr, cvr, ads, roas = CHANNEL_META[ch]
            ch_param[ch] = dict(
                commission=round(rng.uniform(*com), 3), price_factor=round(rng.uniform(*pf), 3),
                ctr=rng.uniform(*ctr) if ctr[1] else None, cvr=rng.uniform(*cvr) if cvr[1] else None,
                roas=roas * rng.uniform(0.5, 1.6) if ads else None, party=rng.uniform(1.7, 2.6),
                tilt=np.array([CHANNEL_SEGMENT_TILT[ch].get(s, 1.0) for s in SEGMENTS]),
            )
        prod_ids = g["product_id"].unique().tolist()
        prod_w = {pid: (rng.uniform(3.0, 5.0) if pid == cmeta.loc[poi_id, "base_product_id"] else rng.uniform(0.4, 1.4))
                  for pid in prod_ids}
        mrows = monthly[monthly["poi_id"] == poi_id].set_index("month")
        for mi, m in enumerate(months):
            online_total = int(mrows.loc[m, "online"])
            offline_total = int(mrows.loc[m, "offline"])
            live = g[g["start_month_idx"] <= mi]
            sh = on_share * np.exp(drift[mi])
            sh = dict(zip(ONLINE_CHANNELS, sh / sh.sum()))
            # 渠道 -> 当月售票量（整数分配，余数给最大渠道，保证与线上总量相等）
            live_ch = [c for c in ONLINE_CHANNELS if c in set(live["channel"])]
            w = np.array([sh[c] for c in live_ch])
            alloc = np.floor(online_total * w / w.sum()).astype(int)
            alloc[np.argmax(w)] += online_total - alloc.sum()
            ch_tickets = dict(zip(live_ch, alloc))
            ch_tickets["线下窗口"] = offline_total
            for ch, gg in live.groupby("channel", sort=False):
                pids = gg["product_id"].tolist()
                pw = np.array([prod_w[x] for x in pids]) * rng.uniform(0.85, 1.15, len(pids))
                pa = np.floor(ch_tickets.get(ch, 0) * pw / pw.sum()).astype(int)
                pa[0] += ch_tickets.get(ch, 0) - pa.sum()
                cp = ch_param[ch]
                seg = seg_base * cp["tilt"] * rng.uniform(0.9, 1.1, len(SEGMENTS))
                seg = seg / seg.sum()
                for pid, tickets in zip(pids, pa):
                    list_price = float(pmeta.loc[pid, "list_price"])
                    price = round(list_price * cp["price_factor"], 2)
                    orders = int(round(tickets / cp["party"]))
                    gmv = round(tickets * price, 2)
                    refund_orders = int(rng.binomial(orders, REFUND_RATE[ch])) if orders else 0
                    commission = round(gmv * cp["commission"], 2)
                    if cp["cvr"]:
                        cvr = cp["cvr"] * rng.uniform(0.85, 1.15)
                        clicks = int(round(orders / cvr)) if orders else int(rng.integers(0, 30))
                        exposure = int(round(clicks / (cp["ctr"] * rng.uniform(0.85, 1.15))))
                    else:
                        clicks = exposure = None
                    if cp["roas"]:
                        spend = round(gmv / (cp["roas"] * rng.uniform(0.85, 1.15)), 2) if gmv else 0.0
                    else:
                        spend = 0.0
                    row = {
                        "stat_month": m, "poi_id": poi_id, "poi_name": cmeta.loc[poi_id, "poi_name"],
                        "province": cmeta.loc[poi_id, "province"], "city": cmeta.loc[poi_id, "city"],
                        "scenic_category": cat, "product_id": pid, "product_name": pmeta.loc[pid, "product_name"],
                        "ticket_type_name": pmeta.loc[pid, "ticket_type_name"], "channel": ch,
                        "channel_type": CHANNEL_META[ch][0], "list_price": list_price, "channel_price": price,
                        "commission_rate": cp["commission"], "exposure": exposure, "clicks": clicks,
                        "ctr": round(clicks / exposure, 4) if exposure else None,
                        "orders": orders, "cvr": round(orders / clicks, 4) if clicks else None,
                        "tickets_sold": int(tickets), "gmv": gmv, "commission_fee": commission,
                        "refund_orders": refund_orders,
                        "refund_rate": round(refund_orders / orders, 4) if orders else 0.0,
                        "net_revenue": round(gmv - commission, 2), "marketing_spend": spend,
                        "roas": round(gmv / spend, 2) if spend else None,
                        "cpa": round(spend / orders, 2) if spend and orders else None,
                        "new_customer_ratio": round(float(rng.uniform(0.35, 0.85)), 3),
                        "avg_lead_days": round(LEAD_DAYS[ch] * float(rng.uniform(0.7, 1.3)), 1),
                        "main_segment": SEGMENTS[int(np.argmax(seg))],
                    }
                    for s, v in zip(SEGMENTS, seg):
                        row[f"seg_share_{s}"] = round(float(v), 4)
                    rows.append(row)
    df = pd.DataFrame(rows)
    df = df.sort_values(["stat_month", "poi_id", "product_id", "channel"]).reset_index(drop=True)
    return df
