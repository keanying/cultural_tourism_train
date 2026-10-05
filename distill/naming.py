"""客户数仓命名规范映射（单一事实来源）。

规范要点：
  - 表名：分层_业务域_实体名_粒度，代码中使用 库.表（如 dwd.dwd_ord_attraction_ticket_order_di）
  - 字段：snake_case，实体_属性；关键字后缀 _code/_no/_name/_type/_status/_date/_time/_amt/_qty/_rate
  - 类型/状态/等级类字段统一编码，注释中写明每个取值的含义（如 1-已核销 2-已退款）
  - 表与字段必须有注释；分区字段统一为 travel_date（YYYYMMDD）
  - 不使用拼音

内部生成代码沿用原字段名，输出（CSV、DDL、SQLite、数据字典）统一经本模块转换。
"""
import pandas as pd

# ---------------------------------------------------------------- 枚举定义（编码 -> 含义）
ENUMS = {
    "attraction_category": ["主题乐园", "动物园/海洋馆", "博物馆/展馆", "演艺/秀场", "温泉度假", "古镇古村", "宗教寺观",
                            "历史遗迹", "滨海海岛", "湖泊水域", "山岳峡谷", "自然生态", "城市地标"],
    "attraction_heat": ["5A", "4A", "3A", "2A", "未评级"],
    "ticket_type": ["景点门票", "门票套餐", "官方服务", "研学体验", "讲解服务", "直通车", "景点联票", "项目体验", "一日游",
                    "当地特色", "跟团司导"],
    "refund_policy": {0: "未说明", 1: "随时退", 2: "有条件退", 3: "不可退"},
    "entry_method": {0: "未说明", 1: "电子凭证直接入园", 2: "需换票/集合"},
    "ticket_issue": {0: "未说明", 1: "立即出票", 2: "1小时内出票", 3: "大于1小时出票"},
    "data_source": ["携程真实商品+规则派生字段"],
    "gender": ["男", "女"],
    "city_level": ["1线", "2线", "3线", "4线及以下"],
    "income_level": ["低", "中", "中高", "高"],
    "price_sensitivity": ["低", "中", "高"],
    "member_level": ["普通会员", "银卡", "金卡", "铂金卡"],
    "booking_lead": ["当天", "1-3天", "4-7天", "7天以上"],
    "device": ["iOS", "Android", "小程序", "PC"],
    "value_level": {0: "未消费", 1: "低价值", 2: "中价值", 3: "高价值"},
    "traveler_segment": ["亲子游", "情侣游", "朋友结伴", "独自旅行", "银发游", "家庭多代游", "商务差旅", "学生游"],
    "sales_channel": ["携程", "美团", "飞猪", "抖音团购", "小红书", "同程旅行", "景区官网/小程序", "线下窗口", "旅行社分销"],
    "sales_channel_type": ["OTA", "内容电商", "内容种草", "自营直销", "线下", "B2B分销"],
    "order_status": ["已核销", "已退款", "已过期未使用"],
    "refund_reason": {0: "无", 1: "天气原因", 2: "行程变更", 3: "价格原因", 4: "重复购买", 5: "临时有事"},
    "pay_method": ["微信支付", "支付宝", "银行卡", "信用卡", "花呗/分期"],
    "weather": ["晴", "多云", "阴", "雾霾", "晴热高温", "小雨", "雷阵雨", "中雨", "大雨", "小雪", "中雪"],
    "day_type": ["工作日", "周末", "法定节假日", "调休工作日"],
    "transport": ["飞机", "高铁", "大巴", "自驾", "打车", "地铁/公交", "景区直通车", "步行/骑行"],
    "trip_type": ["省内周边游", "跨省游"],
    "entry_type": ["线上订单", "现场购票/免费游览"],
    "school_holiday": {0: "非寒暑假", 1: "寒假", 2: "暑假"},
    "season": ["平季", "暑期旺季", "冬季淡季", "春秋旺季", "秋季旺季", "寒假平季", "春节黄金周", "国庆黄金周", "五一小长假",
               "清明节小长假", "端午节小长假", "中秋节小长假", "元旦小长假"],
    "week_day": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    "yes_no": {0: "否", 1: "是"},
    "rating": ["很差", "较差", "一般", "满意", "非常满意"],
}
# 列表形式 = 从 1 开始编码
ENUMS = {k: (v if isinstance(v, dict) else {i + 1: x for i, x in enumerate(v)}) for k, v in ENUMS.items()}

SEGMENT_EN = {"亲子游": "family", "情侣游": "couple", "朋友结伴": "friends", "独自旅行": "solo", "银发游": "senior",
              "家庭多代游": "multigen", "商务差旅": "business", "学生游": "student"}


