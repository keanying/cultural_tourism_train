"""训练集①：票务产品组合推荐模型（combo_recommend）

场景：游客已购基础门票，模型从该景区【真实在售】的组合商品中挑选最契合的一款，生成加购种草话术。
真值来源：规则引擎（客群-特征匹配 + 预订时效/安全/预算/天气/权益重复 5 类硬约束），
         商品名称、价格、权益描述全部来自携程真实商品，话术只引用商品特征标签中存在的权益。
"""
import datetime as dt
import re

import numpy as np
import pandas as pd

from .. import config
from ..calendar_cn import all_dates, day_type, holiday_name, weather
from ..segments import FEATURE_AFFINITY
from .common import SftWriter, fmt_money, make_sample, num

TASK = "combo_recommend"

SYSTEM = (
    "你是景区票务金牌销售助手。你的任务是根据用户的画像，从给定的【当前可用库存列表】中挑选最合适的一款组合票，"
    "并生成极具吸引力的推荐话术。严禁推荐列表中不存在的产品，严禁编造价格或权益。\n"
    "决策规则：\n"
    "1. 预订时效：当前为游玩当日时，标注“可订明日/需提前N天”的产品无法使用，必须排除；\n"
    "2. 安全适配：同行有儿童或为银发游客时，排除刺激类项目；\n"
    "3. 权益重复：仅含基础入园的门票与已购门票重复，必须排除；\n"
    "4. 预算阈值（每人加购差价）：价格敏感度高≤max(30, 已购门票价×0.6)元，中≤max(80, 已购门票价×1.5)元，低不设限；\n"
    "5. 天气风险：中雨/大雨/雷阵雨/中雪天气排除刺激项目与游船类产品；\n"
    "6. 在剩余产品中选择与画像匹配度最高的一款；若全部被排除，则如实说明暂无合适加购产品，不做推荐。\n"
    "输出格式：<thought>内依次给出“分析用户画像”“遍历可用库存”“排除不匹配项”“确定推荐项”“构思话术”五个步骤，"
    "<answer>内输出面向用户的推荐文案。"
)

