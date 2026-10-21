import { logAction, requireUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, HttpError } from "@/lib/db";
import { chat, genRelabel, LlmError, parseJsonObject, pickModel } from "@/lib/gen";
import { chunkAccess, getChunk, getRequirement, loadContent, sourceOf, T, validateContent } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI 再标：按需求的标注标准，让大模型重新标注当前条目。只返回建议内容，不直接保存；标注员确认后点保存才生效。
 * 结果同样经过格式与业务约束校验。
 *   AI 生成资产：沿用生成时的模型与固化版本的提示词（见 lib/gen.ts genRelabel）；
 *   蒸馏数据：使用「模型管理」中的默认模型（未配置时回退到环境变量 LLM_API_KEY / LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL）。
 */
export const POST = handle(async (req, { id }) => {
  const u = requireUser(req);
  const it = getDb().prepare(`SELECT * FROM ${T.item} WHERE item_id = ?`).get(Number(id)) as any;
  if (!it) throw new HttpError(404, "条目不存在");
  const c = getChunk(it.chunk_id);
  const { canEdit } = chunkAccess(u, c, u.role_type === "reviewer" ? "review" : "label");
  if (!canEdit) throw new HttpError(403, "当前不能编辑该条目");
  const src = sourceOf(it.source_code);
  const current = it.label_content ? JSON.parse(it.label_content) : loadContent(src, it.source_row_id);
  const r = getRequirement(it.requirement_id);

  try {
    let suggestion: Record<string, any>;
    let reason: string;
    if (src.kind === "gen") {
      ({ content: suggestion, reason } = await genRelabel(src, it.source_row_id, current, r.standard_content));
    } else {
      const model = pickModel();
      if (!model) throw new HttpError(503, "没有可用的大模型：请在 数据资产 → 生成配置 → 模型管理 中填写 API Key（或设置环境变量 LLM_API_KEY）");
      const task =
        src.kind === "sft"
          ? `这是一条大模型 SFT 训练样本。system 为该任务的决策规则，user 为输入（JSON 字符串），assistant 必须严格为 "<thought>\\n...\\n</thought>\\n<answer>\\n...\\n</answer>" 结构。
请依据 system 规则与标注标准检查 assistant 是否正确，必要时重写 assistant（所有数字必须可由 user 复算，严禁编造）。user 与 system 保持不变。
只输出 JSON：{"assistant": "<修正后的完整 assistant 内容>", "reason": "<修改理由，无需修改则说明正确>"}`
          : `这是一条数据表记录（字段含义见字段说明）。请依据标注标准检查各字段取值，必要时修正。字段集合与类型不能改变，编码字段只能取说明中的编码。
只输出 JSON：{"record": <修正后的完整记录对象>, "reason": "<修改理由>"}`;
      const payload =
        src.kind === "sft" ? { system: current.system, user: current.user, assistant: current.assistant } : { record: current, field_comments: src.labels };
      const res = await chat(
        { ...model, temperature_rate: 0.2 },
        `你是严谨的数据标注专家。\n【标注标准】\n${r.standard_content}`,
        `${task}\n\n【待标注数据】\n${JSON.stringify(payload)}`,
        { json: true, retries: 2 },
      );
      const out = parseJsonObject(res.text);
      suggestion = src.kind === "sft" ? { ...current, assistant: String(out.assistant ?? current.assistant) } : (out.record ?? current);
      reason = String(out.reason ?? "");
    }
    const errors = validateContent(src, suggestion, it.source_row_id);
    logAction(u.user_id, "item.ai_relabel", "item", it.item_id, errors.length ? `校验未通过：${errors.join("；")}` : "ok");
    return Response.json({ content: suggestion, reason, errors });
  } catch (e) {
    if (e instanceof LlmError) throw new HttpError(502, `大模型调用失败：${e.message}`);
    throw e;
  }
});