def enum_comment(key: str) -> str:
    return " ".join(f"{k}-{v}" for k, v in ENUMS[key].items())


# ---------------------------------------------------------------- 字段转换辅助
def _enc(key, col, empty_code=None):
    inv = {v: k for k, v in ENUMS[key].items()}

    def f(df):
        s = df[col].fillna("")
        if empty_code is not None:
            s = s.replace("", ENUMS[key][empty_code])
        out = s.map(inv)
        bad = out.isna() & (s != "")
        if bad.any():
            raise ValueError(f"枚举 {key} 出现未定义取值：{s[bad].unique()[:5]}")
        return out.astype("Int64")
    f.col = col
    return f


def _bool(col):
    def f(df):
        return df[col].map(lambda v: 1 if v in (True, 1, "True", "true") else 0).astype("Int64")
    f.col = col
    return f


def _advance_days(df):
    def conv(s):
        if s == "可订今日":
            return 0
        if s == "可订明日":
            return 1
        if isinstance(s, str) and s.startswith("需提前"):
            return int(s[3:-1])
        return None
    return df["booking_advance"].map(conv).astype("Int64")


_advance_days.col = "booking_advance"


def _ymd(col):
    def f(df):
        return df[col].astype(str).str.replace("-", "", regex=False).str[:8]
    f.col = col
    return f


def _const(v):
    return lambda df: pd.Series([v] * len(df), index=df.index)


def F(name, typ, comment, src=None, enum=None):
    """字段定义：name 新字段名，typ 类型（STRING/BIGINT/DOUBLE），src 原字段名或函数，enum 枚举键（自动追加取值说明）。"""
    if enum:
        comment = f"{comment}：{enum_comment(enum)}"
    return {"name": name, "type": typ, "comment": comment, "src": src if src is not None else name, "enum": enum}


def _attraction(prefix_cols=("poi_id", "poi_name", "province", "city", "scenic_category")):
    pid, pname, prov, city, cat = prefix_cols
    return [
        F("attraction_id", "STRING", "景区ID（携程景区POI编号）", pid),
        F("attraction_name", "STRING", "景区名称", pname),
        F("attraction_province_name", "STRING", "景区所在省份（由商品文本推断）", prov),
        F("attraction_city_name", "STRING", "景区所在城市（由商品文本推断）", city),
        F("attraction_category_type", "BIGINT", "景区类别编码", _enc("attraction_category", cat), "attraction_category"),
        F("attraction_category_name", "STRING", "景区类别名称", cat),
    ]


def _ticket_type_from_name(col):
    return _enc("ticket_type", col)


SEG_RATE = [F(f"segment_{en}_rate", "DOUBLE", f"{zh}客群占比（0-1）", f"seg_share_{zh}") for zh, en in SEGMENT_EN.items()]

