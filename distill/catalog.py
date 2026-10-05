"""携程景区票务原始数据清洗与特征抽取。

输出：
  - POI 表：景区 ID、名称、推断城市/省份、景区类别、是否室内、热度、日承载量等
  - 商品表：清洗后的价格/销量 + 从名称、费用包含、购买须知中解析的结构化属性
"""
import os
import re
import zipfile

import numpy as np
import pandas as pd

from . import config
from .geo import CITY, CAPITAL, match_cities

TYPE_NAME = {1: "景点门票", 2: "门票套餐", 3: "官方服务", 4: "研学体验", 5: "讲解服务", 6: "直通车",
             7: "景点联票", 8: "项目体验", 9: "一日游", 10: "当地特色", 11: "跟团司导"}
SHELF_TYPES = {1, 2, 3, 4, 5, 6, 7, 8}

_PERFORMANCE_RE = re.compile(r" · |演唱会|专场|巡演|话剧|音乐会|音乐节|脱口秀|喜剧《|歌剧|舞剧《|livehouse", re.I)

# 景区类别规则（顺序即优先级）
CATEGORY_RULES = [
    ("主题乐园", r"乐园|欢乐谷|方特|迪士尼|长隆|游乐|嘉年华|乐高|环球影城|梦幻王国|童话|恐龙园|影视城|世界之窗"),
    ("动物园/海洋馆", r"动物园|动物世界|野生动物|海洋馆|海洋公园|海洋世界|极地|水族|熊猫基地|鸟语林"),
    ("博物馆/展馆", r"博物馆|博物院|纪念馆|展览馆|美术馆|科技馆|艺术馆|故居|陈列馆|展厅|科普馆|规划馆"),
    ("演艺/秀场", r"千古情|演艺|秀$|大剧院|剧场|实景演出"),
    ("温泉度假", r"温泉|汤泉|度假区|度假村"),
    ("古镇古村", r"古镇|古城|古村|老街|水乡|苗寨|侗寨|千户|土楼|村落"),
    ("宗教寺观", r"寺|庙|道观|禅院|教堂|清真|佛|观音|祠"),
    ("历史遗迹", r"遗址|故宫|皇城|王府|陵|城墙|长城|石窟|古迹|关$|城楼|书院|园林|园博|颐和园|圆明园|拙政园|留园|狮子林|豫园|个园|何园|网师园|大观园"),
    ("滨海海岛", r"海滩|沙滩|海岛|岛$|海湾|湾$|海水浴场|渔村|半岛"),
    ("湖泊水域", r"湖|江|河|溪|潭|泉|湿地|水库|漂流"),
    ("山岳峡谷", r"山|峰|岭|峡|谷|崖|岩"),
    ("自然生态", r"森林|草原|沙漠|溶洞|洞|瀑布|花海|植物园|生态|公园|景区"),
    ("城市地标", r"广场|街|塔|大厦|观光|中心|码头|夜景|城市"),
]
INDOOR_CATEGORIES = {"博物馆/展馆", "演艺/秀场"}

# 商品特征关键词（名称 + 费用包含）
FEATURE_RULES = {
    "含讲解": r"讲解|导览|导游|讲述|解说",
    "含交通": r"直通车|接送|大巴|往返|班车|观光车|电瓶车|拼车|包车|用车|摆渡",
    "含索道缆车": r"索道|缆车|观光电梯|小火车",
    "含游船": r"游船|船票|竹筏|游艇|快艇|乘船|画舫|摇橹",
    "含餐饮": r"(?<!套)餐|饭|饮品|下午茶|小吃|美食|早茶|茶歇|烧烤",
    "含演出": r"演出|表演|秀|千古情|剧|演艺",
    "含住宿": r"酒店|住宿|民宿|客栈|房",
    "亲子儿童": r"亲子|儿童|宝宝|家庭|小朋友|萌宠|喂养|动物",
    "研学教育": r"研学|课程|科普|手工|非遗|体验营|拓印|制作|DIY|diy",
    "夜游": r"夜游|夜场|晚间|灯光|夜景|星空|夜宿",
    "摄影写真": r"摄影|写真|旅拍|汉服|古装|藏服|服饰|跟拍|妆造",
    "刺激项目": r"漂流|玻璃栈道|玻璃桥|滑道|蹦极|高空|冲浪|卡丁车|滑翔|过山车|速降|攀岩|飞拉达|越野|ATV|探险|滑雪|皮划艇|桨板|潜水|摩托艇|飞行",
    "温泉康养": r"温泉|汤泉|康养|SPA|spa|足疗",
    "快速通道": r"VIP|vip|免排队|快速通道|优先|专属通道|贵宾",
    "多景点": r"联票|\+.*门票|通票|全景|套票|年卡|年票|Pass|pass|一票通",
}


