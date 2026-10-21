import { logAction, requireUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, HttpError } from "@/lib/db";
import { chunkAccess, getChunk, getRequirement, loadContent, sourceOf, T, validateContent } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: Record<string, { base: string; model: string }> = {
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { base: "https://api.deepseek.com", model: "deepseek-chat" },
};

/**
 * AI 再标：按需求的标注标准，让大模型（OpenAI / DeepSeek，OpenAI 兼容接口）重新标注当前条目。
 * 只返回建议内容，不直接保存；标注员确认后点保存才生效。结果同样经过格式与业务约束校验。
 * 环境变量：LLM_PROVIDER（openai|deepseek）、LLM_API_KEY、LLM_BASE_URL、LLM_MODEL
 */
export const POST = handle(async (req, { id }) => {
  const u = requireUser(req);
  const it = getDb().prepare(`SELECT * FROM ${T.item} WHERE item_id = ?`).get(Number(id)) as any;
  if (!it) throw new HttpError(404, "条目不存在");
  const c = getChunk(it.chunk_id);
  const { canEdit } = chunkAccess(u, c, u.role_type === "reviewer" ? "review" : "label");
  if (!canEdit) throw new HttpError(403, "当前不能编辑该条目");
  const key = process.env.LLM_API_KEY;
  if (!key) throw new HttpError(503, "未配置大模型：请在启动页面前设置环境变量 LLM_API_KEY（可选 LLM_PROVIDER=openai|deepseek、LLM_MODEL）");
  const provider = PROVIDERS[process.env.LLM_PROVIDER ?? "deepseek"] ?? PROVIDERS.deepseek;
  const src = sourceOf(it.source_code);
  const current = it.label_content ? JSON.parse(it.label_content) : loadContent(src, it.source_row_id);
  const r = getRequirement(it.requirement_id);

  const task =
    src.kind === "sft"
      ? `这是一条大模型 SFT 训练样本。system 为该任务的决策规则，user 为输入（JSON 字符串），assistant 必须严格为 "<thought>\\n...\\n</thought>\\n<answer>\\n...\\n</answer>" 结构。
请依据 system 规则与标注标准检查 assistant 是否正确，必要时重写 assistant（所有数字必须可由 user 复算，严禁编造）。user 与 system 保持不变。
只输出 JSON：{"assistant": "<修正后的完整 assistant 内容>", "reason": "<修改理由，无需修改则说明正确>"}`
      : `这是一条数据表记录（字段含义见字段说明）。请依据标注标准检查各字段取值，必要时修正。字段集合与类型不能改变，编码字段只能取说明中的编码。
只输出 JSON：{"record": <修正后的完整记录对象>, "reason": "<修改理由>"}`;
  const payload =
    src.kind === "sft"
      ? { system: current.system, user: current.user, assistant: current.assistant }
      : { record: current, field_comments: src.labels };
  const resp = await fetch(`${process.env.LLM_BASE_URL ?? provider.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? provider.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `你是严谨的数据标注专家。\n【标注标准】\n${r.standard_content}` },
        { role: "user", content: `${task}\n\n【待标注数据】\n${JSON.stringify(payload)}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch((e) => {
    throw new HttpError(502, `大模型调用失败：${e.message}`);
  });
  if (!resp.ok) throw new HttpError(502, `大模型返回错误 ${resp.status}：${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  let out: any;
  try {
    out = JSON.parse(data.choices?.[0]?.message?.content ?? "");
  } catch {
    throw new HttpError(502, "大模型未返回合法 JSON");
  }
  const suggestion = src.kind === "sft" ? { ...current, assistant: String(out.assistant ?? current.assistant) } : out.record ?? current;
  const errors = validateContent(src, suggestion);
  logAction(u.user_id, "item.ai_relabel", "item", it.item_id, errors.length ? `校验未通过：${errors.join("；")}` : "ok");
  return Response.json({ content: suggestion, reason: String(out.reason ?? ""), errors });
});
