// AI 生成的模板引擎：渲染、维度轮转、校验器、样本组装。
// 逐行移植自 Lumos engine.py，生成结果与原系统一致（scripts/check_tpl_parity.py 对拍）。
// 本文件不依赖任何模块，前端实时预览与后端生成、交付导出共用。

export type Dict = Record<string, any>;
export type Sample = { sample_id: string; fields: Dict; messages: { role: string; content: string }[] };
export type Assembled = Sample & { valid: boolean; reason: string };

/** 与 Python json.dumps(ensure_ascii=False) 相同的风格：逗号、冒号后带空格 */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`)
      .join(", ")}}`;
  }
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return JSON.stringify(v);
}

/** Python 的真值判断：None / "" / 0 / False / [] / {} 为假 */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

/** Python str()：True/False、None 与 JSON 对象的写法 */
function pyStr(v: unknown): string {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  if (typeof v === "object") return pyDumps(v);
  return String(v);
}

export function text(v: unknown, fmt?: string): string {
  if (v === null || v === undefined) return "";
  if (fmt === "json" || typeof v === "object") return pyDumps(v);
  return pyStr(v);
}

// ---------------------------------------------------------------- 渲染：{{x}} {{x|json}} {{#x}}…{{/x}} {{^x}}…{{/x}}
const W = "[\\p{L}\\p{N}\\p{M}_]+";
const SECTION = new RegExp(`\\{\\{([#^])(${W})\\}\\}([\\s\\S]*?)\\{\\{/\\2\\}\\}`, "gu");
const VAR = new RegExp(`\\{\\{(${W})(?:\\|(${W}))?\\}\\}`, "gu");

export function render(template: string | null | undefined, ctx: Dict): string {
  let out = template ?? "";
  for (let i = 0; i < 4; i++) {
    const next = out.replace(SECTION, (_m, sign: string, name: string, body: string) => (truthy(ctx[name]) === (sign === "#") ? body : ""));
    if (next === out) break;
    out = next;
  }
  return out.replace(VAR, (_m, name: string, fmt?: string) => text(ctx[name], fmt));
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const p of String(path).split(".")) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      if (!/^-?\d+$/.test(p)) return null;
      const i = Number(p);
      cur = i < 0 ? cur[cur.length + i] : cur[i];
      if (cur === undefined) return null;
    } else if (typeof cur === "object") {
      cur = cur[p];
      if (cur === undefined) return null;
    } else return null;
  }
  return cur;
}

export type FieldDef = { key: string; label?: string; path?: string; fmt?: string; sep?: string };

export function fieldText(payload: unknown, f: FieldDef): string {
  const v = getPath(payload, f.path || f.key);
  if (f.fmt === "json") return v !== null && v !== undefined ? pyDumps(v) : "";
  if (f.fmt === "join" && Array.isArray(v)) return v.map(pyStr).join(f.sep || " | ");
  return text(v);
}

// ---------------------------------------------------------------- 维度轮转
const choice = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

function dictItems(d: Dict, dicts: Dict): any[] {
  let val: any = d.dict ? dicts[d.dict] ?? [] : d.values ?? [];
  if (val && typeof val === "object" && !Array.isArray(val)) val = val[d.path] ?? [];
  return Array.isArray(val) ? val : [];
}

function itemValue(item: any, d: Dict): any {
  if (item && typeof item === "object" && !Array.isArray(item)) return item[d.value_field || "name"] || item.name || "";
  return item;
}

export function resolveDimensions(dims: Dict[] | undefined, index: number, dicts: Dict, filters: Dict = {}): Dict {
  const out: Dict = {};
  for (const d of dims ?? []) {
    const v = d.var;
    const mode = d.mode ?? "rotate";
    if (mode === "compose") {
      const parts: string[] = [];
      for (const p of d.parts ?? []) {
        const items = dictItems(p, dicts);
        if (items.length) parts.push(pyStr(itemValue(choice(items), p)));
      }
      out[v] = parts.join(d.join || "，");
      continue;
    }
    let items = dictItems(d, dicts);
    const keep: any[] = filters[v] || [];
    if (keep.length) {
      const kept = items.filter((x) => keep.includes(itemValue(x, d)));
      if (kept.length) items = kept;
    }
    if (!items.length) continue;
    let item: any;
    if (mode === "weighted") {
      const pool: any[] = [];
      for (const it of items) {
        const w = it && typeof it === "object" ? Math.trunc(Number(it[d.weight_field || "weight"] ?? 1)) || 1 : 1;
        for (let k = 0; k < Math.max(1, w); k++) pool.push(it);
      }
      item = pool[index % pool.length];
    } else if (mode === "random") item = choice(items);
    else item = items[index % items.length];
    out[v] = itemValue(item, d);
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const [pvar, field] of Object.entries((d.extra ?? {}) as Dict)) out[pvar] = text(item[field as string]);
      const child = d.child;
      if (child) {
        const lst: any[] = item[child.field] || [];
        if (lst.length) {
          const take = Math.trunc(Number(child.take || 1));
          const off = (index * take) % lst.length;
          out[child.var] = [...lst, ...lst].slice(off, off + take).map(pyStr).join(child.join || "、");
        }
      }
    }
  }
  return out;
}