NEEDS = {
    "亲子游": "孩子容易觉得枯燥、家长带娃辛苦，希望寓教于乐、省心省力",
    "情侣游": "想要仪式感和高出片率，希望避开人挤人、留下浪漫回忆",
    "朋友结伴": "追求刺激和新鲜感，看重性价比和拍照分享",
    "独自旅行": "希望深度了解当地文化，行程要省心、交通要便利",
    "银发游": "体力有限怕走太多路，需要舒适省力、讲解清楚",
    "家庭多代游": "需要兼顾老人和孩子，行程不折腾、少排队",
    "商务差旅": "时间紧张，追求高效游览、免排队",
    "学生游": "预算有限，想多玩几个点、拍照打卡",
}
HOOKS = {
    "亲子游": ["带娃出游最怕孩子喊无聊、家长累到瘫？", "想让孩子玩得开心又能学到东西？", "遛娃不想只是走马观花？"],
    "情侣游": ["想给这趟约会多一点仪式感？", "两个人的旅行，怎么能少了好看的照片和难忘的体验？", "不想和人潮挤在一起，想要只属于你们的浪漫？"],
    "朋友结伴": ["和朋友出来玩，就要玩得尽兴！", "光逛景点太单调？和兄弟姐妹来点不一样的！", "朋友局想玩点有意思的？"],
    "独自旅行": ["一个人旅行，更值得把每一处看懂看透。", "独自出行，最怕行程折腾、看不出门道？", "一个人的深度游，从这一步开始。"],
    "银发游": ["带着长辈出游，最怕他们走累了？", "爸妈出来玩，舒服省力最重要！", "长辈们想好好看风景，又怕体力跟不上？"],
    "家庭多代游": ["一家老小一起出游，最怕顾此失彼？", "全家出动，老人孩子都要照顾到？", "三代同游，想让每个人都玩得舒服？"],
    "商务差旅": ["出差间隙时间宝贵，想高效打卡？", "行程紧凑，不想把时间浪费在排队上？", "难得抽空游览，想效率和体验兼得？"],
    "学生游": ["学生党预算有限，也想玩得值？", "想用最少的钱解锁更多玩法？", "学生出游，性价比和出片率都要有！"],
}
BENEFITS = {
    "含讲解": ["有专业讲解带队，每一处细节背后的故事都能听明白", "跟着讲解看门道，比自己逛收获多得多", "有讲解服务，不再走马观花"],
    "含交通": ["交通接驳已包含，不用操心换乘和停车", "交通一站式解决，下车即玩", "省去自己找路、等车的麻烦"],
    "含索道缆车": ["登高交通已包含，省去大段爬坡的体力消耗", "不用一步步爬上去，轻松直达观景点"],
    "含游船": ["还能乘船游览，换个视角看风景", "水上游览体验已包含，风光尽收眼底"],
    "含餐饮": ["餐饮已一并安排，玩累了随时补充能量", "吃的也帮你安排好了，不用再到处找吃的"],
    "含演出": ["还能看一场演出，让行程更有记忆点", "游览之外再加一场演出，体验更完整"],
    "含住宿": ["住宿一并打包，行程更从容", "含住宿安排，不用再另外比价订房"],
    "亲子儿童": ["专为亲子设计的互动内容，孩子玩得投入", "亲子互动环节多，小朋友不会喊无聊"],
    "研学教育": ["动手体验+知识学习，寓教于乐", "把课本知识变成亲手体验，玩中学"],
    "夜游": ["夜色下的景区别有一番韵味", "解锁夜游玩法，看到和白天完全不同的风景"],
    "摄影写真": ["拍照体验出片率超高", "专属拍照体验，朋友圈素材一次拍够"],
    "刺激项目": ["刺激项目让心跳加速，玩得过瘾", "解锁刺激体验，和小伙伴一起尖叫"],
    "温泉康养": ["泡汤放松，缓解一路的疲惫", "温泉康养体验，身心都得到放松"],
    "快速通道": ["专属通道少排队，把时间留给游玩", "免去排长队的烦恼，效率翻倍"],
    "多景点": ["一次打包多个景点，路线更完整", "多点位联玩，比单独购买更省心"],
}
CTA = ["名额有限，建议现在就加购！", "现在下单即可锁定，别等到现场再后悔～", "趁库存还在，赶紧安排上！",
       "点击加购，让这趟旅程更完整！", "心动不如行动，现在就升级吧！"]
ADDON_TYPES = {2, 3, 4, 5, 6, 7, 8}
BAD_WEATHER = {"中雨", "大雨", "雷阵雨", "中雪"}
_ENTRY_RE = re.compile(r"门票|入园|首道|大门|联票|套票|通票|全票|年卡|一票")


def _desc(row) -> str:
    parts = []
    inc = str(row["cost_inclusion"] or "")
    name = str(row["product_name"])
    if inc.startswith(name):
        inc = inc[len(name):]
    segs = [s.strip(" ；;，,。") for s in re.split(r"[；;\n]", inc)]
    segs = [s for s in segs if s and not re.search(r"个人消费|未提及|不含|自理|保险", s) and len(s) >= 2]
    if segs:
        parts.append("、".join(segs[:2])[:40])
    feats = [f for f in str(row["feature_tags"] or "").split("|") if f]
    if feats:
        parts.append("特色：" + "、".join(feats[:4]))
    if row["refund_policy"] != "未说明":
        parts.append(row["refund_policy"])
    if row["booking_advance"] != "未说明":
        parts.append(row["booking_advance"])
    return "；".join(parts) if parts else str(row["ticket_type_name"])


def _includes_entry(row) -> bool:
    return row["ticket_type"] in (2, 7) or bool(_ENTRY_RE.search(str(row["product_name"])))


def _party_desc(v) -> str:
    s = v["party_structure"]
    if v["children"] and not pd.isna(v["child_age"]):
        s += f"（孩子{int(v['child_age'])}岁）"
    return s


