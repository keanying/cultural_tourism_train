import "server-only";
import { createHash } from "node:crypto";
import { getDb, HttpError, nowStr, type Source } from "./db";
import { assembleConversation, buildCtx, type Dict, dictVars, getPath, pyDumps, render, resolveDimensions, sampleLine, text, truthy } from "./tpl";

/**
 * 数据资产 · AI 生成引擎（移植自 Lumos engine.py / ark.py）：
 *   明细生成：按规格的维度轮转组织提示词，批量生成会话并去重落库；
 *   AI 预标注：对明细资产的每段会话逐轮调用模型产出字段，按样本模板组装为训练样本。
 * 产出的资产可作为标注需求的数据源，进入 需求→下发→标注→审核→交付 流程。
 */

export const G = {
  model: "ads.ads_llm_gen_model_f",
  spec: "ads.ads_llm_gen_spec_f",
  prompt: "ads.ads_llm_gen_prompt_f",
  promptVer: "ads.ads_llm_gen_prompt_version_f",
  dict: "ads.ads_llm_gen_dict_f",
  task: "ads.ads_llm_gen_task_f",
  log: "ads.ads_llm_gen_task_log_f",
  asset: "ads.ads_llm_gen_asset_f",
  conv: "ads.ads_llm_gen_conversation_f",
  sample: "ads.ads_llm_gen_sample_f",
};

export const GEN_SOURCE_PREFIX = "gen_asset_";

// ---------------------------------------------------------------- 配置读取

export function loadDicts(): Dict {
  const rows = getDb().prepare(`SELECT dict_code, value_json FROM ${G.dict}`).all() as any[];
  const out: Dict = {};
  for (const r of rows) {
    try {
      out[r.dict_code] = JSON.parse(r.value_json);
    } catch {
      /* 跳过损坏的字典 */
    }
  }
  return out;
}

export type Spec = { spec_code: string; spec_name: string; spec_kind_type: "detail" | "sft"; task_type: string; source_spec_code: string; tag_json: string; cfg: Dict; [k: string]: any };

export function getSpec(code: string): Spec {
  const s = getDb().prepare(`SELECT * FROM ${G.spec} WHERE spec_code = ?`).get(code) as any;
  if (!s) throw new HttpError(400, `数据规格不存在：${code}`);
  try {
    s.cfg = JSON.parse(s.config_json || "{}");
  } catch {
    s.cfg = {};
  }
  return s;
}

export type Model = {
  model_id: number;
  model_name: string;
  base_url: string;
  api_key_value: string;
  model_code: string;
  api_style_type: string;
  temperature_rate: number;
  top_p_rate: number;
  max_token_qty: number;
  timeout_sec_qty: number;
  extra_body_json: string;
};

export function getModel(id: number): Model {
  const m = getDb().prepare(`SELECT * FROM ${G.model} WHERE model_id = ?`).get(id) as any;
  if (!m) throw new HttpError(400, "模型配置不存在");
  return m;
}

/** 选择可用模型：指定模型（有 Key）→ 默认模型 → 任一启用且有 Key 的模型 → 环境变量 LLM_API_KEY */
export function pickModel(preferId?: number | null): Model | null {
  const db = getDb();
  if (preferId) {
    const m = db.prepare(`SELECT * FROM ${G.model} WHERE model_id = ? AND COALESCE(api_key_value, '') != ''`).get(preferId) as any;
    if (m) return m;
  }
  const m = db
    .prepare(`SELECT * FROM ${G.model} WHERE is_active = 1 AND COALESCE(api_key_value, '') != '' ORDER BY is_default DESC, model_id LIMIT 1`)
    .get() as any;
  if (m) return m;
  if (process.env.LLM_API_KEY) {
    const openai = process.env.LLM_PROVIDER === "openai";
    return {
      model_id: 0,
      model_name: "环境变量 LLM_API_KEY",
      base_url: process.env.LLM_BASE_URL ?? (openai ? "https://api.openai.com/v1" : "https://api.deepseek.com"),
      api_key_value: process.env.LLM_API_KEY,
      model_code: process.env.LLM_MODEL ?? (openai ? "gpt-4o-mini" : "deepseek-chat"),
      api_style_type: "chat",
      temperature_rate: 0.3,
      top_p_rate: 0.9,
      max_token_qty: 8192,
      timeout_sec_qty: 180,
      extra_body_json: "{}",
    };
  }
  return null;
}

/** 提示词的指定版本（缺省为最新版本） */
export function promptVersion(promptId: number, versionNo?: number | null) {
  const db = getDb();
  const p = db.prepare(`SELECT * FROM ${G.prompt} WHERE prompt_id = ?`).get(promptId) as any;
  if (!p) throw new HttpError(400, "提示词不存在");
  const v = (
    versionNo
      ? db.prepare(`SELECT * FROM ${G.promptVer} WHERE prompt_id = ? AND version_no = ?`).get(promptId, versionNo)
      : db.prepare(`SELECT * FROM ${G.promptVer} WHERE prompt_id = ? ORDER BY version_no DESC LIMIT 1`).get(promptId)
  ) as any;
  return {
    prompt_id: p.prompt_id,
    prompt_name: p.prompt_name,
    version_no: v?.version_no ?? p.version_no,
    system: v?.system_prompt_text ?? p.system_prompt_text,
    user: v?.user_prompt_text ?? p.user_prompt_text,
  };
}

