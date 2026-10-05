# 文旅大模型训练数据蒸馏（cultural_tourism_train）

基于客户提供的**携程全国景区票务数据**（2 万景区 POI、35.8 万商品），蒸馏生成 5 个业务明细数据集与 5 个大模型 SFT 训练集，
训练集为 `messages` 标准格式，**解压即可直接喂给 LLaMA-Factory / ms-swift / OpenAI 微调等框架**。

> 游客反馈情感分析模型由客户自有，不在本次范围内。

## 一、交付物总览

| 类别 | 内容 | 位置 |
|---|---|---|
| 明细数据集 | 5 张表各 **200,000** 行，按客户数仓命名规范输出（见下表） | `output/datasets/<库>/<表>/*.csv.gz` |
| 辅助数据集 | 景区日度客流与运营数据（274 个核心景区 × 731 天 ≈ 20 万行，预测/定价/洞察的数据基础） | `output/datasets/dws/dws_opr_attraction_operation_di/` |
| 建表语句 | 每张表的 Hive DDL（表与字段均带 COMMENT，按 `travel_date` 分区） | `docs/ddl/*.sql` |
| SFT 训练集 | 组合推荐 / 客流预测 / 动态定价 / 渠道投放 / 经营洞察，各 **100,000** 条（train 94% / val 3% / test 3%） | `output/sft/<task>/<task>_{train,val,test}-*.jsonl.gz` |
| 评测真值 | 每条样本的真值与溯源（推荐真值ID、真实客流、规则ID等），按顺序与样本对齐 | `output/sft/<task>/<task>_meta-*.jsonl.gz` |
| 质量报告 | 主外键、跨表一致性、格式与业务约束全量校验结果 | `output/quality_report.md` |
| 文档 | 数据字典、训练集格式规范（含每个模型的真实样例） | `docs/数据字典.md`、`docs/训练集格式规范.md` |
| 代码 | 全流程蒸馏代码（清洗→仿真→训练集构造→LLM 润色→校验→评测），固定随机种子可完全复现 | `distill/` |

### 表清单（客户数仓命名规范）

| 数据集 | 库.表 | 粒度 / 分区 travel_date |
|---|---|---|
| 景区分销渠道数据集 | `dws.dws_trf_attraction_channel_sales_mo` | 月级增量 / 统计月份首日 |
| 景区产品详情数据集 | `dim.dim_prd_attraction_ticket_df` | 天级全量快照 / 商品采集日 |
| 景区游客消费数据集 | `dwd.dwd_ord_attraction_ticket_order_di` | 天级增量 / 游玩日期 |
| 景区游客画像数据集 | `dws.dws_cus_traveler_profile_df` | 天级全量快照 / 画像统计截止日 |
| 游客出行轨迹数据集 | `dwd.dwd_cus_traveler_trajectory_di` | 天级增量 / 到访日期 |
| 景区日度客流与运营（辅助） | `dws.dws_opr_attraction_operation_di` | 天级增量 / 统计日期 |

字段均为 snake_case 的“实体_属性”，金额 `_amt`、数量 `_qty`、比例 `_rate`、编号 `_no`、名称 `_name`、日期 `_date`、时间 `_time`；
类型/状态/等级类字段统一编码，注释中写明每个取值含义（如 `order_status`：1-已核销 2-已退款 3-已过期未使用），并保留对应 `_name` 字段方便阅读。
全部映射集中定义在 `distill/naming.py`，质量校验会逐表检查命名、注释、编码取值与分区格式。

> 为满足 GitHub 单文件 100MB 限制，数据以 gzip 分片存放。运行 `python unpack.py` 可合并解压到 `dist/`
> （`dist/sft/<task>/train.jsonl` 等），直接作为训练文件使用。

## 二、快速开始

```bash
pip install -r requirements.txt

# 1) 直接使用已生成的数据
python unpack.py                       # -> dist/sft/<task>/{train,val,test}.jsonl, dist/datasets/<库>.<表>.csv

# 2) 从原始数据完整复现（约 1~2 小时，4 核）
bash run_all.sh

# 3) 可选：用 OpenAI / DeepSeek 对话术与解读文本做大模型润色（事实锁校验，失败自动回退）
export LLM_PROVIDER=deepseek LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat
python -m distill.llm_refine --task combo_recommend --ratio 0.2 --workers 16

# 4) 模型微调后离线评测（--self-check 用参考答案自测评测脚本）
python -m distill.evaluate --task dynamic_pricing --pred your_model_outputs.jsonl
```

LLaMA-Factory `dataset_info.json` 示例：

```json
{
  "ct_combo_recommend": {
    "file_name": "dist/sft/combo_recommend/train.jsonl",
    "formatting": "sharegpt",
    "columns": {"messages": "messages"},
    "tags": {"role_tag": "role", "content_tag": "content", "user_tag": "user", "assistant_tag": "assistant", "system_tag": "system"}
  }
}
```

### 数据管理页面（查看 / 在线修改 / 一键导出 JSONL）

```bash
python -m distill.build_db                     # 按分层导入 SQLite（web/data/{dim,dwd,dws,ads}.db）
cd web && npm install && npm run build && npm start   # http://localhost:3000
```

在页面中可以浏览全部 11 个数据源，在线修改训练样本和明细数据（保存前做格式与业务约束校验，并保留修改记录），一键导出当前筛选结果的 JSONL。详见 `web/README.md`。

## 三、方法论：为什么这样“蒸馏”

