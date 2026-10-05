# 数据质量校验报告

总体结论：✅ 全部通过

| 校验项 | 结果 | 说明 |
|---|---|---|
| dim.dim_prd_attraction_ticket_df 表名符合 分层_业务域_实体_粒度 | ✅ |  |
| dim.dim_prd_attraction_ticket_df 字段名 snake_case | ✅ |  |
| dim.dim_prd_attraction_ticket_df 表与字段均有注释 | ✅ |  |
| dim.dim_prd_attraction_ticket_df 类型/状态/等级字段注释含取值说明 | ✅ |  |
| dim.dim_prd_attraction_ticket_df 编码字段取值均在枚举定义内 | ✅ |  |
| dim.dim_prd_attraction_ticket_df 分区字段 travel_date 为 YYYYMMDD | ✅ |  |
| dws.dws_cus_traveler_profile_df 表名符合 分层_业务域_实体_粒度 | ✅ |  |
| dws.dws_cus_traveler_profile_df 字段名 snake_case | ✅ |  |
| dws.dws_cus_traveler_profile_df 表与字段均有注释 | ✅ |  |
| dws.dws_cus_traveler_profile_df 类型/状态/等级字段注释含取值说明 | ✅ |  |
| dws.dws_cus_traveler_profile_df 编码字段取值均在枚举定义内 | ✅ |  |
| dws.dws_cus_traveler_profile_df 分区字段 travel_date 为 YYYYMMDD | ✅ |  |
| dwd.dwd_ord_attraction_ticket_order_di 表名符合 分层_业务域_实体_粒度 | ✅ |  |
| dwd.dwd_ord_attraction_ticket_order_di 字段名 snake_case | ✅ |  |
| dwd.dwd_ord_attraction_ticket_order_di 表与字段均有注释 | ✅ |  |
| dwd.dwd_ord_attraction_ticket_order_di 类型/状态/等级字段注释含取值说明 | ✅ |  |
| dwd.dwd_ord_attraction_ticket_order_di 编码字段取值均在枚举定义内 | ✅ |  |
| dwd.dwd_ord_attraction_ticket_order_di 分区字段 travel_date 为 YYYYMMDD | ✅ |  |
| dwd.dwd_cus_traveler_trajectory_di 表名符合 分层_业务域_实体_粒度 | ✅ |  |
| dwd.dwd_cus_traveler_trajectory_di 字段名 snake_case | ✅ |  |
| dwd.dwd_cus_traveler_trajectory_di 表与字段均有注释 | ✅ |  |
| dwd.dwd_cus_traveler_trajectory_di 类型/状态/等级字段注释含取值说明 | ✅ |  |
| dwd.dwd_cus_traveler_trajectory_di 编码字段取值均在枚举定义内 | ✅ |  |
| dwd.dwd_cus_traveler_trajectory_di 分区字段 travel_date 为 YYYYMMDD | ✅ |  |
| dws.dws_trf_attraction_channel_sales_mo 表名符合 分层_业务域_实体_粒度 | ✅ |  |
| dws.dws_trf_attraction_channel_sales_mo 字段名 snake_case | ✅ |  |
| dws.dws_trf_attraction_channel_sales_mo 表与字段均有注释 | ✅ |  |
| dws.dws_trf_attraction_channel_sales_mo 类型/状态/等级字段注释含取值说明 | ✅ |  |
| dws.dws_trf_attraction_channel_sales_mo 编码字段取值均在枚举定义内 | ✅ |  |
| dws.dws_trf_attraction_channel_sales_mo 分区字段 travel_date 为 YYYYMMDD | ✅ |  |
| dws.dws_opr_attraction_operation_di 表名符合 分层_业务域_实体_粒度 | ✅ |  |
| dws.dws_opr_attraction_operation_di 字段名 snake_case | ✅ |  |
| dws.dws_opr_attraction_operation_di 表与字段均有注释 | ✅ |  |
| dws.dws_opr_attraction_operation_di 类型/状态/等级字段注释含取值说明 | ✅ |  |
| dws.dws_opr_attraction_operation_di 编码字段取值均在枚举定义内 | ✅ |  |
| dws.dws_opr_attraction_operation_di 分区字段 travel_date 为 YYYYMMDD | ✅ |  |
| scenic_product_detail 行数=200000 | ✅ | 实际 200000 |
| visitor_profile 行数=200000 | ✅ | 实际 200000 |
| visitor_consumption 行数=200000 | ✅ | 实际 200000 |
| visitor_trajectory 行数=200000 | ✅ | 实际 200000 |
| channel_distribution 行数=200000 | ✅ | 实际 200000 |
| 产品ID唯一 | ✅ |  |
| 游客ID唯一 | ✅ |  |
| 订单ID唯一 | ✅ |  |
| 轨迹ID唯一 | ✅ |  |
| 订单→游客 外键完整 | ✅ |  |
| 订单→产品 外键完整 | ✅ |  |
| 轨迹→游客 外键完整 | ✅ |  |
| 轨迹→订单 外键完整 | ✅ |  |
| 有轨迹的订单均为已核销 | ✅ |  |
| 渠道→产品 外键完整 | ✅ |  |
| 产品 保底价≤标价≤最高限价 | ✅ |  |
| 订单 实付=原价-优惠 | ✅ |  |
| 退款订单消费额为0 | ✅ |  |
| 日客流≤日最大承载量 | ✅ |  |
| 线上+线下=日客流 | ✅ |  |
| 渠道月售票合计=日度客流月合计 | ✅ | 对齐 6576 个景区-月 |
| 画像消费汇总=订单汇总 | ✅ | 最大偏差 0.0 |
| combo_recommend 格式合规（messages/thought/answer/JSON） | ✅ | 0/100000 不合规 |
| combo_recommend 业务约束与数字闭合 | ✅ | 0/100000 不通过 [] |
| visitor_forecast 格式合规（messages/thought/answer/JSON） | ✅ | 0/100000 不合规 |
| visitor_forecast 业务约束与数字闭合 | ✅ | 0/100000 不通过 [] |
| dynamic_pricing 格式合规（messages/thought/answer/JSON） | ✅ | 0/100000 不合规 |
| dynamic_pricing 业务约束与数字闭合 | ✅ | 0/100000 不通过 [] |
| channel_placement 格式合规（messages/thought/answer/JSON） | ✅ | 0/100000 不合规 |
| channel_placement 业务约束与数字闭合 | ✅ | 0/100000 不通过 [] |
| business_insight 格式合规（messages/thought/answer/JSON） | ✅ | 0/100000 不合规 |
| business_insight 业务约束与数字闭合 | ✅ | 0/100000 不通过 [] |

## 训练集长度统计（字符数，system+user+assistant）

| 任务 | 样本数 | P50 | P95 | 最大 |
|---|---|---|---|---|
| combo_recommend | 100000 | 1891 | 2291 | 2821 |
| visitor_forecast | 100000 | 5444 | 5589 | 6042 |
| dynamic_pricing | 100000 | 2184 | 2224 | 2300 |
| channel_placement | 100000 | 4287 | 4787 | 5178 |
| business_insight | 100000 | 4492 | 4665 | 4839 |