// ---------------------------------------------------------------- 大模型调用（OpenAI 兼容：/chat/completions 与 /responses）

export class LlmError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
  }
}

function explain(status: number, body: string, m: Model): string {
  if (status === 404) {
    return [
      `模型「${m.model_code}」不存在或未开通。请检查：`,
      "① 模型编码是否正确（火山方舟建议填接入点 ID，形如 ep-2025…；模型名需带版本后缀）；",
      "② 该模型是否已在服务商控制台开通；",
      "③ 部分新模型只支持 Responses 接口，把「接口协议」设为 auto 或 responses；",
      `④ 接口地址（当前 ${m.base_url}）与 API Key 是否属于同一账号/区域。`,
    ].join("\n");
  }
  if (status === 401) return "API Key 无效或未复制完整；也可能账号未完成实名认证。";
  if (status === 403) return "该 API Key 没有调用此模型的权限，检查 Key 所属项目与模型是否一致。";
  if (status === 429) return "触发限流或余额不足：降低任务并发，或到服务商控制台确认余额与 QPS 配额。";
  return body.slice(0, 300);
}

const baseOf = (m: Model) => {
  let url = (m.base_url ?? "").trim().replace(/\/+$/, "");
  for (const suf of ["/chat/completions", "/responses", "/completions"]) if (url.endsWith(suf)) url = url.slice(0, -suf.length);
  return url.replace(/\/+$/, "");
};

function extra(m: Model, body: Dict): Dict {
  try {
    const e = JSON.parse(m.extra_body_json || "{}");
    if (e && typeof e === "object" && !Array.isArray(e)) Object.assign(body, e);
  } catch {
    /* 忽略 */
  }
  return body;
}

async function post(m: Model, url: string, body: Dict, style: string): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.api_key_value ?? ""}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((m.timeout_sec_qty || 180) * 1000),
    });
  } catch (e: any) {
    throw new LlmError(`网络错误：${e?.message ?? e}`, true);
  }
  if (r.status >= 400) {
    const hint = explain(r.status, await r.text(), m);
    if (r.status < 500 && r.status !== 429) throw new LlmError(`HTTP ${r.status}（${style} 协议）\n${hint}`);
    throw new LlmError(`HTTP ${r.status} ${hint}`, true);
  }
  return r.json();
}

type Usage = { in: number; out: number };

async function callOnce(m: Model, style: string, system: string, user: string, json: boolean): Promise<{ text: string; usage: Usage }> {
  if (style === "responses") {
    const part = (t: string) => [{ type: "input_text", text: t }];
    const full = {
      model: m.model_code,
      stream: false,
      input: [...(system ? [{ role: "system", content: part(system) }] : []), { role: "user", content: part(user) }],
      temperature: m.temperature_rate,
      top_p: m.top_p_rate,
      max_output_tokens: m.max_token_qty,
    };
    let data: any;
    try {
      data = await post(m, `${baseOf(m)}/responses`, extra(m, full), style);
    } catch (e) {
      // 400 多半是模型不接受 system 角色或采样参数（如推理模型），退化为最小请求体重试一次
      if (!(e instanceof LlmError) || !e.message.includes("HTTP 400")) throw e;
      const minimal = { model: m.model_code, stream: false, input: [{ role: "user", content: part(system ? `${system}\n\n${user}` : user) }] };
      data = await post(m, `${baseOf(m)}/responses`, extra(m, minimal), style);
    }
    let t: string = data.output_text ?? "";
    if (!t) {
      const parts: string[] = [];
      for (const item of data.output ?? []) {
        if (item && typeof item === "object" && (item.type === undefined || item.type === "message")) {
          for (const c of item.content ?? []) {
            if (typeof c === "string") parts.push(c);
            else if (c?.text) parts.push(c.text);
          }
        }
      }
      t = parts.join("\n");
    }
    if (!t && typeof data.content === "string") t = data.content;
    const u = data.usage ?? {};
    return { text: t, usage: { in: u.input_tokens ?? u.prompt_tokens ?? 0, out: u.output_tokens ?? u.completion_tokens ?? 0 } };
  }
  const body: Dict = {
    model: m.model_code,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: m.temperature_rate,
    top_p: m.top_p_rate,
    max_tokens: m.max_token_qty,
  };
  if (json) body.response_format = { type: "json_object" };
  const data = await post(m, `${baseOf(m)}/chat/completions`, extra(m, body), style);
  const msg = data.choices?.[0]?.message ?? {};
  const u = data.usage ?? {};
  return { text: msg.content || msg.reasoning_content || "", usage: { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0 } };
}

const styleCache: Map<string, string> = ((globalThis as any).__genStyleCache ??= new Map());