/** 业务字典变量：列表渲染为 “- a | b” 多行文本，供提示词以 {{dict_xxx}} 引用 */
export function dictVars(dicts: Dict): Dict {
  const out: Dict = {};
  for (const [k, val] of Object.entries(dicts)) {
    if (k.startsWith("_")) continue;
    if (Array.isArray(val)) {
      out[`dict_${k}`] = val
        .map((it) =>
          it && typeof it === "object" && !Array.isArray(it)
            ? "- " + Object.values(it).filter((x) => !(x && typeof x === "object")).map(pyStr).join(" | ")
            : "- " + pyStr(it),
        )
        .join("\n");
    } else out[`dict_${k}`] = text(val);
  }
  return out;
}

// ---------------------------------------------------------------- 校验
function pyInt(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

export function runValidators(vals: Dict[] | undefined, ctx: Dict): [boolean, string] {
  for (const v of vals ?? []) {
    const t = v.type;
    const field = v.field;
    const val = ctx[field];
    const label = v.label || field;
    if (t === "nonempty") {
      const ok = val && typeof val === "object" ? truthy(val) : (truthy(val) ? pyStr(val) : "").trim() !== "";
      if (!ok) return [false, `${label} 为空`];
    } else if (t === "json_key") {
      if (!(val && typeof val === "object" && !Array.isArray(val)) || !truthy(val[v.key])) return [false, `${label} 缺少 ${v.key}`];
    } else if (t === "int_range") {
      const iv = pyInt(val);
      if (iv === null) return [false, `${label} 不是整数`];
      const lo = Number(v.min ?? -1e9);
      const hi = Number(v.max ?? 1e9);
      if (!(lo <= iv && iv <= hi)) return [false, `${label} 超出 ${v.min ?? "None"}~${v.max ?? "None"}`];
    } else if (t === "max_chars") {
      let limit = Math.trunc(Number(v.limit || 0));
      if (v.limit_from) {
        const m = new RegExp(v.limit_regex || "(\\d+)").exec(truthy(ctx[v.limit_from]) ? pyStr(ctx[v.limit_from]) : "");
        limit = m ? parseInt(m[1], 10) : 0;
      }
      if (limit) {
        const real = [...(truthy(val) ? pyStr(val) : "").replace(/\s/g, "")].length;
        if (real > limit * Number(v.tolerance || 1.0)) return [false, `正文 ${real} 字超出上限 ${limit} 字`];
      }
    }
  }
  return [true, ""];
}

// ---------------------------------------------------------------- 样本组装
export function buildCtx(dv: Dict, payload: Dict | null, turn: Dict | null, extra: Dict | null): Dict {
  const ctx: Dict = { ...dv };
  for (const [k, v] of Object.entries(payload ?? {})) if (k !== "turns") ctx[k] = v;
  Object.assign(ctx, turn ?? {}, extra ?? {});
  return ctx;
}

export function assemble(cfg: Dict, fields: Dict, payload: Dict, turn: Dict, jobVars: Dict, convId: string, dv: Dict): Assembled {
  const ctx = buildCtx(dv, payload, turn, jobVars);
  Object.assign(ctx, fields ?? {});
  ctx.conv_id = convId;
  const tpl = cfg.sample_id_template;
  let sid = tpl ? render(tpl, ctx).trim() : "";
  if (!sid || sid.includes("{{")) sid = `${convId}_t${text(jobVars.turn_index ?? 1)}`;
  const messages = (cfg.messages ?? []).map((m: Dict) => ({ role: m.role, content: render(m.content, ctx) }));
  const [valid, reason] = runValidators(cfg.validators, ctx);
  return { sample_id: sid, fields: fields ?? {}, messages, valid, reason };
}

/** 会话展开为样本：按轮次组装，history 按模板拼接前序轮次（人工改了问答或 AI 字段后据此重建） */
export function assembleConversation(cfg: Dict, payload: Dict, labels: Dict[], jobVars: Dict[], dv: Dict): Assembled[] {
  const turns: Dict[] = payload?.turns ?? [];
  const exp = cfg.expand ?? {};
  const histTpl = exp.history_template ?? "";
  const history: string[] = [];
  const convId = String(payload?.conversation_id ?? "");
  return labels.map((fields, i) => {
    const turn = turns[i] ?? {};
    const jv = { ...(jobVars[i] ?? {}) };
    jv[exp.history_var || "history"] = history.join(exp.history_join || "\n");
    const s = assemble(cfg, fields ?? {}, payload, turn, jv, convId, dv);
    if (histTpl) history.push(render(histTpl, { ...turn, ...(fields ?? {}) }));
    return s;
  });
}

/** 生成样本的导出行（与 Lumos 导出格式一致） */
export const sampleLine = (s: Sample, convId: string) => ({ sample_id: s.sample_id, conversation_id: convId, messages: s.messages });
