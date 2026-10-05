-- 游客出行轨迹数据集
CREATE TABLE IF NOT EXISTS dwd.dwd_cus_traveler_trajectory_di (
  trajectory_no            STRING COMMENT '轨迹点编号（行程编号-序号）',
  trip_no                  STRING COMMENT '行程编号',
  traveler_id              STRING COMMENT '游客ID',
  trip_seq_no              BIGINT COMMENT '行程内到访序号',
  attraction_id            STRING COMMENT '景区ID（携程景区POI编号）',
  attraction_name          STRING COMMENT '景区名称',
  attraction_province_name STRING COMMENT '景区所在省份（由商品文本推断）',
  attraction_city_name     STRING COMMENT '景区所在城市（由商品文本推断）',
  attraction_category_type BIGINT COMMENT '景区类别编码：1-主题乐园 2-动物园/海洋馆 3-博物馆/展馆 4-演艺/秀场 5-温泉度假 6-古镇古村 7-宗教寺观 8-历史遗迹 9-滨海海岛 10-湖泊水域 11-山岳峡谷 12-自然生态 13-城市地标',
  attraction_category_name STRING COMMENT '景区类别名称',
  attraction_lat           DOUBLE COMMENT '景区纬度（城市中心加扰动，近似值）',
  attraction_lon           DOUBLE COMMENT '景区经度（近似值）',
  visit_date               STRING COMMENT '到访日期（YYYY-MM-DD）',
  arrive_time              STRING COMMENT '到达时间（YYYY-MM-DD HH:MM）',
  leave_time               STRING COMMENT '离开时间（YYYY-MM-DD HH:MM）',
  stay_minute_qty          BIGINT COMMENT '停留时长（分钟）',
  transport_type           BIGINT COMMENT '从上一点出发的交通方式：1-飞机 2-高铁 3-大巴 4-自驾 5-打车 6-地铁/公交 7-景区直通车 8-步行/骑行',
  prev_leg_distance_km     DOUBLE COMMENT '与上一点的距离（公里，首站为距出发城市）',
  origin_city_name         STRING COMMENT '出发城市（仅首站填写）',
  trip_type                BIGINT COMMENT '行程类型：1-省内周边游 2-跨省游',
  trip_day_qty             BIGINT COMMENT '行程天数',
  weather_type             BIGINT COMMENT '天气编码：1-晴 2-多云 3-阴 4-雾霾 5-晴热高温 6-小雨 7-雷阵雨 8-中雨 9-大雨 10-小雪 11-中雪',
  weather_name             STRING COMMENT '天气名称',
  high_temperature         BIGINT COMMENT '最高气温（摄氏度）',
  day_type                 BIGINT COMMENT '日期类型编码：1-工作日 2-周末 3-法定节假日 4-调休工作日',
  day_type_name            STRING COMMENT '日期类型名称',
  order_no                 STRING COMMENT '关联订单编号（空=现场购票/免费游览）',
  entry_type               BIGINT COMMENT '入园方式：1-线上订单 2-现场购票/免费游览',
  traveler_segment_type    BIGINT COMMENT '出游客群：1-亲子游 2-情侣游 3-朋友结伴 4-独自旅行 5-银发游 6-家庭多代游 7-商务差旅 8-学生游'
)
COMMENT '游客出行轨迹明细天增量表：一行一个到访景区点（退款/未使用订单不产生轨迹）'
PARTITIONED BY (travel_date STRING COMMENT '分区日期，格式YYYYMMDD（到访日期）')
STORED AS ORC;