/** 调用模型，返回文本与 token 用量。auto 协议先试对话接口，404 再试 Responses 接口；限流/5xx/网络错误指数退避重试 */
export async function chat(m: Model, system: string, user: string, opts: { retries?: number; json?: boolean } = {}): Promise<{ text: string; usage: Usage }> {
  const retries = opts.retries ?? 3;
  const key = `${m.base_url}|${m.model_code}`;
  const style = (m.api_style_type || "auto").trim();
  const styles = style === "chat" || style === "responses" ? [style] : styleCache.has(key) ? [styleCache.get(key)!] : ["chat", "responses"];
  let last: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (let i = 0; i < styles.length; i++) {
      try {
        const r = await callOnce(m, styles[i], system, user, !!opts.json);
        styleCache.set(key, styles[i]);
        return r;
      } catch (e) {
        if (e instanceof LlmError && !e.retryable) {
          if (i + 1 < styles.length && e.message.includes("HTTP 404")) continue;
          throw e;
        }
        last = e;
        break;
      }
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, Math.min(2 ** attempt, 8) * 1000));
  }
  throw new LlmError(`调用失败（重试 ${retries} 次）：${last instanceof Error ? last.message : String(last)}`);
}

export async function ping(m: Model) {
  const t0 = Date.now();
  const r = await chat(m, "你是一个健康检查探针。", "只回复两个字：正常", { retries: 1 });
  return { reply: r.text.trim().slice(0, 50), style: styleCache.get(`${m.base_url}|${m.model_code}`) ?? "chat", ms: Date.now() - t0, ...r.usage };
}

// ---------------------------------------------------------------- 模型输出 JSON 解析（容忍代码块与前后缀）

const strip = (t: string) => (t ?? "").replace(/```(?:json|JSON)?\s*|\s*```/g, "").trim();

export function parseJsonArray(t: string): any[] {
  const s = strip(t);
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {
    /* 继续尝试 */
  }
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(s.slice(a, b + 1));
      if (Array.isArray(v)) return v;
    } catch {
      /* 继续尝试 */
    }
  }
  // 退化：逐个提取顶层对象
  const items: any[] = [];
  let depth = 0;
  let buf = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      buf += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === "{") depth++;
    if (depth > 0) buf += ch;
    if (ch === "}") {
      depth--;
      if (depth === 0 && buf) {
        try {
          items.push(JSON.parse(buf));
        } catch {
          /* 跳过 */
        }
        buf = "";
      }
    }
  }
  if (items.length) return items;
  throw new LlmError(`无法解析为 JSON 数组：${s.slice(0, 200)}`);
}

export function parseJsonObject(t: string): Dict {
  const s = strip(t);
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v) && v[0] && typeof v[0] === "object") return v[0];
  } catch {
    /* 继续尝试 */
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(s.slice(a, b + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* 继续尝试 */
    }
  }
  throw new LlmError(`无法解析为 JSON 对象：${s.slice(0, 200)}`);
}

// ---------------------------------------------------------------- 任务执行

type State = { canceled: Set<number>; running: Set<number> };
const state: State = ((globalThis as any).__genState ??= { canceled: new Set(), running: new Set() });

export const isRunning = (id: number) => state.running.has(id);

function log(taskId: number, message: string, level: "info" | "warn" | "error" = "info") {
  getDb().prepare(`INSERT INTO ${G.log} (task_id, level_type, message_desc, create_time) VALUES (?,?,?,?)`).run(taskId, level, String(message).slice(0, 2000), nowStr());
}

function upd(table: string, idCol: string, id: number, kw: Dict) {
  const keys = Object.keys(kw);
  getDb()
    .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${idCol} = ?`)
    .run(...keys.map((k) => kw[k]), id);
}
const updTask = (id: number, kw: Dict) => upd(G.task, "task_id", id, kw);
const updAsset = (id: number, kw: Dict) => upd(G.asset, "asset_id", id, { ...kw, update_time: nowStr() });

export function refreshAssetStat(assetId: number) {
  const db = getDb();
  const c = db.prepare(`SELECT COUNT(*) AS units FROM ${G.conv} WHERE asset_id = ?`).get(assetId) as any;
  const a = db.prepare(`SELECT asset_kind_type FROM ${G.asset} WHERE asset_id = ?`).get(assetId) as any;
  const pairs =
    a?.asset_kind_type === "sft"
      ? (db.prepare(`SELECT COUNT(*) AS n FROM ${G.sample} WHERE asset_id = ?`).get(assetId) as any).n
      : (db.prepare(`SELECT COALESCE(SUM(turn_qty), 0) AS n FROM ${G.conv} WHERE asset_id = ?`).get(assetId) as any).n;
  updAsset(assetId, { unit_qty: c.units, pair_qty: pairs });
}

export function nextVersion(specCode: string) {
  const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM ${G.asset} WHERE spec_code = ?`).get(specCode) as any).n;
  return `v${n + 1}.0`;
}