# ---------------------------------------------------------------- 表定义
TABLES = {
    "scenic_product_detail": {
        "db": "dim", "table": "dim_prd_attraction_ticket_df",
        "title": "景区产品详情数据集",
        "comment": "景区门票产品维表（天级全量快照）：携程在售景区门票/套餐/服务商品及解析、派生属性",
        "partition": ("快照日期（商品采集日）", _const("20260905")),
        "fields": [
            F("prd_id", "STRING", "产品ID（交付主键）", "product_id"),
            F("ota_ticket_no", "STRING", "OTA（携程）商品/资源编号", "source_ticket_id"),
            *_attraction(),
            F("attraction_heat_level", "BIGINT", "景区热度等级（按销量分位推断，非官方A级）", _enc("attraction_heat", "scenic_grade_inferred"), "attraction_heat"),
            F("ticket_type", "BIGINT", "票类型编码", "ticket_type", "ticket_type"),
            F("ticket_type_name", "STRING", "票类型名称"),
            F("prd_name", "STRING", "产品名称（携程原始商品名）", "product_name"),
            F("list_price_amt", "DOUBLE", "展示价/起价（元）", "list_price"),
            F("sales_qty", "BIGINT", "销量（展示文本解析的下限值）", "sales_volume"),
            F("sales_raw_desc", "STRING", "销量原始展示文本（如“月销600+份”）", "sales_volume_raw"),
            F("is_base_ticket", "BIGINT", "是否基础门票", _bool("is_base_ticket"), "yes_no"),
            F("feature_tags", "STRING", "产品特征标签（多值以|分隔，15类：含讲解/含交通/亲子儿童等）"),
            F("target_segment_tags", "STRING", "适配客群（特征-客群偏好打分Top2，多值以|分隔）", "target_segments"),
            F("applicable_crowd_tags", "STRING", "适用人群（成人/儿童/学生/老人/亲子/家庭，多值以|分隔；不限=无限制）", "applicable_crowd"),
            F("play_duration_desc", "STRING", "游玩/活动时长（小时，可能为区间如1-1.5）", "duration_hours"),
            F("booking_advance_day_qty", "BIGINT", "需提前预订天数：0-可订今日 1-可订明日 N-需提前N天 空-未说明", _advance_days),
            F("refund_policy_type", "BIGINT", "退改政策", _enc("refund_policy", "refund_policy"), "refund_policy"),
            F("entry_method_type", "BIGINT", "入园方式", _enc("entry_method", "entry_method"), "entry_method"),
            F("ticket_issue_type", "BIGINT", "出票速度", _enc("ticket_issue", "ticket_issue_speed"), "ticket_issue"),
            F("is_id_card_required", "BIGINT", "是否需要有效证件", _bool("need_id_card"), "yes_no"),
            F("cost_price_amt", "DOUBLE", "成本价（元，按票类型成本率区间派生）", "cost_price"),
            F("floor_price_amt", "DOUBLE", "最低保底价（元）", "floor_price"),
            F("ceiling_price_amt", "DOUBLE", "最高限价（元）", "ceiling_price"),
            F("premium_rate", "DOUBLE", "溢价系数（动态定价上调倍数）", "premium_coef"),
            F("discount_rate", "DOUBLE", "折扣系数（动态定价下调倍数）", "discount_coef"),
            F("daily_inventory_qty", "BIGINT", "日库存（张）", "daily_inventory"),
            F("cost_inclusion_desc", "STRING", "费用包含（携程原文）", "cost_inclusion"),
            F("purchase_notes_desc", "STRING", "购买须知（携程原文）", "purchase_notes"),
            F("data_source_type", "BIGINT", "数据来源", _const(1), "data_source"),
        ],
    },
    "visitor_profile": {
        "db": "dws", "table": "dws_cus_traveler_profile_df",
        "title": "景区游客画像数据集",
        "comment": "游客画像宽表（天级全量快照）：游客基础属性、偏好与消费汇总（虚拟ID，无真实个人信息）",
        "partition": ("快照日期（画像统计截止日）", _const("20251231")),
        "fields": [
            F("traveler_id", "STRING", "游客ID", "visitor_id"),
            F("gender_type", "BIGINT", "性别", _enc("gender", "gender"), "gender"),
            F("traveler_age", "BIGINT", "年龄（周岁）", "age"),
            F("age_range_name", "STRING", "年龄段（如25-29、60+）", "age_band"),
            F("home_province_name", "STRING", "客源省份", "source_province"),
            F("home_city_name", "STRING", "客源城市", "source_city"),
            F("home_city_level", "BIGINT", "客源城市等级", _enc("city_level", "city_tier"), "city_level"),
            F("traveler_segment_type", "BIGINT", "出游客群编码", _enc("traveler_segment", "travel_type"), "traveler_segment"),
            F("traveler_segment_name", "STRING", "出游客群名称", "travel_type"),
            F("companion_desc", "STRING", "同行结构描述（如2大1小）", "party_structure"),
            F("adult_qty", "BIGINT", "同行成人数", "adults"),
            F("child_qty", "BIGINT", "同行儿童数", "children"),
            F("senior_qty", "BIGINT", "同行长者数", "seniors"),
            F("child_age", "BIGINT", "儿童年龄（无儿童为空）"),
            F("income_level", "BIGINT", "收入水平", _enc("income_level", "income_level"), "income_level"),
            F("price_sensitivity_level", "BIGINT", "价格敏感度", _enc("price_sensitivity", "price_sensitivity"), "price_sensitivity"),
            F("member_level", "BIGINT", "会员等级", _enc("member_level", "member_level"), "member_level"),
            F("preferred_channel_code", "BIGINT", "首选购票渠道", _enc("sales_channel", "preferred_channel"), "sales_channel"),
            F("secondary_channel_code", "BIGINT", "次选购票渠道", _enc("sales_channel", "secondary_channel"), "sales_channel"),
            F("booking_lead_type", "BIGINT", "提前预订习惯", _enc("booking_lead", "booking_lead_pref"), "booking_lead"),
            F("annual_trip_qty", "BIGINT", "年出游次数", "annual_trip_freq"),
            F("preferred_category_tags", "STRING", "偏好景区类别Top3（多值以|分隔）", "preferred_categories"),
            F("interest_tags", "STRING", "兴趣标签（多值以|分隔）"),
            F("device_type", "BIGINT", "常用终端", _enc("device", "device_type"), "device"),
            F("register_date", "STRING", "注册日期（YYYY-MM-DD）"),
            F("valid_order_qty", "BIGINT", "有效订单数（不含退款，由订单表回填）", "total_orders"),
            F("total_spend_amt", "DOUBLE", "累计消费金额（元）", "total_spend"),
            F("last_visit_date", "STRING", "最近到访日期（YYYY-MM-DD）"),
            F("favorite_province_name", "STRING", "最常去省份", "favorite_province"),
            F("avg_order_amt", "DOUBLE", "平均订单金额（元）", "avg_order_amount"),
            F("refund_order_qty", "BIGINT", "退款订单数", "refund_orders"),
            F("value_level", "BIGINT", "客户价值分层", _enc("value_level", "value_tier"), "value_level"),
        ],
    },
    "visitor_consumption": {
        "db": "dwd", "table": "dwd_ord_attraction_ticket_order_di",
        "title": "景区游客消费数据集",
        "comment": "景区门票订单明细天增量表：游客下单、支付、核销/退款与园内二次消费",
        "partition": ("游玩日期", _ymd("visit_date")),
        "fields": [
            F("order_no", "STRING", "订单编号", "order_id"),
            F("traveler_id", "STRING", "游客ID", "visitor_id"),
            F("trip_no", "STRING", "行程编号", "trip_id"),
            *_attraction(("poi_id", "poi_name", "poi_province", "poi_city", "scenic_category")),
            F("prd_id", "STRING", "产品ID", "product_id"),
            F("prd_name", "STRING", "产品名称", "product_name"),
            F("ticket_type", "BIGINT", "票类型编码", _ticket_type_from_name("ticket_type_name"), "ticket_type"),
            F("ticket_type_name", "STRING", "票类型名称"),
            F("sales_channel_code", "BIGINT", "购买渠道编码", _enc("sales_channel", "channel"), "sales_channel"),
            F("sales_channel_name", "STRING", "购买渠道名称", "channel"),
            F("order_time", "STRING", "下单时间（YYYY-MM-DD HH:MM:SS）"),
            F("visit_date", "STRING", "游玩日期（YYYY-MM-DD）"),
            F("booking_lead_day_qty", "BIGINT", "提前预订天数", "lead_days"),
            F("adult_qty", "BIGINT", "成人票数"),
            F("child_qty", "BIGINT", "儿童票数"),
            F("senior_qty", "BIGINT", "长者票数"),
            F("ticket_qty", "BIGINT", "总票数", "quantity"),
            F("unit_price_amt", "DOUBLE", "渠道成交单价（元）", "unit_price"),
            F("original_amt", "DOUBLE", "原价总额（元，门票类儿童/长者半价）", "original_amount"),
            F("coupon_amt", "DOUBLE", "优惠券金额（元）", "coupon_amount"),
            F("paid_amt", "DOUBLE", "实付金额（元）=原价总额-优惠券金额", "paid_amount"),
            F("pay_method_type", "BIGINT", "支付方式", _enc("pay_method", "payment_method"), "pay_method"),
            F("order_status", "BIGINT", "订单状态编码", _enc("order_status", "order_status"), "order_status"),
            F("order_status_name", "STRING", "订单状态名称", "order_status"),
            F("refund_reason_type", "BIGINT", "退款原因", _enc("refund_reason", "refund_reason", empty_code=0), "refund_reason"),
            F("refund_amt", "DOUBLE", "退款金额（元）", "refund_amount"),
            F("addon_prd_id", "STRING", "园内加购产品ID（组合推荐真实转化，空=未加购）", "addon_product_id"),
            F("addon_amt", "DOUBLE", "加购金额（元）", "addon_amount"),
            F("secondary_spend_amt", "DOUBLE", "园内二次消费金额（元）", "secondary_spend"),
            F("secondary_spend_desc", "STRING", "二次消费明细（项目:金额，以;分隔）", "secondary_detail"),
            F("total_spend_amt", "DOUBLE", "订单总消费（元）=实付+加购+二次消费，退款订单为0", "total_spend"),
            F("review_rating_level", "BIGINT", "游客评分（空=未评价）", "rating", "rating"),
            F("visit_weather_type", "BIGINT", "游玩日天气编码", _enc("weather", "visit_weather"), "weather"),
            F("visit_weather_name", "STRING", "游玩日天气名称", "visit_weather"),
            F("visit_day_type", "BIGINT", "游玩日日期类型编码", _enc("day_type", "visit_day_type"), "day_type"),
            F("visit_day_type_name", "STRING", "游玩日日期类型名称", "visit_day_type"),
            F("holiday_name", "STRING", "法定节假日名称（非节假日为空）"),
            F("traveler_segment_type", "BIGINT", "出游客群", _enc("traveler_segment", "travel_type"), "traveler_segment"),
            F("member_level", "BIGINT", "下单时会员等级", _enc("member_level", "member_level"), "member_level"),
        ],
    },
    "visitor_trajectory": {
        "db": "dwd", "table": "dwd_cus_traveler_trajectory_di",
        "title": "游客出行轨迹数据集",
        "comment": "游客出行轨迹明细天增量表：一行一个到访景区点（退款/未使用订单不产生轨迹）",
        "partition": ("到访日期", _ymd("visit_date")),
        "fields": [
            F("trajectory_no", "STRING", "轨迹点编号（行程编号-序号）", "trajectory_id"),
            F("trip_no", "STRING", "行程编号", "trip_id"),
            F("traveler_id", "STRING", "游客ID", "visitor_id"),
            F("trip_seq_no", "BIGINT", "行程内到访序号", "seq_no"),
            *_attraction(),
            F("attraction_lat", "DOUBLE", "景区纬度（城市中心加扰动，近似值）", "lat"),
            F("attraction_lon", "DOUBLE", "景区经度（近似值）", "lon"),
            F("visit_date", "STRING", "到访日期（YYYY-MM-DD）"),
            F("arrive_time", "STRING", "到达时间（YYYY-MM-DD HH:MM）"),
            F("leave_time", "STRING", "离开时间（YYYY-MM-DD HH:MM）"),
            F("stay_minute_qty", "BIGINT", "停留时长（分钟）", "stay_minutes"),
            F("transport_type", "BIGINT", "从上一点出发的交通方式", _enc("transport", "transport_from_prev"), "transport"),
            F("prev_leg_distance_km", "DOUBLE", "与上一点的距离（公里，首站为距出发城市）", "distance_from_prev_km"),
            F("origin_city_name", "STRING", "出发城市（仅首站填写）", "origin_city"),
            F("trip_type", "BIGINT", "行程类型", _enc("trip_type", "trip_type"), "trip_type"),
            F("trip_day_qty", "BIGINT", "行程天数", "trip_days"),
            F("weather_type", "BIGINT", "天气编码", _enc("weather", "weather"), "weather"),
            F("weather_name", "STRING", "天气名称", "weather"),
            F("high_temperature", "BIGINT", "最高气温（摄氏度）", "temp_high"),
            F("day_type", "BIGINT", "日期类型编码", _enc("day_type", "day_type"), "day_type"),
            F("day_type_name", "STRING", "日期类型名称", "day_type"),
            F("order_no", "STRING", "关联订单编号（空=现场购票/免费游览）", "order_id"),
            F("entry_type", "BIGINT", "入园方式", _enc("entry_type", "entry_type"), "entry_type"),
            F("traveler_segment_type", "BIGINT", "出游客群", _enc("traveler_segment", "travel_type"), "traveler_segment"),
        ],
    },
    "channel_distribution": {
        "db": "dws", "table": "dws_trf_attraction_channel_sales_mo",
        "title": "景区分销渠道数据集",
        "comment": "景区产品分渠道销售月汇总表：统计月×景区×产品×渠道的曝光、转化、销售、佣金、投放与客群结构",
        "partition": ("统计月份首日", lambda df: df["stat_month"].str.replace("-", "", regex=False) + "01"),
        "fields": [
            F("stat_month", "STRING", "统计月份（YYYY-MM）"),
            *_attraction(),
            F("prd_id", "STRING", "产品ID", "product_id"),
            F("prd_name", "STRING", "产品名称", "product_name"),
            F("ticket_type", "BIGINT", "票类型编码", _ticket_type_from_name("ticket_type_name"), "ticket_type"),
            F("ticket_type_name", "STRING", "票类型名称"),
            F("sales_channel_code", "BIGINT", "销售渠道编码", _enc("sales_channel", "channel"), "sales_channel"),
            F("sales_channel_name", "STRING", "销售渠道名称", "channel"),
            F("sales_channel_type", "BIGINT", "渠道类型", _enc("sales_channel_type", "channel_type"), "sales_channel_type"),
            F("list_price_amt", "DOUBLE", "产品标价（元）", "list_price"),
            F("channel_price_amt", "DOUBLE", "渠道售价（元）", "channel_price"),
            F("commission_rate", "DOUBLE", "渠道佣金率（0-1）"),
            F("exposure_qty", "BIGINT", "曝光量（线下窗口/旅行社分销为空）", "exposure"),
            F("click_qty", "BIGINT", "点击量", "clicks"),
            F("click_rate", "DOUBLE", "点击率=点击量/曝光量", "ctr"),
            F("order_qty", "BIGINT", "订单量", "orders"),
            F("conversion_rate", "DOUBLE", "转化率=订单量/点击量", "cvr"),
            F("ticket_sold_qty", "BIGINT", "售票张数", "tickets_sold"),
            F("gmv_amt", "DOUBLE", "成交总额GMV（元）", "gmv"),
            F("commission_amt", "DOUBLE", "佣金金额（元）", "commission_fee"),
            F("refund_order_qty", "BIGINT", "退款订单量", "refund_orders"),
            F("refund_rate", "DOUBLE", "退款率=退款订单量/订单量"),
            F("net_revenue_amt", "DOUBLE", "扣佣净收入（元）", "net_revenue"),
            F("marketing_spend_amt", "DOUBLE", "营销投放费用（元）", "marketing_spend"),
            F("roas_rate", "DOUBLE", "投放回报率ROAS=GMV/营销投放费用", "roas"),
            F("cpa_amt", "DOUBLE", "单订单获客成本（元）", "cpa"),
            F("new_customer_rate", "DOUBLE", "新客占比（0-1）", "new_customer_ratio"),
            F("avg_booking_lead_day_qty", "DOUBLE", "平均提前预订天数", "avg_lead_days"),
            F("main_segment_type", "BIGINT", "主力客群", _enc("traveler_segment", "main_segment"), "traveler_segment"),
            *SEG_RATE,
        ],
    },
    "scenic_daily_ops": {
        "db": "dws", "table": "dws_opr_attraction_operation_di",
        "title": "景区日度客流与运营数据（辅助表）",
        "comment": "景区日运营汇总天增量表：274个核心景区每日客流、预约进度、票价、收入、满意度及日历天气特征",
        "partition": ("统计日期", _ymd("date")),
        "fields": [
            F("stat_date", "STRING", "统计日期（YYYY-MM-DD）", "date"),
            *_attraction(),
            F("is_indoor", "BIGINT", "是否室内景区", _bool("is_indoor"), "yes_no"),
            F("week_day_no", "BIGINT", "星期", _enc("week_day", "weekday"), "week_day"),
            F("day_type", "BIGINT", "日期类型编码", _enc("day_type", "day_type"), "day_type"),
            F("day_type_name", "STRING", "日期类型名称", "day_type"),
            F("holiday_name", "STRING", "法定节假日名称（国务院放假安排，非节假日为空）"),
            F("school_holiday_type", "BIGINT", "寒暑假", _enc("school_holiday", "school_vacation", empty_code=0), "school_holiday"),
            F("season_type", "BIGINT", "业务季节", _enc("season", "season_label"), "season"),
            F("weather_type", "BIGINT", "天气编码", _enc("weather", "weather"), "weather"),
            F("weather_name", "STRING", "天气名称", "weather"),
            F("high_temperature", "BIGINT", "最高气温（摄氏度）", "temp_high"),
            F("low_temperature", "BIGINT", "最低气温（摄氏度）", "temp_low"),
            F("event_name", "STRING", "节庆活动名称（无活动为空）"),
            F("base_prd_id", "STRING", "基础门票产品ID", "base_product_id"),
            F("list_price_amt", "DOUBLE", "门票标价（元）", "list_price"),
            F("executed_price_amt", "DOUBLE", "当日执行票价（元）", "executed_price"),
            F("competitor_avg_price_amt", "DOUBLE", "周边竞品均价（元）", "competitor_avg_price"),
            F("daily_capacity_qty", "BIGINT", "日最大承载量（人）", "daily_capacity"),
            F("traveler_qty", "BIGINT", "实际入园人数", "visitors"),
            F("load_rate", "DOUBLE", "承载率=入园人数/日最大承载量"),
            F("is_sold_out", "BIGINT", "是否满载", _bool("is_sold_out"), "yes_no"),
            F("online_booking_qty", "BIGINT", "线上预约入园人数", "online_bookings"),
            F("offline_traveler_qty", "BIGINT", "线下购票入园人数", "offline_visitors"),
            F("booked_d7_qty", "BIGINT", "截至游玩日前7天累计线上预约人数", "booked_by_d7"),
            F("booked_d3_qty", "BIGINT", "截至游玩日前3天累计线上预约人数", "booked_by_d3"),
            F("booked_d1_qty", "BIGINT", "截至游玩日前1天累计线上预约人数", "booked_by_d1"),
            F("refund_order_qty", "BIGINT", "退款订单量", "refund_orders"),
            F("ticket_revenue_amt", "DOUBLE", "门票收入（元）", "ticket_revenue"),
            F("secondary_revenue_amt", "DOUBLE", "二次消费收入（元）", "secondary_revenue"),
            F("total_revenue_amt", "DOUBLE", "总收入（元）=门票收入+二次消费收入", "total_revenue"),
            F("avg_spend_amt", "DOUBLE", "人均消费（元）", "avg_spend_per_visitor"),
            F("marketing_spend_amt", "DOUBLE", "营销费用（元）", "marketing_spend"),
            F("satisfaction_score", "DOUBLE", "满意度均分（1-5）"),
            F("complaint_qty", "BIGINT", "投诉量", "complaint_count"),
        ],
    },
}