def parse_sales(s: str):
    """把“月销600+份”“2K+”“1.2万+”等展示文本解析为数值下限。"""
    if not s:
        return np.nan
    s = s.strip()
    m = re.search(r"([\d.]+)\s*(万|[kK]|千)?", s)
    if not m:
        return np.nan
    v = float(m.group(1))
    unit = m.group(2)
    if unit == "万":
        v *= 10000
    elif unit in ("k", "K", "千"):
        v *= 1000
    return float(int(v))


def _first(pattern, text, group=1):
    m = re.search(pattern, text)
    return m.group(group) if m else None


def parse_notes(notes: str) -> dict:
    n = notes or ""
    if "可订今日" in n or "可订今天" in n:
        advance = "可订今日"
    elif "可订明日" in n:
        advance = "可订明日"
    else:
        d = _first(r"需提前(\d+)天", n)
        advance = f"需提前{d}天" if d else "未说明"
    if "随时退" in n:
        refund = "随时退"
    elif "不可退" in n or "不退不改" in n:
        refund = "不可退"
    elif "有条件退" in n or "条件退" in n:
        refund = "有条件退"
    elif "过期自动退" in n:
        refund = "过期自动退"
    else:
        refund = "未说明"
    if "无需换票" in n or "扫码入园" in n or "刷身份证" in n or "凭「有效证件」" in n:
        entry = "电子凭证直接入园"
    elif "需换票" in n or "取票" in n:
        entry = "需换票/集合"
    else:
        entry = "未说明"
    if "1小时" in n and "出票" in n and "大于" not in n:
        speed = "1小时内出票"
    elif "立即出票" in n or "极速出票" in n or "秒出票" in n:
        speed = "立即出票"
    elif "大于1小时" in n:
        speed = "大于1小时出票"
    else:
        speed = "未说明"
    dur = _first(r"(?:时长|游玩时长|活动时长)约?([\d.]+(?:-[\d.]+)?)\s*(?:个)?小时", n)
    crowd = []
    for k, pat in [("成人", "成人"), ("儿童", "儿童"), ("学生", "学生"), ("老人", "老人|长者|60周岁|65周岁"),
                   ("亲子", "亲子|1大1小|2大1小"), ("家庭", "家庭")]:
        if re.search(pat, n):
            crowd.append(k)
    return {
        "booking_advance": advance,
        "refund_policy": refund,
        "entry_method": entry,
        "ticket_issue_speed": speed,
        "duration_hours": dur or "",
        "applicable_crowd": "|".join(crowd) if crowd else "不限",
        "need_id_card": "身份证" in n or "有效证件" in n,
    }


def extract_features(text: str):
    return [k for k, pat in FEATURE_RULES.items() if re.search(pat, text)]


def infer_category(name: str, product_text: str) -> str:
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, name):
            return cat
    for cat, pat in CATEGORY_RULES[:6]:
        if re.search(pat, product_text):
            return cat
    return "自然生态"