客户只有 OTA 商品数据，没有订单、画像、客流、渠道等交易数据，而训练集要求上百万条且**数字必须自洽**。
纯靠大模型逐条生成既昂贵又会产生计算错误（如定价超限、归因不闭合），因此采用三层结构：

1. **真实数据为锚**：商品名称、价格、销量、费用包含、购买须知全部来自携程原始数据；从文本中解析退改/预订时效/适用人群/15 类特征标签，
   反推景区所在城市（97.8% 可识别）与 13 类景区类别；节假日采用国务院 2024/2025 放假安排。
2. **业务规则仿真**：游客画像、行程轨迹、订单、渠道漏斗、日度客流均由统一的业务逻辑联合生成
   （客群×景区类别偏好、客群×商品特征偏好、季节/节假日/天气/价格弹性对客流的乘法模型、渠道佣金/转化/ROAS 特征等），
   保证**跨表严格一致**：订单↔画像↔产品↔轨迹外键 100% 完整，渠道月售票合计 = 日度客流月合计，画像消费汇总 = 订单汇总。
3. **规则引擎做“教师”、大模型做“润色”**：每个训练样本的决策与思维链由可复算的业务规则引擎产出（系数表写入 system prompt），
   保证 100% 正确；大模型（OpenAI/DeepSeek）只改写自然语言部分以提升多样性，并经“事实锁”校验（数字/商品名/渠道名不得增删），失败即回退。

数据字典中每个字段都标注了来源（真实 / 解析 / 推断 / 派生 / 仿真），方便客户区分真实数据与蒸馏数据。

## 四、模型与验收口径映射

| 模型 | 客户验收口径 | 训练集提供的离线指标（`distill/evaluate.py`） |
|---|---|---|
| 票务产品组合推荐 | 推荐被点击、被购买的比例 | 推荐命中率、幻觉率、约束违规率；消费数据集 `addon_product_id` 提供历史加购真值供线上 A/B 对照 |
| 游客人数预测 | 预测人数与实际人数的误差 | MAPE / WAPE / 区间覆盖率（meta 保存真实客流） |
| 票务产品动态定价 | 收入提升、定价是否合理 | 规则命中准确率、动作准确率、价格 MAE、限价合规率、预计收入变化 |
| 产品渠道投放 | 投放回报、人群投放是否精准 | 约束合规率、预期 GMV 达成率（按输入复算）、预算分配偏差 |
| 经营洞察 | 数据解读是否准确、归因是否合理 | 归因闭合率、核心指标数值准确率、主因判断一致率 |

### 本次交付的质量结果（`output/quality_report.md`）

- 5 个明细数据集各 200,000 行；主键唯一、外键 100% 完整；订单金额闭合；渠道月售票与日度客流逐景区逐月完全一致；画像消费汇总与订单汇总偏差 0。
- 5 个训练集各 100,000 条（总计 50 万条），格式合规率 100%、业务约束与数字闭合校验通过率 100%：
  推荐商品 100% 在库存内且话术价格正确；定价 100% 在限价区间内；投放分配合计 100% 等于预算；洞察收入/客流归因 100% 加和闭合。
- 客流预测教师（规则引擎）在 test 集对**真实客流**的 MAPE = 7.98%、WAPE = 7.90%、区间覆盖率 86.8%，可作为微调模型的基线。
- “无合适推荐”的拒答样本占 4.8%，用于训练模型在全部候选不满足约束时如实拒推，不强行推荐。
- 样本长度（字符，P95）：组合推荐 2.3k、客流预测 5.6k、动态定价 2.2k、渠道投放 4.8k、经营洞察 4.7k，建议 max_seq_len ≥ 4096 tokens。

## 五、目录结构

```
distill/
  naming.py           客户数仓命名规范映射（库表名、字段名、注释、枚举编码、分区）——交付命名的唯一来源
  config.py           规模/路径/种子（可用环境变量 CT_DATASET_ROWS / CT_SFT_SAMPLES / CT_SEED 覆盖）
  geo.py              地级市字典与城市识别
  calendar_cn.py      节假日、季节标签、天气模拟
  catalog.py          携程数据清洗与特征解析
  segments.py         客群定义与偏好矩阵        channels.py  渠道定义
  sim_products.py     数据集：景区产品详情      sim_profiles.py  数据集：游客画像
  sim_trips.py        数据集：游客消费 + 出行轨迹（联合生成）
  sim_daily_ops.py    辅助表：景区日度客流运营   sim_channels.py  数据集：分销渠道
  sft/                5 个训练集构造器（recommend / forecast / pricing / placement / insight）
  llm_refine.py       OpenAI/DeepSeek 润色 + 事实锁
  validate.py         质量校验       evaluate.py  离线评测
  build_datasets.py / build_sft.py   一键入口
  build_db.py         按 dim/dwd/dws/ads 分库导入 SQLite，供数据管理页面使用
  dictionary.py       生成数据字典与 DDL
web/                  数据管理页面（Next.js + HeroUI v3）
docs/                 数据字典、DDL（docs/ddl/）、训练集格式规范
output/               交付数据（gzip 分片）
```

## 六、注意事项

- 除标注“真实”的字段外，订单、画像、轨迹、客流、渠道指标均为**业务规则仿真数据**，用于模型学习业务逻辑与表达方式，不代表任何真实交易；
  建议客户拿到自有真实数据后，用同一套训练集格式补充少量真实样本做二次微调。
- 景区城市为文本推断（约 2.2% 无法从文本识别的景区按城市分布补全）；景区等级为热度推断，非官方 A 级。
- 训练与推理时务必使用训练集中相同的 system prompt（其中包含决策规则与系数表）。