# 字段来源标记（数据字典“来源”列）：真实=携程采集原值 解析=由真实文本规则解析 推断=由真实数据推断
# 派生=基于真实值按业务规则计算 仿真=按业务逻辑统计仿真生成
ORIGIN = {
    'scenic_product_detail': {"product_id": "派生", "source_ticket_id": "真实", "poi_id": "真实", "poi_name": "真实", "province": "推断", "city": "推断", "scenic_category": "推断", "scenic_grade_inferred": "推断", "ticket_type": "真实", "ticket_type_name": "真实", "product_name": "真实", "list_price": "真实", "sales_volume": "解析", "sales_volume_raw": "真实", "is_base_ticket": "解析", "feature_tags": "解析", "target_segments": "派生", "applicable_crowd": "解析", "duration_hours": "解析", "booking_advance": "解析", "refund_policy": "解析", "entry_method": "解析", "ticket_issue_speed": "解析", "need_id_card": "解析", "cost_price": "派生", "floor_price": "派生", "ceiling_price": "派生", "premium_coef": "派生", "discount_coef": "派生", "daily_inventory": "派生", "cost_inclusion": "真实", "purchase_notes": "真实", "data_source": "派生"},
    'visitor_profile': {"visitor_id": "仿真", "gender": "仿真", "age": "仿真", "age_band": "仿真", "source_province": "仿真", "source_city": "仿真", "city_tier": "仿真", "travel_type": "仿真", "party_structure": "仿真", "adults": "仿真", "children": "仿真", "seniors": "仿真", "child_age": "仿真", "income_level": "仿真", "price_sensitivity": "仿真", "member_level": "仿真", "preferred_channel": "仿真", "secondary_channel": "仿真", "booking_lead_pref": "仿真", "annual_trip_freq": "仿真", "preferred_categories": "仿真", "interest_tags": "仿真", "device_type": "仿真", "register_date": "仿真", "total_orders": "仿真", "total_spend": "仿真", "last_visit_date": "仿真", "favorite_province": "仿真", "avg_order_amount": "仿真", "refund_orders": "仿真", "value_tier": "仿真"},
    'visitor_consumption': {"order_id": "仿真", "visitor_id": "仿真", "trip_id": "仿真", "poi_id": "真实", "poi_name": "真实", "poi_province": "推断", "poi_city": "推断", "scenic_category": "推断", "product_id": "派生", "product_name": "真实", "ticket_type_name": "真实", "channel": "仿真", "order_time": "仿真", "visit_date": "仿真", "lead_days": "仿真", "adult_qty": "仿真", "child_qty": "仿真", "senior_qty": "仿真", "quantity": "仿真", "unit_price": "仿真", "original_amount": "仿真", "coupon_amount": "仿真", "paid_amount": "仿真", "payment_method": "仿真", "order_status": "仿真", "refund_reason": "仿真", "refund_amount": "仿真", "addon_product_id": "仿真", "addon_amount": "仿真", "secondary_spend": "仿真", "secondary_detail": "仿真", "total_spend": "仿真", "rating": "仿真", "visit_weather": "仿真", "visit_day_type": "仿真", "holiday_name": "真实", "travel_type": "仿真", "member_level": "仿真"},
    'visitor_trajectory': {"trajectory_id": "仿真", "trip_id": "仿真", "visitor_id": "仿真", "seq_no": "仿真", "poi_id": "真实", "poi_name": "真实", "province": "推断", "city": "推断", "scenic_category": "推断", "lat": "仿真", "lon": "仿真", "visit_date": "仿真", "arrive_time": "仿真", "leave_time": "仿真", "stay_minutes": "仿真", "transport_from_prev": "仿真", "distance_from_prev_km": "仿真", "origin_city": "仿真", "trip_type": "仿真", "trip_days": "仿真", "weather": "仿真", "temp_high": "仿真", "day_type": "真实", "order_id": "仿真", "entry_type": "仿真", "travel_type": "仿真"},
    'channel_distribution': {"stat_month": "仿真", "poi_id": "真实", "poi_name": "真实", "province": "推断", "city": "推断", "scenic_category": "推断", "product_id": "派生", "product_name": "真实", "ticket_type_name": "真实", "channel": "仿真", "channel_type": "仿真", "list_price": "真实", "channel_price": "仿真", "commission_rate": "仿真", "exposure": "仿真", "clicks": "仿真", "ctr": "仿真", "orders": "仿真", "cvr": "仿真", "tickets_sold": "仿真", "gmv": "仿真", "commission_fee": "仿真", "refund_orders": "仿真", "refund_rate": "仿真", "net_revenue": "仿真", "marketing_spend": "仿真", "roas": "仿真", "cpa": "仿真", "new_customer_ratio": "仿真", "avg_lead_days": "仿真", "main_segment": "仿真"},
    'scenic_daily_ops': {"date": "真实", "poi_id": "真实", "poi_name": "真实", "province": "推断", "city": "推断", "scenic_category": "推断", "is_indoor": "推断", "weekday": "真实", "day_type": "真实", "holiday_name": "真实", "school_vacation": "真实", "season_label": "派生", "weather": "仿真", "temp_high": "仿真", "temp_low": "仿真", "event_name": "仿真", "base_product_id": "派生", "list_price": "真实", "executed_price": "仿真", "competitor_avg_price": "仿真", "daily_capacity": "推断", "visitors": "仿真", "load_rate": "仿真", "is_sold_out": "仿真", "online_bookings": "仿真", "offline_visitors": "仿真", "booked_by_d7": "仿真", "booked_by_d3": "仿真", "booked_by_d1": "仿真", "refund_orders": "仿真", "ticket_revenue": "仿真", "secondary_revenue": "仿真", "total_revenue": "仿真", "avg_spend_per_visitor": "仿真", "marketing_spend": "仿真", "satisfaction_score": "仿真", "complaint_count": "仿真"},
}


