"""生成 docs/训练集格式规范.md：每个模型的目标、字段规范、思维链步骤、验收指标与真实样例。"""
import json
import os

from . import config
from .io_utils import iter_jsonl_shards

SPEC = {
    "combo_recommend": {
        "title": "票务产品组合推荐模型",
        "goal": "用户购买基础门票后，从景区真实在售的组合商品中挑选最契合用户画像的一款，生成“加购仅需XX元”的场景化种草话术。",
        "accept": "推荐被点击、被购买的比例。离线代理指标：推荐命中率（与规则真值一致）、幻觉率（推荐不在库存）=0、约束违规率=0；"
                  "线上 A/B 以加购转化率为准（消费数据集 addon_product_id 字段提供历史加购真值）。",
        "input": [
            ("user_profile", "object", "来源地/年龄/性别/出游类型/同行人员/价格敏感度/兴趣标签"),
            ("scenic_spot", "object", "景区名称/城市/游玩日期/日期类型/天气/当前时间（游玩当日或提前N天）"),
            ("purchased_ticket", "object", "已购基础门票 id/name/price"),
            ("available_products", "array", "当前真实有库存的组合票列表，每项含 id/name/price/desc（全部来自携程真实商品）"),
        ],
        "output": "<answer> 为面向用户的推荐文案（纯文本）；必须包含推荐商品的完整名称与正确的加购价，严禁出现列表外商品与未声明权益。"
                  "若全部候选被排除，则如实说明暂无合适加购产品。",
        "steps": ["分析用户画像（客群诉求+天气/节假日情境）", "遍历可用库存（命中特征、匹配分、加购价）",
                  "排除不匹配项（预订时效/安全/权益重复/预算/天气五类硬约束，及次选说明）", "确定推荐项（ID+加购价）", "构思话术（切入点→卖点→情境→价格锚点→行动号召）"],
    },
    "visitor_forecast": {
        "title": "游客人数预测模型",
        "goal": "基于近14天客流、去年同期季节特征、未来7天日历/天气/活动与实时预约量，预测未来7天每日入园人数并给出区间与承载预警。",
        "accept": "预测人数与实际人数的误差：MAPE、WAPE、区间覆盖率（meta 中保存真实客流）。规则引擎教师在全量样本上的 MAPE 见 manifest。",
        "input": [
            ("景区信息", "object", "名称/城市/类别/是否室内/日最大承载量"),
            ("预测发布日期", "string", "预测发布日（窗口首日前一天）"),
            ("近14天历史客流", "array[14]", "日期/星期/日期类型/天气/节庆活动/实际客流/线上预约量"),
            ("去年同期特征", "object|null", "去年同期7日标准化日均、去年前14日标准化日均"),
            ("未来7天特征", "array[7]", "日期/星期/日期类型/天气预报/最高气温/节庆活动/提前天数/当前已预约量"),
        ],
        "output": "JSON：predictions[7]{date,visitors,lower,upper,load_rate}、total_7d、peak_date、capacity_alerts、key_drivers",
        "steps": ["读取景区与预测窗口", "计算标准化基线（逐日除以日期×天气×活动系数）", "季节修正（去年同期比）",
                  "逐日模型预测与预约校准（预约折算客流、按提前天数加权融合）", "承载校验与预测区间"],
    },
    "dynamic_pricing": {
        "title": "票务产品动态定价模型",
        "goal": "融合实时库存、预订速度、预测客流、竞品价格、天气及节假日特征，输出目标日票价调整建议（含临期清库存、渠道差异化策略）。",
        "accept": "带来的收入提升、定价是否合理。离线：规则命中准确率、动作准确率、价格MAE、限价合规率=100%；输出含预计新增收入变化。",
        "input": [
            ("目标日期", "string", "需要调价的日期"), ("距离目标日天数", "int", "0~3"),
            ("产品信息", "object", "名称/景区/城市/类别"),
            ("预订数据", "object", "今日实时预订量、昨日累计预订量、总库存（与客户样例字段一致）"),
            ("当日预测客流量", "int", "预测客流"), ("外部时空特征", "object", "是否节假日、天气预报、当前季节"),
            ("竞品均价", "number", "周边同类景区均价"),
            ("定价规则", "object", "当前执行价、最高限价、最低保底价、溢价系数、折扣系数"),
        ],
        "output": "JSON：action、suggested_price、confidence、reason、rule_id（客户样例5字段）+ current_price、price_change_pct、"
                  "compliance_check、expected_revenue_change、channel_strategy",
        "steps": ["读取外部时空特征", "评估预订数据与预测客流（售出率/需求比/进度指数）", "确定定价策略（R1~R6按序匹配）",
                  "套用定价公式", "合规性自检（竞品约束、最高限价、最低保底价）", "收益测算（价格弹性）", "确定最终建议"],
    },
    "channel_placement": {
        "title": "产品渠道投放模型",
        "goal": "根据产品、目标客群、预算与约束，基于近3个月分渠道真实投放表现，输出下月分渠道预算分配与人群定向。",
        "accept": "投放回报、人群投放是否精准。离线：约束合规率、按输入数据复算的预期GMV达成率、预算分配偏差；人群匹配系数显式进入决策。",
        "input": [
            ("产品信息", "object", "名称/景区/城市/类别/票种/售价"),
            ("投放目标", "object", "投放月份/目标客群/优化目标/总预算"),
            ("近3个月分渠道投放表现", "array", "渠道/曝光/点击率/转化率/订单/客单价/GMV/营销费用/ROAS/佣金率/目标客群占比"),
            ("约束条件", "object", "单渠道预算占比上限/最低ROAS门槛/分配步长"),
        ],
        "output": "JSON：target_segment、allocations[]{channel,budget,share,expected_gmv,expected_roas,last_step_roas,targeting,expected_orders}、"
                  "excluded_channels、reserved_budget、total_expected_gmv、overall_roas",
        "steps": ["明确投放目标", "计算人群匹配系数与有效ROAS", "剔除不达标渠道", "边际递减贪心分配", "合规自检"],
    },
    "business_insight": {
        "title": "经营洞察模型",
        "goal": "对景区月度经营数据做环比/同比解读，给出收入与客流的可加和归因、渠道变化、风险与可执行建议。",
        "accept": "数据解读是否准确、归因是否合理。离线：归因闭合率（各因素贡献之和=实际差额）、核心指标数值准确率、主因判断一致率。",
        "input": [
            ("分析问题", "string", "4类问法模板"), ("景区信息", "object", "名称/城市/类别/是否室内/承载量"),
            ("对比口径", "string", "环比或同比"), ("本期经营指标 / 对比期经营指标", "object", "接待人次、门票/二消/总收入、人均、票价、线上占比、退款、满意度、投诉、营销费用、最高承载率"),
            ("本期日历与天气 / 对比期日历与天气", "object", "天数、节假日/周末/恶劣天气/活动天数、系数汇总"),
            ("分渠道售票", "array", "各渠道本期/对比期售票"),
        ],
        "output": "JSON：summary、key_metrics[]、revenue_attribution[]、visitor_attribution[]、channel_changes[]、risks[]、recommendations[]",
        "steps": ["明确分析口径", "核心指标变化", "收入拆解（客流/票价结构/二消）", "客流归因（日历/天气/活动/残差，对数分摊）",
                  "渠道结构", "风险识别与建议"],
    },
}


