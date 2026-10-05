# 数据质量校验报告

总体结论：✅ 全部通过

| 校验项 | 结果 | 说明 |
|---|---|---|
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