def origin_of(internal: str, field: dict) -> str:
    src = field["src"]
    col = src if isinstance(src, str) else getattr(src, "col", None)
    if col is None:
        return "派生"
    if col.startswith("seg_share_"):
        return "仿真"
    return ORIGIN.get(internal, {}).get(col, "派生")

PARTITION = "travel_date"


def full_name(internal: str) -> str:
    t = TABLES[internal]
    return f"{t['db']}.{t['table']}"


def to_standard(df: pd.DataFrame, internal: str) -> pd.DataFrame:
    """内部字段 -> 规范字段（含编码转换与 travel_date 分区字段）。"""
    t = TABLES[internal]
    out = {}
    for f in t["fields"]:
        src = f["src"]
        col = src(df) if callable(src) else df[src]
        if f["type"] == "BIGINT":
            col = pd.to_numeric(col, errors="raise").round().astype("Int64")
        out[f["name"]] = col
    out[PARTITION] = t["partition"][1](df).astype(str)
    return pd.DataFrame(out)


def to_internal(df: pd.DataFrame, internal: str) -> pd.DataFrame:
    """规范字段 -> 内部字段（用于质量校验复用原有规则）；编码字段还原为中文取值。"""
    t = TABLES[internal]
    out = {}
    for f in t["fields"]:
        src = f["src"]
        if isinstance(src, str) and src not in out:
            out[src] = df[f["name"]]
    return pd.DataFrame(out)


def ddl_hive(internal: str) -> str:
    t = TABLES[internal]
    w = max(len(f["name"]) for f in t["fields"])
    cols = ",\n".join(f"  {f['name']:<{w}} {f['type']:<6} COMMENT '{f['comment']}'" for f in t["fields"])
    part_comment = f"分区日期，格式YYYYMMDD（{t['partition'][0]}）"
    return (f"-- {t['title']}\nCREATE TABLE IF NOT EXISTS {full_name(internal)} (\n{cols}\n)\n"
            f"COMMENT '{t['comment']}'\nPARTITIONED BY ({PARTITION} STRING COMMENT '{part_comment}')\nSTORED AS ORC;\n")


def sqlite_type(t: str) -> str:
    return {"BIGINT": "INTEGER", "DOUBLE": "REAL"}.get(t, "TEXT")
