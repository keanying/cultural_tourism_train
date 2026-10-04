"""数据集三：景区游客消费数据集（visitor_consumption）
数据集五：游客出行轨迹数据集（visitor_trajectory）

两者由同一个“行程模拟器”联合生成：
  游客(画像) -> 选择出游日期 -> 选择目的地城市(周边游/远途) -> 按客群偏好挑选景区序列
  -> 每个景区：按客群-商品匹配度选择商品下单 -> 天气/退改规则决定是否退款
  -> 未退款的到访形成轨迹点（含到达/离开时间、停留时长、交通方式、距离）
因此：消费记录中的“已核销”订单一定能在轨迹中找到对应到访；退款订单没有轨迹；
少量轨迹点为现场购票/免费游览，没有线上订单。
"""
import datetime as dt

import numpy as np
import pandas as pd

from . import config
from .calendar_cn import all_dates, day_type, holiday_name, weather
from .channels import AGE_CHANNEL_PRIOR, CHANNEL_META, CHANNELS, age_group
from .geo import CITY, haversine_km
from .segments import category_weight, feature_score

STAY_MIN = {"主题乐园": 360, "动物园/海洋馆": 240, "博物馆/展馆": 150, "演艺/秀场": 110, "温泉度假": 240,
            "古镇古村": 200, "宗教寺观": 100, "历史遗迹": 150, "滨海海岛": 240, "湖泊水域": 180, "山岳峡谷": 300,
            "自然生态": 180, "城市地标": 90}
TYPE_W = {1: 3.0, 2: 2.0, 3: 0.6, 4: 1.0, 5: 1.0, 6: 0.8, 7: 1.6, 8: 1.4, 9: 1.2, 10: 0.5, 11: 0.4}
LEAD_RANGE = {"当天": (0, 0), "1-3天": (1, 3), "4-7天": (4, 7), "7天以上": (8, 30)}
BAD_WEATHER = {"中雨", "大雨", "中雪", "雷阵雨"}
PAYMENTS = ["微信支付", "支付宝", "银行卡", "信用卡", "花呗/分期"]
SECONDARY_ITEMS = {"餐饮": (30, 120), "文创纪念品": (20, 150), "园内项目": (30, 200), "交通接驳": (10, 60)}


def _date_weights(dates):
    w = []
    for d in dates:
        t = day_type(d)
        f = {"法定节假日": 3.0, "周末": 1.8, "调休工作日": 0.6, "工作日": 0.75}[t]
        if d.month in (7, 8):
            f *= 1.4
        elif d.month in (1, 12):
            f *= 0.7
        w.append(f)
    w = np.array(w)
    return w / w.sum()