def main():
    out = ["# 训练集格式规范", "",
           "## 通用约定", "",
           "- 文件格式：JSONL，每行 `{\"messages\": [system, user, assistant]}`，兼容 OpenAI 微调、LLaMA-Factory（sharegpt/openai 格式）、ms-swift、Axolotl、Unsloth。",
           "- `user.content` 为 JSON 字符串（中文键，与客户样例一致）；`assistant.content` 严格为 `<thought>\\n...\\n</thought>\\n<answer>\\n...\\n</answer>`。",
           "- `<thought>` 采用编号步骤，所有数字可由输入复算；`<answer>` 除组合推荐为文案外，均为单行 JSON（英文键便于程序解析）。",
           "- system prompt 写明决策规则/系数表，使模型学习“稳定可解释的业务流程”而非记忆数值；推理时须使用同一 system prompt。",
           "- 每个任务切分 train/val/test（94%/3%/3%，按样本ID哈希，确定可复现）；评测真值与溯源信息在 `*_meta` 文件中按顺序对齐，不进入训练文本。",
           "- 训练建议：全参或 LoRA 均可；推荐 max_seq_len ≥ 4096（各任务长度统计见 output/quality_report.md）；loss 仅计算 assistant 部分。", ""]
    for task, s in SPEC.items():
        out += [f"## {s['title']}（`{task}`）", "", f"**模型目标**：{s['goal']}", "", f"**验收口径**：{s['accept']}", "",
                "**输入字段（user.content）**", "", "| 字段 | 类型 | 说明 |", "|---|---|---|"]
        out += [f"| {a} | {b} | {c} |" for a, b, c in s["input"]]
        out += ["", f"**输出（assistant `<answer>`）**：{s['output']}", "", "**`<thought>` 必含步骤**：", ""]
        out += [f"{i + 1}. {x}" for i, x in enumerate(s["steps"])]
        d = os.path.join(config.SFT_DIR, task)
        try:
            ex = next(iter_jsonl_shards(d, f"{task}_val"))
            out += ["", "**真实样例（val 集第 1 条）**", "", "```json", json.dumps(ex, ensure_ascii=False, indent=2), "```"]
        except StopIteration:
            pass
        out.append("")
    with open(os.path.join(config.ROOT, "docs", "训练集格式规范.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("docs/训练集格式规范.md written")


if __name__ == "__main__":
    main()