def load_raw() -> pd.DataFrame:
    csv_path = config.RAW_CSV
    if not os.path.exists(csv_path):
        os.makedirs(os.path.dirname(csv_path), exist_ok=True)
        with zipfile.ZipFile(config.RAW_ZIP) as z:
            z.extract("ctrip_china_scenic_tickets.csv", os.path.dirname(csv_path))
    df = pd.read_csv(csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    df["ticket_type"] = df["ticket_type"].astype(int)
    return df


def build(force=False):
    """返回 (pois, products) 两个 DataFrame，结果缓存为 parquet。"""
    poi_cache = os.path.join(config.CACHE_DIR, "pois.parquet")
    prod_cache = os.path.join(config.CACHE_DIR, "products_clean.parquet")
    if not force and os.path.exists(poi_cache) and os.path.exists(prod_cache):
        return pd.read_parquet(poi_cache), pd.read_parquet(prod_cache)
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    df = load_raw()
    print(f"[catalog] raw rows={len(df)}")

    # 1) 剔除演唱会/话剧等非景区 POI
    perf = df["poi_name"].str.contains(_PERFORMANCE_RE)
    df = df[~perf].copy()
    print(f"[catalog] after removing performance POIs rows={len(df)}")

    # 2) 价格清洗
    df["ticket_price"] = pd.to_numeric(df["ticket_price"], errors="coerce")
    df = df[(df["ticket_price"] > 0) & (df["ticket_price"] < 50000)].copy()
    df["sales_volume"] = df["ticket_sales_volume"].map(parse_sales)
    df = df.drop_duplicates(["poi_id", "ticket_id"])
    print(f"[catalog] after price clean & dedup rows={len(df)}")

    # 3) POI 城市推断：名称权重 6，货架商品名 2，购买须知/费用包含 1
    city_score = {}
    for row in df[["poi_id", "poi_name", "ticket_name", "ticket_type", "purchase_notes", "cost_inclusion"]].itertuples(index=False):
        sc = city_score.setdefault(row.poi_id, {})
        w_name = 2 if row.ticket_type in SHELF_TYPES else 1
        for txt, w in ((row.ticket_name, w_name), (row.purchase_notes[:600], 1), (row.cost_inclusion[:300], 1)):
            for c, k in match_cities(txt).items():
                sc[c] = sc.get(c, 0) + w * k
    poi_names = df.groupby("poi_id")["poi_name"].first()
    poi_rows = []
    for pid, pname in poi_names.items():
        sc = dict(city_score.get(pid, {}))
        for c, k in match_cities(pname).items():
            sc[c] = sc.get(c, 0) + 6 * k
        if sc:
            city = max(sc.items(), key=lambda kv: kv[1])[0]
            conf = sc[city] / sum(sc.values())
        else:
            city, conf = None, 0.0
        poi_rows.append((pid, pname, city, round(conf, 3)))
    pois = pd.DataFrame(poi_rows, columns=["poi_id", "poi_name", "city", "city_confidence"])
    known = pois["city"].notna().mean()
    print(f"[catalog] POI city inferred ratio={known:.3f}")
    # 无法识别城市的 POI：按已识别 POI 的城市分布抽样填补，并打标
    rng = np.random.default_rng(config.SEED)
    dist = pois["city"].value_counts(normalize=True)
    miss = pois["city"].isna()
    pois.loc[miss, "city"] = rng.choice(dist.index.values, size=miss.sum(), p=dist.values)
    pois["city_source"] = np.where(miss, "imputed", "text_inferred")
    pois["province"] = pois["city"].map(lambda c: CITY[c]["province"])
    pois["lat"] = pois["city"].map(lambda c: CITY[c]["lat"]) + rng.normal(0, 0.12, len(pois))
    pois["lon"] = pois["city"].map(lambda c: CITY[c]["lon"]) + rng.normal(0, 0.12, len(pois))

    # 4) 景区类别
    prod_text = df[df["ticket_type"].isin(SHELF_TYPES)].groupby("poi_id")["ticket_name"].apply(lambda s: " ".join(s.head(20)))
    pois["category"] = [infer_category(n, prod_text.get(p, "")) for p, n in zip(pois["poi_id"], pois["poi_name"])]
    pois["indoor"] = pois["category"].isin(INDOOR_CATEGORIES)

    # 5) 热度：货架商品销量之和（取对数分档）
    shelf = df[df["ticket_type"].isin(SHELF_TYPES)]
    sales_sum = shelf.groupby("poi_id")["sales_volume"].sum(min_count=1)
    n_shelf = shelf.groupby("poi_id").size()
    pois["shelf_product_cnt"] = pois["poi_id"].map(n_shelf).fillna(0).astype(int)
    pois["shelf_sales_sum"] = pois["poi_id"].map(sales_sum).fillna(0)
    s = np.log1p(pois["shelf_sales_sum"])
    pois["popularity"] = np.clip((s / max(s.max(), 1)) * 0.85 + 0.15 * (pois["shelf_product_cnt"] > 0), 0.02, 1.0).round(4)
    # 景区等级（推断）：按热度分位
    q = pois["popularity"].rank(pct=True)
    pois["grade_inferred"] = np.select([q > 0.97, q > 0.85, q > 0.6, q > 0.3], ["5A", "4A", "3A", "2A"], "未评级")
    # 日最大承载量（推断）：与热度、类别相关
    base_cap = pois["category"].map({"主题乐园": 30000, "博物馆/展馆": 8000, "演艺/秀场": 4000, "历史遗迹": 25000,
                                     "山岳峡谷": 20000, "古镇古村": 30000}).fillna(15000)
    pois["daily_capacity"] = (base_cap * (0.15 + pois["popularity"] ** 2 * 1.6) / 100).round().astype(int) * 100
    pois["daily_capacity"] = pois["daily_capacity"].clip(lower=500)

    # 6) 商品属性
    df = df.merge(pois[["poi_id", "city", "province", "category"]], on="poi_id", how="left")
    text = df["ticket_name"] + " " + df["cost_inclusion"].str[:300]
    df["features"] = text.map(lambda t: "|".join(extract_features(t)))
    parsed = df["purchase_notes"].map(parse_notes).apply(pd.Series)
    df = pd.concat([df.reset_index(drop=True), parsed.reset_index(drop=True)], axis=1)
    df["ticket_type_name"] = df["ticket_type"].map(TYPE_NAME)

    pois.to_parquet(poi_cache, index=False)
    df.to_parquet(prod_cache, index=False)
    print(f"[catalog] pois={len(pois)} products={len(df)}")
    return pois, df


if __name__ == "__main__":
    build(force=True)
