-- 携程景区票务原始数据
CREATE TABLE IF NOT EXISTS ods.ods_prd_ctrip_attraction_ticket_df (
  attraction_id       STRING COMMENT '景区ID（携程景区POI编号）',
  attraction_name     STRING COMMENT '景区名称',
  ticket_type         BIGINT COMMENT '票类型编码：1-景点门票 2-门票套餐 3-官方服务 4-研学体验 5-讲解服务 6-直通车 7-景点联票 8-项目体验 9-一日游 10-当地特色 11-跟团司导',
  ticket_type_name    STRING COMMENT '票类型名称',
  ota_ticket_no       STRING COMMENT 'OTA（携程）商品/资源编号',
  prd_name            STRING COMMENT '商品名称',
  ticket_price_desc   STRING COMMENT '门票价格原始值（元，空=未公开/需选项后显示）',
  sales_raw_desc      STRING COMMENT '销量原始展示文本',
  cost_inclusion_desc STRING COMMENT '费用包含（原文）',
  purchase_notes_desc STRING COMMENT '购买须知（原文）'
)
COMMENT '携程全国景区票务与服务商品原始数据（天级全量快照，客户提供，未清洗）'
PARTITIONED BY (travel_date STRING COMMENT '分区日期，格式YYYYMMDD（快照日期（商品采集日））')
STORED AS ORC;