def evaluate(cands, base_price, v, wx, same_day):
    """对每个候选返回 (score, matched, negatives, exclude_reason, upsell)。"""
    seg = v["travel_type"]
    sens = v["price_sensitivity"]
    aff = FEATURE_AFFINITY[seg]
    budget = {"高": max(30.0, base_price * 0.6), "中": max(80.0, base_price * 1.5)}.get(sens)
    res = []
    for p in cands:
        feats = p["_feats"]
        pos = [f for f in feats if aff.get(f, 0) > 0]
        neg = [f for f in feats if aff.get(f, 0) < 0]
        score = round(sum(aff.get(f, 0) for f in feats), 1)
        upsell = round(float(p["list_price"]) - base_price, 2) if p["_entry"] else round(float(p["list_price"]), 2)
        reason = None
        if same_day and p["booking_advance"] in ("可订明日",) or (same_day and str(p["booking_advance"]).startswith("需提前")):
            reason = f"标注“{p['booking_advance']}”，用户为游玩当日加购，无法使用"
        elif "刺激项目" in feats and (v["children"] > 0 or seg == "银发游" or v["seniors"] > 0):
            who = "同行有儿童" if v["children"] > 0 else "同行有长者"
            reason = f"含刺激项目，{who}，存在安全适配问题"
        elif p["_base_like"]:
            reason = "仅含基础入园，与已购门票权益重复"
        elif budget is not None and upsell > budget:
            reason = f"每人加购差价{fmt_money(upsell)}元，超过价格敏感度“{sens}”的阈值{fmt_money(budget)}元"
        elif wx["weather"] in BAD_WEATHER and ("刺激项目" in feats or "含游船" in feats):
            reason = f"当日天气为{wx['weather']}，{'游船' if '含游船' in feats else '刺激'}类项目存在停运风险"
        elif score <= 0:
            reason = "未命中该客群任何偏好特征" if not neg else f"含{'、'.join(neg)}等与该客群偏好相悖的特征"
        res.append({"score": score, "pos": pos, "neg": neg, "reason": reason, "upsell": upsell, "feats": feats})
    return res


def _level(score):
    return "高" if score >= 3 else ("中" if score >= 1 else ("低" if score > 0 else "不匹配"))