const norm = (s: unknown) => [...String(s === null || s === undefined || s === "" ? "" : typeof s === "object" ? pyDumps(s) : s).replace(/[\s，。？！,.?!、：:；;“”"']/g, "")].slice(0, 150).join("");

/** 分配会话号并落库；撞到去重键或会话号时返回 null（Node 单线程 + 同步写库，天然无并发撞号） */
function insertConv(assetId: number, cfg: Dict, payload: Dict, sourceConvId = ""): { convId: string; turns: number } | null {
  const db = getDb();
  const seq = Number((db.prepare(`SELECT COALESCE(MAX(seq_no), 0) AS s FROM ${G.conv} WHERE asset_id = ?`).get(assetId) as any).s) + 1;
  const convId = String(payload.conversation_id || `C${String(seq).padStart(5, "0")}`);
  payload.conversation_id = convId;
  const turns: any[] = Array.isArray(payload.turns) ? payload.turns : [];
  payload.turn_count = turns.length;
  const dedup = createHash("md5").update(norm(getPath(payload, cfg.dedup_field || "turns.0"))).digest("hex");
  try {
    db.prepare(
      `INSERT INTO ${G.conv} (asset_id, conversation_id, seq_no, turn_qty, payload_json, dedup_key, source_conversation_id, create_time) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(assetId, convId, seq, turns.length, JSON.stringify(payload), dedup, sourceConvId, nowStr());
    return { convId, turns: turns.length };
  } catch (e: any) {
    if (String(e?.message ?? e).includes("UNIQUE")) return null;
    throw e;
  }
}

function avoidList(cfg: Dict, assetId: number): string {
  if (!cfg.avoid_field) return "（暂无）";
  const rows = getDb().prepare(`SELECT payload_json FROM ${G.conv} WHERE asset_id = ? ORDER BY conv_row_id DESC LIMIT 25`).all(assetId) as any[];
  const out: string[] = [];
  for (const r of rows) {
    const v = getPath(JSON.parse(r.payload_json), cfg.avoid_field);
    if (truthy(v)) out.push("- " + [...text(v)].slice(0, 48).join(""));
  }
  return out.join("\n") || "（暂无）";
}

/** 并发池：最多 n 个同时执行，返回结果按完成顺序回调 */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, stop: () => boolean) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !stop()) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

type Stat = { units: number; pairs: number; dup: number; fail: number; in: number; out: number; calls: number };
/** 继续执行（停止/失败后再次启动）时，在已产出的基础上累计 */
function resumeStat(assetId: number, task: any): Stat {
  refreshAssetStat(assetId);
  const a = getDb().prepare(`SELECT unit_qty, pair_qty FROM ${G.asset} WHERE asset_id = ?`).get(assetId) as any;
  return { units: a.unit_qty, pairs: a.pair_qty, dup: task.dup_qty ?? 0, fail: 0, in: task.token_in_qty ?? 0, out: task.token_out_qty ?? 0, calls: task.call_qty ?? 0 };
}
const flush = (id: number, s: Stat) =>
  updTask(id, { done_unit_qty: s.units, done_pair_qty: s.pairs, dup_qty: s.dup, fail_qty: s.fail, call_qty: s.calls, token_in_qty: s.in, token_out_qty: s.out });

async function runDetail(task: any, spec: Spec, model: Model, prompt: { system: string; user: string }, assetId: number): Promise<Stat> {
  const cfg = spec.cfg;
  const params = JSON.parse(task.param_json || "{}");
  const variables = { ...(cfg.variables ?? {}), ...(params.variables ?? {}) };
  const filters = params.filters ?? {};
  const target = Number(task.target_qty);
  const batch = Math.max(1, Number(task.batch_qty));
  const workers = Math.max(1, Number(task.concurrency_qty));
  const dicts = loadDicts();
  const dv = dictVars(dicts);
  const s = resumeStat(assetId, task);

  const once = async (i: number) => {
    const ctx: Dict = { ...dv, ...variables, ...resolveDimensions(cfg.dimensions, i, dicts, filters), batch_size: batch, avoid_list: avoidList(cfg, assetId) };
    const label = (cfg.dimensions ?? []).map((d: Dict) => ctx[d.var]).filter(truthy).map(String).join(" / ");
    const t0 = Date.now();
    s.calls++;
    try {
      const r = await chat(model, render(prompt.system, ctx), render(prompt.user, ctx));
      s.in += r.usage.in;
      s.out += r.usage.out;
      const items = parseJsonArray(r.text);
      let ok = 0;
      let dup = 0;
      let pairs = 0;
      for (const it of items) {
        if (s.units >= target) break; // 不超过目标会话数
        if (!it || typeof it !== "object" || Array.isArray(it) || (cfg.required ?? []).some((f: string) => !truthy(it[f]))) continue;
        for (const k of cfg.inherit_vars ?? []) if (k in ctx && !truthy(it[k])) it[k] = ctx[k];
        for (const d of cfg.dimensions ?? []) if (d.var in ctx && !truthy(it[d.var])) it[d.var] = ctx[d.var];
        const res = insertConv(assetId, cfg, it);
        if (res) {
          ok++;
          pairs += res.turns;
          s.units++;
          s.pairs += res.turns;
        } else {
          dup++;
          s.dup++;
        }
      }
      log(task.task_id, `✓ ${label || "批次"} → 新增 ${ok} 段会话 / ${pairs} 对${dup ? `，去重 ${dup}` : ""}（${Date.now() - t0}ms）`);
    } catch (e: any) {
      s.fail++;
      log(task.task_id, `✗ ${String(e?.message ?? e).slice(0, 400)}`, "error");
    }
    flush(task.task_id, s);
  };

  let i = 0;
  let guard = 0;
  let stuck = 0; // 连续多少轮没有新增（多半是去重撞满或模型重复输出）
  while (s.units < target && !state.canceled.has(task.task_id) && guard < 500) {
    guard++;
    const before = s.units;
    const wave = Math.min(workers, Math.max(1, Math.ceil((target - s.units) / batch)));
    await Promise.all(Array.from({ length: wave }, (_, k) => once(i + k)));
    i += wave;
    if (s.fail >= 5 && s.units === 0) throw new Error(`连续失败 ${s.fail} 次且没有任何产出，已中止；请检查模型配置与提示词`);
    stuck = s.units === before ? stuck + 1 : 0;
    if (stuck >= 3) {
      log(task.task_id, `连续 ${stuck} 轮没有新增会话（去重命中 ${s.dup} 条），提前结束以免空跑消耗 token。建议扩大覆盖类目、调高温度或调整提示词。`, "warn");
      break;
    }
  }
  return s;
}

/** AI 预标注的来源会话：all=明细资产全部会话；delivered=只取已交付需求中审核后的内容（剔除的不要） */
export function sourceConversations(srcAssetId: number, scope: string, limit: number, offset = 0): { conv_id: string; seq: number; payload: Dict; dedup: string }[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT conv_row_id, conversation_id, seq_no, payload_json, dedup_key FROM ${G.conv} WHERE asset_id = ? ORDER BY seq_no`)
    .all(srcAssetId) as any[];
  const out: { conv_id: string; seq: number; payload: Dict; dedup: string }[] = [];
  const latest = db.prepare(
    `SELECT i.label_content, i.label_tag FROM ads.ads_llm_lbl_item_f i JOIN ads.ads_llm_lbl_requirement_f r ON r.requirement_id = i.requirement_id
     WHERE i.source_code = ? AND i.source_row_id = ? AND r.requirement_status IN (5, 6) ORDER BY r.deliver_time DESC, i.item_id DESC LIMIT 1`,
  );
  let skipped = 0;
  for (const r of rows) {
    let payload = JSON.parse(r.payload_json);
    if (scope === "delivered") {
      const it = latest.get(`${GEN_SOURCE_PREFIX}${srcAssetId}`, r.conv_row_id) as any;
      if (!it || it.label_tag === 3) continue;
      if (it.label_content) payload = JSON.parse(it.label_content);
    }
    if (skipped++ < offset) continue;
    out.push({ conv_id: r.conversation_id, seq: r.seq_no, payload, dedup: r.dedup_key });
    if (out.length >= limit) break;
  }
  return out;
}

/** 预标注一段会话：逐轮调用模型，返回各轮字段、组装后的样本与任务变量 */
async function labelConversation(
  cfg: Dict,
  model: Model,
  prompt: { system: string; user: string },
  payload: Dict,
  convId: string,
  baseVars: Dict,
  dims: { dicts: Dict; filters: Dict; index: number },
  dv: Dict,
  usage: (u: Usage) => void,
  extraUser = "",
  jobVarsIn?: Dict[],
) {
  const exp = cfg.expand ?? {};
  const turns: Dict[] = payload[exp.field || "turns"] ?? [];
  const histTpl = exp.history_template ?? "";
  const history: string[] = [];
  const out: { fields: Dict; jvars: Dict }[] = [];
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    const jvars: Dict = jobVarsIn?.[ti]
      ? { ...jobVarsIn[ti] }
      : { ...baseVars, ...resolveDimensions(cfg.dimensions, dims.index * 10 + ti, dims.dicts, dims.filters) };
    jvars[exp.index_var || "turn_index"] = ti + 1;
    jvars[exp.total_var || "turn_total"] = turns.length;
    jvars[exp.history_var || "history"] = history.join(exp.history_join || "\n");
    const ctx = buildCtx(dv, payload, turn, jvars);
    ctx.conv_json = JSON.stringify(payload, null, 2);
    ctx.conv_id = convId;
    const r = await chat(model, render(prompt.system, ctx), render(prompt.user, ctx) + extraUser);
    usage(r.usage);
    const fields = parseJsonObject(r.text);
    out.push({ fields, jvars });
    if (histTpl) history.push(render(histTpl, { ...turn, ...fields }));
  }
  return out;
}

async function runLabel(task: any, spec: Spec, model: Model, prompt: { system: string; user: string }, assetId: number): Promise<Stat> {
  const cfg = spec.cfg;
  const params = JSON.parse(task.param_json || "{}");
  const variables = { ...(cfg.variables ?? {}), ...(params.variables ?? {}) };
  const scope = params.source_scope === "delivered" ? "delivered" : "all";
  const convs = sourceConversations(Number(task.source_asset_id), scope, Number(task.target_qty), Number(params.offset || 0));
  if (!convs.length) throw new Error(scope === "delivered" ? "来源明细资产还没有已交付的标注结果" : "来源明细资产没有会话");
  const dicts = loadDicts();
  const dv = dictVars(dicts);
  const db = getDb();
  const s = resumeStat(assetId, task);
  const exists = db.prepare(`SELECT 1 FROM ${G.conv} WHERE asset_id = ? AND conversation_id = ?`);
  const insSample = db.prepare(
    `INSERT INTO ${G.sample} (asset_id, conversation_id, turn_no, sample_id, content_json, meta_json, job_var_json, is_valid, invalid_reason_desc, create_time)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const indexed = convs.map((c, idx) => ({ ...c, idx }));
  await pool(
    indexed,
    Number(task.concurrency_qty) || 1,
    async (c) => {
      if (exists.get(assetId, c.conv_id)) return; // 续跑时跳过已完成的会话
      try {
        const res = await labelConversation(cfg, model, prompt, c.payload, c.conv_id, variables, { dicts, filters: params.filters ?? {}, index: c.idx }, dv, (u) => {
          s.calls++;
          s.in += u.in;
          s.out += u.out;
        });
        // 会话与全部样本一次性落库，避免半截数据
        const samples = assembleConversation(cfg, c.payload, res.map((x) => x.fields), res.map((x) => x.jvars), dv);
        db.exec("BEGIN");
        try {
          const seq = Number((db.prepare(`SELECT COALESCE(MAX(seq_no), 0) AS s FROM ${G.conv} WHERE asset_id = ?`).get(assetId) as any).s) + 1;
          db.prepare(
            `INSERT INTO ${G.conv} (asset_id, conversation_id, seq_no, turn_qty, payload_json, dedup_key, source_conversation_id, create_time) VALUES (?,?,?,?,?,?,?,?)`,
          ).run(assetId, c.conv_id, seq, (c.payload.turns ?? []).length, JSON.stringify(c.payload), c.dedup, c.conv_id, nowStr());
          samples.forEach((smp, ti) => {
            const { valid, reason, ...content } = smp;
            const meta = Object.fromEntries((cfg.meta_vars ?? []).filter((k: string) => k in res[ti].jvars).map((k: string) => [k, res[ti].jvars[k]]));
            insSample.run(assetId, c.conv_id, ti + 1, smp.sample_id, JSON.stringify(content), JSON.stringify(meta), JSON.stringify(res[ti].jvars), valid ? 1 : 0, reason, nowStr());
          });
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        s.units++;
        s.pairs += samples.length;
        const bad = samples.filter((x) => !x.valid).length;
        log(task.task_id, `✓ 会话 ${c.conv_id} → ${samples.length} 条样本${bad ? `（${bad} 条未通过规格校验，待人工修正）` : ""}`);
      } catch (e: any) {
        s.fail++;
        log(task.task_id, `✗ 会话 ${c.conv_id}：${String(e?.message ?? e).slice(0, 400)}`, "error");
      }
      flush(task.task_id, s);
    },
    () => state.canceled.has(task.task_id),
  );
  if (s.fail >= 5 && s.units === 0) throw new Error(`失败 ${s.fail} 次且没有任何产出，请检查模型配置与提示词`);
  return s;
}

async function runTask(taskId: number) {
  const db = getDb();
  const t = db.prepare(`SELECT * FROM ${G.task} WHERE task_id = ?`).get(taskId) as any;
  let assetId = Number(t.asset_id) || 0;
  try {
    const spec = getSpec(t.spec_code);
    const model = getModel(t.model_id);
    if (!String(model.api_key_value ?? "").trim()) throw new Error(`模型「${model.model_name}」缺少 API Key：请到 数据资产 → 生成配置 → 模型管理 填写`);
    // 固化提示词版本：任何一条数据都能回溯到生成时的确切提示词
    const prompt = promptVersion(t.prompt_id);
    updTask(taskId, { prompt_version_no: prompt.version_no });
    if (!assetId) {
      const ver = nextVersion(t.spec_code);
      assetId = Number(
        db
          .prepare(
            `INSERT INTO ${G.asset} (asset_name, asset_kind_type, spec_code, task_id, version_no, asset_status, tag_json, user_id, create_time, update_time)
             VALUES (?,?,?,?,?,1,?,?,?,?)`,
          )
          .run(`${spec.spec_name}-${ver}`, spec.spec_kind_type, t.spec_code, taskId, ver, spec.tag_json || "{}", t.user_id, nowStr(), nowStr()).lastInsertRowid,
      );
      updTask(taskId, { asset_id: assetId });
    } else updAsset(assetId, { asset_status: 1 });
    log(taskId, `开始执行：模型「${model.model_name}」，提示词「${prompt.prompt_name}」v${prompt.version_no}，目标 ${t.target_qty} 段会话`);
    const run = spec.spec_kind_type === "detail" ? runDetail : runLabel;
    const s = await run({ ...t, prompt_version_no: prompt.version_no }, spec, model, prompt, assetId);
    const canceled = state.canceled.has(taskId);
    updTask(taskId, { task_status: canceled ? 5 : 3, finish_time: nowStr() });
    refreshAssetStat(assetId);
    updAsset(assetId, { asset_status: 2 });
    log(taskId, `${canceled ? "任务已停止" : "任务结束"}：${s.units} 段会话 / ${s.pairs} ${spec.spec_kind_type === "sft" ? "条样本" : "对问答"}，资产已入库，可在需求区作为数据源发布标注需求`);
  } catch (e: any) {
    updTask(taskId, { task_status: 4, error_desc: String(e?.message ?? e).slice(0, 1000), finish_time: nowStr() });
    log(taskId, `任务失败：${String(e?.message ?? e).slice(0, 800)}`, "error");
    if (assetId) {
      refreshAssetStat(assetId);
      const n = (db.prepare(`SELECT unit_qty FROM ${G.asset} WHERE asset_id = ?`).get(assetId) as any).unit_qty;
      updAsset(assetId, { asset_status: n ? 2 : 3 });
    }
  } finally {
    state.canceled.delete(taskId);
    state.running.delete(taskId);
  }
}

/** 后台启动任务（不阻塞请求） */
export function startTask(taskId: number) {
  if (state.running.has(taskId)) throw new HttpError(409, "任务正在执行");
  state.running.add(taskId);
  state.canceled.delete(taskId);
  updTask(taskId, { task_status: 2, error_desc: "", start_time: nowStr(), finish_time: null });
  void runTask(taskId);
}

export function cancelTask(taskId: number) {
  if (!state.running.has(taskId)) throw new HttpError(409, "任务未在执行");
  state.canceled.add(taskId);
  log(taskId, "收到停止指令，等待在途调用结束", "warn");
}

// ---------------------------------------------------------------- 作为标注数据源

/** 生成资产登记为数据源（编码 gen_asset_<资产ID>，标注单位 = 会话） */
export function genSources(): Source[] {
  const rows = getDb()
    .prepare(
      `SELECT a.*, s.spec_name, s.config_json, s.remark_desc AS spec_remark FROM ${G.asset} a LEFT JOIN ${G.spec} s ON s.spec_code = a.spec_code ORDER BY a.asset_id DESC`,
    )
    .all() as any[];
  return rows.map((a) => {
    let cfg: Dict = {};
    try {
      cfg = JSON.parse(a.config_json || "{}");
    } catch {
      /* 忽略 */
    }
    const labels: Record<string, string> = {};
    for (const f of [...(cfg.conv_fields ?? []), ...(cfg.turn_fields ?? []), ...(cfg.turn_view ?? []), ...(cfg.ai_fields ?? [])]) if (f.label) labels[f.key] = f.label;
    return {
      name: `${GEN_SOURCE_PREFIX}${a.asset_id}`,
      db: "ads",
      table: "ads_llm_gen_conversation_f",
      title: `${a.asset_name}`,
      comment: a.spec_remark ?? "",
      kind: "gen" as const,
      rows: a.unit_qty,
      columns: [],
      viewColumns: [],
      searchColumns: [],
      labels,
      enums: {},
      gen: { assetId: a.asset_id, kind: a.asset_kind_type, specCode: a.spec_code, specName: a.spec_name ?? a.spec_code, status: a.asset_status },
    };
  });
}

export type GenContext = { cfg: Dict; dv: Dict; jobVars: Dict[]; convId: string };

function convRow(src: Source, rowId: number) {
  const r = getDb().prepare(`SELECT * FROM ${G.conv} WHERE conv_row_id = ? AND asset_id = ?`).get(rowId, src.gen!.assetId) as any;
  if (!r) throw new HttpError(404, "源会话不存在");
  return r;
}

/** 条目原始内容：明细=会话 JSON；训练集={conversation 会话, labels 各轮 AI 字段} */
export function loadGenContent(src: Source, rowId: number): Dict {
  const r = convRow(src, rowId);
  const payload = JSON.parse(r.payload_json);
  if (src.gen!.kind === "detail") return payload;
  const samples = getDb()
    .prepare(`SELECT content_json FROM ${G.sample} WHERE asset_id = ? AND conversation_id = ? ORDER BY turn_no`)
    .all(src.gen!.assetId, r.conversation_id) as any[];
  return { conversation: payload, labels: samples.map((s) => JSON.parse(s.content_json).fields ?? {}) };
}

/** 组装样本所需的上下文：规格配置、字典变量、各轮生成时的任务变量 */
export function genContext(src: Source, rowId: number, memo?: Map<string, { cfg: Dict; dv: Dict }>): GenContext {
  const r = convRow(src, rowId);
  const shared = memo?.get(src.gen!.specCode) ?? { cfg: getSpec(src.gen!.specCode).cfg, dv: dictVars(loadDicts()) };
  memo?.set(src.gen!.specCode, shared);
  const { cfg, dv } = shared;
  const jobVars =
    src.gen!.kind === "sft"
      ? (
          getDb()
            .prepare(`SELECT job_var_json FROM ${G.sample} WHERE asset_id = ? AND conversation_id = ? ORDER BY turn_no`)
            .all(src.gen!.assetId, r.conversation_id) as any[]
        ).map((s) => JSON.parse(s.job_var_json || "{}"))
      : [];
  return { cfg, dv, jobVars, convId: r.conversation_id };
}

const isObj = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

export function validateGenContent(src: Source, content: Dict, original: Dict, ctx: GenContext): string[] {
  const errs: string[] = [];
  const conv = src.gen!.kind === "detail" ? content : content?.conversation;
  const origConv = src.gen!.kind === "detail" ? original : original.conversation;
  if (!isObj(conv)) return ["会话内容必须是 JSON 对象"];
  if (conv.conversation_id !== origConv.conversation_id) errs.push(`conversation_id 不能修改（应为 ${origConv.conversation_id}）`);
  const turns = conv.turns;
  if (!Array.isArray(turns) || !turns.length || turns.some((t) => !isObj(t))) {
    errs.push("turns 必须是非空的对象数组");
    return errs;
  }
  if (src.gen!.kind === "detail") {
    for (const f of ctx.cfg.required ?? []) if (!truthy(conv[f])) errs.push(`${f} 不能为空`);
    return errs;
  }
  if (turns.length !== origConv.turns.length) errs.push(`训练集会话的轮次数不能增减（应为 ${origConv.turns.length} 轮）`);
  const labels = content.labels;
  if (!Array.isArray(labels) || labels.length !== original.labels.length || labels.some((l: unknown) => !isObj(l))) {
    errs.push(`labels 必须是 ${original.labels.length} 个对象（每轮一个）`);
    return errs;
  }
  assembleConversation(ctx.cfg, conv, labels, ctx.jobVars, ctx.dv).forEach((s, i) => {
    if (!s.valid) errs.push(`第 ${i + 1} 轮：${s.reason}`);
  });
  return errs;
}

export function normalizeGenContent(src: Source, content: Dict): string {
  if (src.gen!.kind === "detail") return JSON.stringify({ ...content, turn_count: (content.turns ?? []).length });
  return JSON.stringify({ conversation: { ...content.conversation, turn_count: (content.conversation.turns ?? []).length }, labels: content.labels });
}

/** 交付 JSONL 行：明细=每行一段会话；训练集=每轮一行 {sample_id, conversation_id, messages}（与 Lumos 导出格式一致） */
export function genExportLines(src: Source, content: Dict, ctx: GenContext): Dict[] {
  if (src.gen!.kind === "detail") return [content];
  return assembleConversation(ctx.cfg, content.conversation, content.labels, ctx.jobVars, ctx.dv).map((s) => sampleLine(s, ctx.convId));
}

/** 列表预览文本 */
export function genPreview(src: Source, content: Dict): string {
  const conv = src.gen!.kind === "detail" ? content : content?.conversation;
  const t0 = conv?.turns?.[0] ?? {};
  const v = Object.values(t0).find((x) => typeof x === "string" && x.trim());
  const head = [conv?.category, conv?.scenic_name, conv?.sub_spot].filter(Boolean).join(" · ");
  return `${conv?.conversation_id ?? ""} ${head ? `[${head}] ` : ""}${String(v ?? "").slice(0, 80)}`;
}

/**
 * AI 再标（生成资产）：
 *   训练集：用生成时的模型与固化版本的提示词，按标注标准逐轮重新预标注；
 *   明细：用生成时的模型，按标注标准与原生成要求检查并修正整段会话。
 */
export async function genRelabel(src: Source, rowId: number, current: Dict, standard: string): Promise<{ content: Dict; reason: string }> {
  const db = getDb();
  const asset = db.prepare(`SELECT * FROM ${G.asset} WHERE asset_id = ?`).get(src.gen!.assetId) as any;
  const task = asset?.task_id ? (db.prepare(`SELECT * FROM ${G.task} WHERE task_id = ?`).get(asset.task_id) as any) : null;
  const model = pickModel(task?.model_id);
  if (!model) throw new HttpError(503, "没有可用的大模型：请在 数据资产 → 生成配置 → 模型管理 中为模型填写 API Key");
  const promptRow = task
    ? promptVersion(task.prompt_id, task.prompt_version_no)
    : (() => {
        const p = db.prepare(`SELECT prompt_id FROM ${G.prompt} WHERE spec_code = ? ORDER BY prompt_id LIMIT 1`).get(src.gen!.specCode) as any;
        return p ? promptVersion(p.prompt_id) : null;
      })();
  const ctx = genContext(src, rowId);
  if (src.gen!.kind === "sft") {
    if (!promptRow) throw new HttpError(400, "找不到该规格的提示词");
    const res = await labelConversation(
      ctx.cfg, model, promptRow, current.conversation, ctx.convId, {}, { dicts: {}, filters: {}, index: 0 }, ctx.dv, () => {},
      `\n\n【标注标准（人工标注要求，优先遵守）】\n${standard}`, ctx.jobVars,
    );
    return {
      content: { conversation: current.conversation, labels: res.map((x) => x.fields) },
      reason: `已用「${model.model_name}」与提示词「${promptRow.prompt_name}」v${promptRow.version_no}（生成时版本）重新预标注 ${res.length} 轮`,
    };
  }
  const r = await chat(
    model,
    `你是严谨的数据标注专家。\n【标注标准】\n${standard}`,
    `这是一段 AI 生成的明细会话数据（JSON）。请依据标注标准与原生成要求逐项检查，必要时修正内容；字段结构与 conversation_id 保持不变，轮次可在必要时修正内容但不要无故增删。
只输出 JSON：{"record": <修正后的完整会话对象>, "reason": "<修改理由，无需修改则说明正确>"}
${promptRow ? `\n【原生成要求】\n${promptRow.system}\n` : ""}
【待标注数据】
${JSON.stringify(current)}`,
    { json: true, retries: 2 },
  );
  const out = parseJsonObject(r.text);
  return { content: isObj(out.record) ? out.record : current, reason: String(out.reason ?? "") };
}

