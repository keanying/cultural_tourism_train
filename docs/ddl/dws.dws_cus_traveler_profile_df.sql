-- 景区游客画像数据集
CREATE TABLE IF NOT EXISTS dws.dws_cus_traveler_profile_df (
  traveler_id             STRING COMMENT '游客ID',
  gender_type             BIGINT COMMENT '性别：1-男 2-女',
  traveler_age            BIGINT COMMENT '年龄（周岁）',
  age_range_name          STRING COMMENT '年龄段（如25-29、60+）',
  home_province_name      STRING COMMENT '客源省份',
  home_city_name          STRING COMMENT '客源城市',
  home_city_level         BIGINT COMMENT '客源城市等级：1-1线 2-2线 3-3线 4-4线及以下',
  traveler_segment_type   BIGINT COMMENT '出游客群编码：1-亲子游 2-情侣游 3-朋友结伴 4-独自旅行 5-银发游 6-家庭多代游 7-商务差旅 8-学生游',
  traveler_segment_name   STRING COMMENT '出游客群名称',
  companion_desc          STRING COMMENT '同行结构描述（如2大1小）',
  adult_qty               BIGINT COMMENT '同行成人数',
  child_qty               BIGINT COMMENT '同行儿童数',
  senior_qty              BIGINT COMMENT '同行长者数',
  child_age               BIGINT COMMENT '儿童年龄（无儿童为空）',
  income_level            BIGINT COMMENT '收入水平：1-低 2-中 3-中高 4-高',
  price_sensitivity_level BIGINT COMMENT '价格敏感度：1-低 2-中 3-高',
  member_level            BIGINT COMMENT '会员等级：1-普通会员 2-银卡 3-金卡 4-铂金卡',
  preferred_channel_code  BIGINT COMMENT '首选购票渠道：1-携程 2-美团 3-飞猪 4-抖音团购 5-小红书 6-同程旅行 7-景区官网/小程序 8-线下窗口 9-旅行社分销',
  secondary_channel_code  BIGINT COMMENT '次选购票渠道：1-携程 2-美团 3-飞猪 4-抖音团购 5-小红书 6-同程旅行 7-景区官网/小程序 8-线下窗口 9-旅行社分销',
  booking_lead_type       BIGINT COMMENT '提前预订习惯：1-当天 2-1-3天 3-4-7天 4-7天以上',
  annual_trip_qty         BIGINT COMMENT '年出游次数',
  preferred_category_tags STRING COMMENT '偏好景区类别Top3（多值以|分隔）',
  interest_tags           STRING COMMENT '兴趣标签（多值以|分隔）',
  device_type             BIGINT COMMENT '常用终端：1-iOS 2-Android 3-小程序 4-PC',
  register_date           STRING COMMENT '注册日期（YYYY-MM-DD）',
  valid_order_qty         BIGINT COMMENT '有效订单数（不含退款，由订单表回填）',
  total_spend_amt         DOUBLE COMMENT '累计消费金额（元）',
  last_visit_date         STRING COMMENT '最近到访日期（YYYY-MM-DD）',
  favorite_province_name  STRING COMMENT '最常去省份',
  avg_order_amt           DOUBLE COMMENT '平均订单金额（元）',
  refund_order_qty        BIGINT COMMENT '退款订单数',
  value_level             BIGINT COMMENT '客户价值分层：0-未消费 1-低价值 2-中价值 3-高价值'
)
COMMENT '游客画像宽表（天级全量快照）：游客基础属性、偏好与消费汇总（虚拟ID，无真实个人信息）'
PARTITIONED BY (travel_date STRING COMMENT '分区日期，格式YYYYMMDD（快照日期（画像统计截止日））')
STORED AS ORC;