def build(product_detail: pd.DataFrame, profiles: pd.DataFrame, n_samples: int = None):
    n_samples = n_samples or config.SFT_SAMPLES
    rng = np.random.default_rng(config.SEED + 101)
    pdf = product_detail[~product_detail["product_name"].str.contains("默认货架", na=False)].copy()
    pdf["_entry"] = pdf.apply(_includes_entry, axis=1)
    pdf["_base_like"] = pdf["is_base_ticket"] | ((pdf["ticket_type"] == 1) & (pdf["feature_tags"].fillna("") == ""))
    pdf["_feats"] = pdf["feature_tags"].fillna("").map(lambda s: [f for f in s.split("|") if f])
    base = pdf[pdf["is_base_ticket"]].sort_values("sales_volume", ascending=False).drop_duplicates("poi_id")
    addons = pdf[pdf["ticket_type"].isin(ADDON_TYPES | {1})].copy()
    addons["_desc"] = addons.apply(_desc, axis=1)
    groups = {k: g.to_dict("records") for k, g in addons.groupby("poi_id")}
    pois = [pid for pid in base["poi_id"] if pid in groups and len(groups[pid]) >= 3]
    base = base.set_index("poi_id").loc[pois].to_dict("index")
    print(f"[recommend] eligible POIs={len(pois)}")
    dates = all_dates()
    prof = profiles.to_dict("records")
    writer = SftWriter(TASK)
    stats = {"no_recommend": 0}
    i = 0
    while writer.n < n_samples:
        i += 1
        pid = pois[rng.integers(len(pois))]
        b = base[pid]
        b["poi_id"] = pid
        g = [x for x in groups[pid] if x["product_id"] != b["product_id"]]
        v = prof[rng.integers(len(prof))]
        visit = dates[rng.integers(len(dates))]
        same_day = rng.random() < 0.4
        wx = weather(b["city"], visit)
        k = int(min(len(g), rng.integers(3, 6)))
        # 保证候选集中有“与客群匹配”的商品（若有），其余随机
        aff = FEATURE_AFFINITY[v["travel_type"]]
        fit = np.array([sum(aff.get(f, 0) for f in x["_feats"]) > 0 for x in g])
        idx = []
        if fit.any() and rng.random() < 0.92:
            idx.append(int(rng.choice(np.flatnonzero(fit))))
        rest = [j for j in range(len(g)) if j not in idx]
        idx += list(rng.choice(rest, size=k - len(idx), replace=False))
        rng.shuffle(idx)
        # 组合票价格低于已购门票的不合理候选剔除
        cands = [g[j] for j in idx
                 if not (g[j]["_entry"] and g[j]["list_price"] <= b["list_price"] and not g[j]["_base_like"])]
        if len(cands) < 3:
            continue
        base_price = float(b["list_price"])
        ev = evaluate(cands, base_price, v, wx, same_day)
        ok = [j for j, e in enumerate(ev) if e["reason"] is None]
        if not ok:
            if rng.random() > 0.03:  # 控制“无推荐”样本占比约 3%~5%
                continue
        best = max(ok, key=lambda j: (ev[j]["score"], -ev[j]["upsell"])) if ok else None

        # ---------- 输入 ----------
        src = v["source_province"] if v["source_province"] == v["source_city"] else f"{v['source_province']}{v['source_city']}"
        user_obj = {
            "user_profile": {
                "来源地": src, "年龄": int(v["age"]), "性别": v["gender"], "出游类型": v["travel_type"],
                "同行人员": _party_desc(v), "价格敏感度": v["price_sensitivity"],
                "兴趣标签": v["interest_tags"].split("|"),
            },
            "scenic_spot": {
                "名称": b["poi_name"], "城市": b["city"], "游玩日期": visit.isoformat(),
                "日期类型": holiday_name(visit) or day_type(visit),
                "天气": f"{wx['weather']} {wx['temp_low']}~{wx['temp_high']}℃",
                "当前时间": "游玩当日" if same_day else f"游玩前{int(rng.integers(1, 4))}天",
            },
            "purchased_ticket": {"id": b["product_id"], "name": b["product_name"], "price": num(base_price)},
            "available_products": [
                {"id": r["product_id"], "name": r["product_name"], "price": num(r["list_price"]), "desc": r["_desc"]}
                for r in cands
            ],
        }
        # ---------- 思维链 ----------
        seg = v["travel_type"]
        ctx = []
        if wx["weather"] in BAD_WEATHER:
            ctx.append(f"当日{wx['weather']}，优先考虑不受天气影响的项目")
        elif wx["weather"] == "晴热高温":
            ctx.append(f"当日高温{wx['temp_high']}℃，宜减少暴晒")
        if day_type(visit) == "法定节假日":
            ctx.append("节假日客流大，排队时间长")
        th = [
            f"1. 分析用户画像：来自{src}的{int(v['age'])}岁{v['gender']}性游客，出游类型为{seg}，同行人员：{_party_desc(v)}，"
            f"价格敏感度{v['price_sensitivity']}。核心诉求：{NEEDS[seg]}。"
            + (f"情境因素：{'；'.join(ctx)}。" if ctx else "")
            + f"已购{b['product_name']}（{fmt_money(base_price)}元）。",
            "2. 遍历可用库存：",
        ]
        for r, e in zip(cands, ev):
            hit = f"命中偏好特征「{'、'.join(e['pos'])}」" if e["pos"] else "未命中偏好特征"
            if e["neg"]:
                hit += f"，含不利特征「{'、'.join(e['neg'])}」"
            way = f"加购差价{fmt_money(e['upsell'])}元/人" if r["_entry"] and not r["_base_like"] else f"加购价{fmt_money(e['upsell'])}元/人"
            th.append(f"   - {r['product_id']}（{r['product_name']}，{fmt_money(r['list_price'])}元）：{hit}，匹配度{_level(e['score'])}（{e['score']}分），{way}。")
        th.append("3. 排除不匹配项：")
        for r, e in zip(cands, ev):
            if e["reason"]:
                th.append(f"   - 排除{r['product_id']}：{e['reason']}。")
        for j in ok:
            if j != best:
                r = cands[j]
                th.append(f"   - 次选{r['product_id']}：符合约束，但匹配度（{ev[j]['score']}分）低于最优项（{ev[best]['score']}分）。")
        if best is None:
            th.append("4. 确定推荐项：全部候选均被排除，暂无合适的加购产品，不做推荐。")
            th.append("5. 构思话术：如实告知暂无合适加购项，给出不依赖加购产品的游玩建议，避免强推。")
            tips = []
            if wx["weather"] in BAD_WEATHER:
                tips.append(f"今天有{wx['weather']}，记得带好雨具，注意防滑")
            elif wx["weather"] == "晴热高温":
                tips.append("今天气温较高，注意防晒补水")
            if day_type(visit) == "法定节假日":
                tips.append("节假日人多，建议错峰游览")
            tips.append(f"用好您已购的{b['product_name']}，祝您玩得开心")
            answer = f"结合您的出行情况，目前在售的加购产品暂时都不太适合您这次行程，就不给您硬推啦。{'；'.join(tips)}！"
            stats["no_recommend"] += 1
            gt = None
        else:
            r = cands[best]
            e = ev[best]
            th.append(f"4. 确定推荐项：{r['product_id']}（{r['product_name']}）。"
                      + (f"在已购门票{fmt_money(base_price)}元基础上，每人补差价{fmt_money(e['upsell'])}元即可升级。" if r["_entry"]
                         else f"每人加购价{fmt_money(e['upsell'])}元。"))
            sel = sorted(e["pos"], key=lambda f: -aff.get(f, 0))[:3]
            th.append(f"5. 构思话术：切入点「{NEEDS[seg].split('，')[0]}」→ 卖点「{'、'.join(sel)}」→ "
                      f"情境「{'；'.join(ctx) if ctx else '常规出游'}」→ 价格锚点「{fmt_money(e['upsell'])}元」→ 行动号召。")
            # ---------- 话术 ----------
            hook = HOOKS[seg][rng.integers(len(HOOKS[seg]))]
            bens = [BENEFITS[f][rng.integers(len(BENEFITS[f]))] for f in sel]
            lead = rng.choice(["强烈推荐", "给您推荐", "这款", "一定要看看"])
            name = r["product_name"]
            body = (f"{lead}「{name}」！" if lead != "这款" else f"这款「{name}」正适合您！") + "，".join(bens) + "。"
            extra = ""
            if wx["weather"] in BAD_WEATHER and not ({"刺激项目", "含游船"} & set(e["feats"])):
                extra = f"今天{wx['weather']}，有了这些安排，游玩体验不打折。"
            elif wx["weather"] == "晴热高温" and ("含交通" in e["feats"] or "含索道缆车" in e["feats"]):
                extra = f"今天最高{wx['temp_high']}℃，少走路少暴晒，体力留给好风景。"
            elif day_type(visit) == "法定节假日" and "快速通道" in e["feats"]:
                extra = "节假日人多，省下的排队时间就是赚到的游玩时间。"
            if r["_entry"]:
                price_s = rng.choice([f"在您已购门票的基础上，每人只需补差价{fmt_money(e['upsell'])}元就能升级。",
                                      f"已买门票的您，升级只需每人再加{fmt_money(e['upsell'])}元。"])
            else:
                price_s = rng.choice([f"每人加购仅需{fmt_money(e['upsell'])}元。", f"只需每人再花{fmt_money(e['upsell'])}元就能拥有。"])
            answer = hook + body + extra + price_s + CTA[rng.integers(len(CTA))]
            gt = r["product_id"]
        sid = f"{TASK}-{writer.n + 1:07d}"
        meta = {"gt_product_id": gt, "candidate_ids": [c["id"] for c in user_obj["available_products"]],
                "excluded": {cands[j]["product_id"]: ev[j]["reason"] for j in range(len(ev)) if ev[j]["reason"]},
                "scores": {cands[j]["product_id"]: ev[j]["score"] for j in range(len(ev))},
                "poi_id": pid, "visitor_id": v["visitor_id"], "travel_type": seg,
                "upsell_price": ev[best]["upsell"] if best is not None else None, "source": "rule_engine"}
        writer.add(sid, make_sample(SYSTEM, user_obj, th, answer), meta)
    info = writer.close()
    info["stats"] = stats
    return info