def build(profiles: pd.DataFrame, pois: pd.DataFrame, product_detail: pd.DataFrame):
    rng = np.random.default_rng(config.SEED + 5)
    target = config.DATASET_ROWS

    prods = product_detail[["product_id", "poi_id", "product_name", "ticket_type", "ticket_type_name",
                            "list_price", "sales_volume", "feature_tags", "refund_policy", "is_base_ticket"]].copy()
    prods["feat_list"] = prods["feature_tags"].fillna("").str.split("|").map(lambda x: [f for f in x if f])
    prod_by_poi = {k: g.reset_index(drop=True) for k, g in prods.groupby("poi_id")}
    P = pois[pois["poi_id"].isin(prod_by_poi.keys())].reset_index(drop=True)
    poi_by_city = {c: g.reset_index(drop=True) for c, g in P.groupby("city")}
    city_names = list(poi_by_city)
    city_w = np.array([(poi_by_city[c]["popularity"] ** 1.5).sum() for c in city_names])
    city_w = city_w / city_w.sum()
    prov_cities = {}
    for c in city_names:
        prov_cities.setdefault(CITY[c]["province"], []).append(c)

    dates = all_dates()
    dw = _date_weights(dates)
    vis = profiles.reset_index(drop=True)
    vw = vis["annual_trip_freq"].values.astype(float)
    vw /= vw.sum()

    orders, traj = [], []
    trip_no = 0
    order_no = 0
    while len(orders) < target or len(traj) < target:
        v = vis.iloc[rng.choice(len(vis), p=vw)]
        seg = v["travel_type"]
        src = v["source_city"]
        trip_no += 1
        trip_id = f"T{trip_no:07d}"
        # 目的地：35% 省内周边游
        if rng.random() < 0.35 and v["source_province"] in prov_cities:
            cands = prov_cities[v["source_province"]]
            cw = np.array([city_w[city_names.index(c)] for c in cands])
            dest = cands[rng.choice(len(cands), p=cw / cw.sum())]
        else:
            dest = city_names[rng.choice(len(city_names), p=city_w)]
        dist_src = haversine_km(CITY[src]["lat"], CITY[src]["lon"], CITY[dest]["lat"], CITY[dest]["lon"])
        days = int(rng.integers(1, 3)) if dist_src < 300 else int(rng.integers(2, 6))
        per_day = 2 if seg in ("朋友结伴", "学生游", "商务差旅") else (1 if seg == "银发游" else int(rng.integers(1, 3)))
        cpois = poi_by_city[dest]
        n_stops = int(min(days * per_day, len(cpois), 6))
        w = (cpois["popularity"].values + 0.02) ** 1.2 * np.array([category_weight(seg, c) for c in cpois["category"]])
        chosen = rng.choice(len(cpois), size=n_stops, replace=False, p=w / w.sum())
        start = dates[rng.choice(len(dates), p=dw)]
        if start + dt.timedelta(days=days) > dates[-1]:
            start = dates[-1] - dt.timedelta(days=days)
        prev_lat, prev_lon = CITY[src]["lat"], CITY[src]["lon"]
        lead_lo, lead_hi = LEAD_RANGE[v["booking_lead_pref"]]
        seq = 0
        for k, ci in enumerate(chosen):
            poi = cpois.iloc[ci]
            day_off = min(k // per_day, days - 1)
            visit = start + dt.timedelta(days=day_off)
            slot = k % per_day
            wx = weather(poi["city"], visit)
            # ---- 选商品 ----
            pp = prod_by_poi[poi["poi_id"]]
            sc = np.array([feature_score(seg, f) for f in pp["feat_list"]])
            pw = np.sqrt(pp["sales_volume"].fillna(0).values + 5) * np.exp(0.35 * sc) * pp["ticket_type"].map(TYPE_W).values
            if v["price_sensitivity"] == "高":
                pw = pw / np.sqrt(pp["list_price"].values + 10)
            prod = pp.iloc[rng.choice(len(pp), p=pw / pw.sum())]
            has_order = rng.random() < 0.93
            refunded = False
            order_id = None
            if has_order:
                order_no += 1
                order_id = f"O{order_no:08d}"
                r = rng.random()
                if r < 0.55:
                    ch = v["preferred_channel"]
                elif r < 0.8:
                    ch = v["secondary_channel"]
                else:
                    ch = CHANNELS[rng.choice(len(CHANNELS), p=AGE_CHANNEL_PRIOR[age_group(int(v["age"]))])]
                pf = np.mean(CHANNEL_META[ch][2])
                unit = round(float(prod["list_price"]) * pf, 2)
                a, c, o = int(v["adults"]), int(v["children"]), int(v["seniors"])
                half = prod["ticket_type"] in (1, 2, 7)
                qty = a + c + o
                original = round(unit * (a + (c + o) * (0.5 if half else 1.0)), 2)
                coupon = round(original * rng.uniform(0.05, 0.15), 2) if rng.random() < 0.3 else 0.0
                paid = round(original - coupon, 2)
                lead = 0 if ch == "线下窗口" else int(rng.integers(lead_lo, lead_hi + 1))
                otime = dt.datetime.combine(visit - dt.timedelta(days=lead), dt.time(0)) + dt.timedelta(
                    minutes=int(rng.integers(7 * 60, 23 * 60)) if lead else int(rng.integers(6 * 60, 10 * 60)))
                p_ref = 0.03 + (0.15 if wx["weather"] in BAD_WEATHER else 0) + (0.02 if prod["refund_policy"] == "随时退" else 0)
                refundable = prod["refund_policy"] != "不可退"
                refunded = refundable and rng.random() < p_ref
                status = "已退款" if refunded else ("已过期未使用" if rng.random() < 0.01 else "已核销")
                reason = ""
                if refunded:
                    reason = "天气原因" if wx["weather"] in BAD_WEATHER else str(rng.choice(["行程变更", "重复购买", "临时有事", "价格原因"]))
                sec_total, sec_detail = 0.0, []
                addon_id, addon_amt = "", 0.0
                if status == "已核销":
                    for item, (lo, hi) in SECONDARY_ITEMS.items():
                        if rng.random() < {"餐饮": 0.55, "文创纪念品": 0.25, "园内项目": 0.3, "交通接驳": 0.2}[item]:
                            amt = round(float(rng.uniform(lo, hi)) * max(1, qty * 0.7), 2)
                            sec_total += amt
                            sec_detail.append(f"{item}:{amt}")
                    # 园内加购组合商品（推荐场景的真实转化）
                    others = pp[(pp["product_id"] != prod["product_id"]) & (pp["ticket_type"].isin([2, 4, 5, 6, 7, 8]))]
                    if len(others) and prod["is_base_ticket"]:
                        osc = np.array([feature_score(seg, f) for f in others["feat_list"]])
                        best = int(np.argmax(osc))
                        if osc[best] > 1 and rng.random() < 0.18:
                            addon_id = others.iloc[best]["product_id"]
                            addon_amt = round(float(others.iloc[best]["list_price"]), 2)
                rating = None
                if status == "已核销" and rng.random() < 0.45:
                    base_r = 4.6 - (0.6 if wx["weather"] in BAD_WEATHER else 0) - (0.3 if day_type(visit) == "法定节假日" else 0)
                    rating = int(np.clip(round(rng.normal(base_r, 0.7)), 1, 5))
                orders.append({
                    "order_id": order_id, "visitor_id": v["visitor_id"], "trip_id": trip_id,
                    "poi_id": poi["poi_id"], "poi_name": poi["poi_name"], "poi_province": poi["province"],
                    "poi_city": poi["city"], "scenic_category": poi["category"],
                    "product_id": prod["product_id"], "product_name": prod["product_name"],
                    "ticket_type_name": prod["ticket_type_name"], "channel": ch,
                    "order_time": otime.strftime("%Y-%m-%d %H:%M:%S"), "visit_date": visit.isoformat(),
                    "lead_days": lead, "adult_qty": a, "child_qty": c, "senior_qty": o, "quantity": qty,
                    "unit_price": unit, "original_amount": original, "coupon_amount": coupon,
                    "paid_amount": paid, "payment_method": PAYMENTS[rng.choice(5, p=[0.52, 0.33, 0.06, 0.05, 0.04])],
                    "order_status": status, "refund_reason": reason,
                    "refund_amount": paid if refunded else 0.0,
                    "addon_product_id": addon_id, "addon_amount": addon_amt,
                    "secondary_spend": round(sec_total, 2), "secondary_detail": ";".join(sec_detail),
                    "total_spend": 0.0 if refunded else round(paid + addon_amt + sec_total, 2),
                    "rating": rating, "visit_weather": wx["weather"], "visit_day_type": day_type(visit),
                    "holiday_name": holiday_name(visit) or "",
                    "travel_type": seg, "member_level": v["member_level"],
                })
            if refunded or (has_order and status == "已过期未使用"):
                continue  # 退款/未使用订单没有到访轨迹
            # ---- 轨迹点 ----
            seq += 1
            plat, plon = float(poi["lat"]), float(poi["lon"])
            dist = haversine_km(prev_lat, prev_lon, plat, plon)
            if seq == 1:
                mode = "飞机" if dist > 1000 else ("高铁" if dist > 300 else (str(rng.choice(["自驾", "高铁", "大巴"])) if dist > 80 else str(rng.choice(["自驾", "地铁/公交", "打车"]))))
            else:
                mode = "步行/骑行" if dist < 2 else (str(rng.choice(["地铁/公交", "打车"])) if dist < 15 else str(rng.choice(["自驾", "打车", "景区直通车"])))
            arrive_min = (int(rng.integers(8 * 60 + 30, 10 * 60 + 30)) if slot == 0 else int(rng.integers(13 * 60 + 30, 15 * 60 + 30)))
            stay = int(STAY_MIN.get(poi["category"], 150) * rng.uniform(0.7, 1.3) * (0.7 if per_day == 2 else 1.0))
            if wx["weather"] in BAD_WEATHER:
                stay = int(stay * 0.75)
            arrive = dt.datetime.combine(visit, dt.time(0)) + dt.timedelta(minutes=arrive_min)
            leave = arrive + dt.timedelta(minutes=stay)
            traj.append({
                "trajectory_id": f"{trip_id}-{seq:02d}", "trip_id": trip_id, "visitor_id": v["visitor_id"],
                "seq_no": seq, "poi_id": poi["poi_id"], "poi_name": poi["poi_name"],
                "province": poi["province"], "city": poi["city"], "scenic_category": poi["category"],
                "lat": round(plat, 4), "lon": round(plon, 4),
                "visit_date": visit.isoformat(), "arrive_time": arrive.strftime("%Y-%m-%d %H:%M"),
                "leave_time": leave.strftime("%Y-%m-%d %H:%M"), "stay_minutes": stay,
                "transport_from_prev": mode, "distance_from_prev_km": round(dist, 1),
                "origin_city": src if seq == 1 else "",
                "trip_type": "省内周边游" if CITY[dest]["province"] == v["source_province"] else "跨省游",
                "trip_days": days, "weather": wx["weather"], "temp_high": wx["temp_high"],
                "day_type": day_type(visit), "order_id": order_id or "", "entry_type": "线上订单" if order_id else "现场购票/免费游览",
                "travel_type": seg,
            })
            prev_lat, prev_lon = plat, plon
        if trip_no % 20000 == 0:
            print(f"[trips] trips={trip_no} orders={len(orders)} traj={len(traj)}")

    orders = pd.DataFrame(orders).head(target)
    traj = pd.DataFrame(traj).head(target)
    # 截断后保证引用完整：轨迹引用的订单若被截掉，视为现场购票
    keep = set(orders["order_id"])
    lost = (traj["order_id"] != "") & ~traj["order_id"].isin(keep)
    traj.loc[lost, "order_id"] = ""
    traj.loc[lost, "entry_type"] = "现场购票/免费游览"
    return orders, traj
