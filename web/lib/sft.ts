// 训练样本的格式工具与校验规则（前端实时提示与后端保存校验共用，规则与 distill/validate.py 保持一致）

export const ASSISTANT_RE = /^<thought>\n([\s\S]+)\n<\/thought>\n<answer>\n([\s\S]+)\n<\/answer>$/;

export function splitAssistant(content: string): { thought: string; answer: string } | null {
  const m = ASSISTANT_RE.exec(content);
  return m ? { thought: m[1], answer: m[2] } : null;
}

export function joinAssistant(thought: string, answer: string): string {
  return `<thought>\n${thought.trim()}\n</thought>\n<answer>\n${answer.trim()}\n</answer>`;
}

// 与 Python json.dumps(ensure_ascii=False) 相同的风格：逗号、冒号后带空格，保证与原数据格式一致
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

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

type Json = Record<string, any>;

function parse(text: string): Json | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const pctNum = (s: string) => parseFloat(String(s).replace("%", "")) / 100;

/** 返回错误列表，空数组表示通过。 */
export function validateSft(task: string, user: string, assistant: string): string[] {
  const errs: string[] = [];
  const u = parse(user);
  if (!u) errs.push("用户输入（user）不是合法 JSON");
  const parts = splitAssistant(assistant);
  if (!parts) {
    errs.push("回答必须严格为 <thought>…</thought> + <answer>…</answer> 结构");
    return errs;
  }
  if (!parts.thought.trim()) errs.push("<thought> 不能为空");
  if (task === "combo_recommend") {
    if (u) {
      const names: string[] = (u.available_products ?? []).map((p: Json) => p.name);
      const quoted = [...parts.answer.matchAll(/「(.+?)」/g)].map((m) => m[1]);
      const noRec = /不太适合|暂无|不给您硬推/.test(parts.answer);
      if (!noRec && !names.some((n) => parts.answer.includes(n))) errs.push("推荐话术中未出现库存列表内的商品名称");
      const unknown = quoted.filter((q) => !names.some((n) => n.includes(q) || q.includes(n)));
      if (!noRec && unknown.length) errs.push(`话术引用了库存外的商品：${unknown.join("、")}`);
    }
    return errs;
  }
  const a = parse(parts.answer);
  if (!a) {
    errs.push("<answer> 内必须是合法 JSON");
    return errs;
  }
  if (!u) return errs;
  if (task === "dynamic_pricing") {
    for (const k of ["action", "suggested_price", "confidence", "reason", "rule_id"]) if (!(k in a)) errs.push(`缺少字段 ${k}`);
    const r = u["定价规则"] ?? {};
    const sp = Number(a.suggested_price);
    if (sp < r["最低保底价"] || sp > r["最高限价"]) errs.push(`建议价 ${sp} 超出限价区间 [${r["最低保底价"]}, ${r["最高限价"]}]`);
    const cur = r["当前执行价"];
    const exp = sp > cur ? "raise_price" : sp < cur ? "lower_price" : "keep_price";
    if (a.action !== exp) errs.push(`action 应为 ${exp}（建议价与当前价 ${cur} 比较）`);
  } else if (task === "visitor_forecast") {
    const p: Json[] = a.predictions ?? [];
    const cap = u["景区信息"]?.["日最大承载量"];
    if (p.length !== 7) errs.push("predictions 必须为 7 天");
    if (p.some((x) => !(x.lower <= x.visitors && x.visitors <= x.upper && x.upper <= cap))) errs.push("存在不满足 下限≤预测≤上限≤承载量 的日期");
    if (p.reduce((s, x) => s + Number(x.visitors), 0) !== a.total_7d) errs.push("total_7d 与逐日预测之和不一致");
  } else if (task === "channel_placement") {
    const b = u["投放目标"]?.["总预算"];
    const al: Json[] = a.allocations ?? [];
    const tot = al.reduce((s, x) => s + Number(x.budget), 0) + Number(a.reserved_budget ?? 0);
    if (Math.abs(tot - b) > 2) errs.push(`分配合计 ${tot} ≠ 总预算 ${b}`);
    const cap = pctNum(u["约束条件"]?.["单渠道预算占比上限"] ?? "100%");
    if (al.some((x) => x.budget > b * cap + 1)) errs.push("存在超过单渠道占比上限的分配");
    const names = new Set((u["近3个月分渠道投放表现"] ?? []).map((x: Json) => x["渠道"]));
    if (al.some((x) => !names.has(x.channel))) errs.push("出现输入中不存在的渠道");
  } else if (task === "business_insight") {
    const cur = u["本期经营指标"], prev = u["对比期经营指标"];
    const dR = cur["总收入"] - prev["总收入"];
    const dV = cur["接待人次"] - prev["接待人次"];
    const sr = (a.revenue_attribution ?? []).reduce((s: number, x: Json) => s + Number(x.impact), 0);
    const sv = (a.visitor_attribution ?? []).reduce((s: number, x: Json) => s + Number(x.impact_visitors), 0);
    if (Math.abs(sr - dR) > 3) errs.push(`收入归因合计 ${sr} ≠ 收入差额 ${dR}`);
    if (dV && Math.abs(sv - dV) > 3) errs.push(`客流归因合计 ${sv} ≠ 客流差额 ${dV}`);
  }
  return errs;
}

export function answerPreview(assistant: string, max = 120): string {
  const p = splitAssistant(assistant);
  const t = (p ? p.answer : assistant).replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}
