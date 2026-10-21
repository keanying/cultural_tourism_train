import "server-only";
import { HttpError } from "./db";

// 数据资产 · AI 生成接口的参数校验工具

export const maskKey = (k: string | null) => (k ? `${k.slice(0, 3)}****${k.slice(-4)}` : "");

export function modelFields(b: Record<string, any>, partial = false) {
  const out: Record<string, any> = {};
  const str = (k: string, col = k, required = false) => {
    if (b[k] === undefined) {
      if (required && !partial) throw new HttpError(400, `请填写 ${k}`);
      return;
    }
    const v = String(b[k] ?? "").trim();
    if (required && !v) throw new HttpError(400, `请填写 ${k}`);
    out[col] = v;
  };
  const num = (k: string, col: string, min: number, max: number) => {
    if (b[k] === undefined || b[k] === "") return;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${k} 取值应在 ${min}~${max}`);
    out[col] = v;
  };
  str("model_name", "model_name", true);
  str("provider_name");
  str("base_url", "base_url", true);
  str("model_code", "model_code", true);
  if (b.api_style_type !== undefined) {
    if (!["auto", "chat", "responses"].includes(b.api_style_type)) throw new HttpError(400, "接口协议只能是 auto/chat/responses");
    out.api_style_type = b.api_style_type;
  }
  num("temperature_rate", "temperature_rate", 0, 2);
  num("top_p_rate", "top_p_rate", 0, 1);
  num("max_token_qty", "max_token_qty", 1, 1_000_000);
  num("timeout_sec_qty", "timeout_sec_qty", 5, 3600);
  if (b.extra_body_json !== undefined) {
    try {
      const v = JSON.parse(b.extra_body_json || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    } catch {
      throw new HttpError(400, "额外请求参数必须是 JSON 对象");
    }
    out.extra_body_json = b.extra_body_json || "{}";
  }
  if (b.api_key_value) out.api_key_value = String(b.api_key_value).trim();
  if (b.clear_key) out.api_key_value = "";
  if (b.is_active !== undefined) out.is_active = b.is_active ? 1 : 0;
  if (b.is_default !== undefined) out.is_default = b.is_default ? 1 : 0;
  str("remark_desc");
  return out;
}


const CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function checkCode(code: unknown, what: string): string {
  const c = String(code ?? "").trim();
  if (!CODE_RE.test(c)) throw new HttpError(400, `${what}只能用小写字母、数字、下划线，且以字母开头`);
  return c;
}

export function parseJsonText(text: unknown, what: string, shape: "object" | "any" = "object"): any {
  let v: any;
  try {
    v = typeof text === "string" ? JSON.parse(text) : text;
  } catch (e: any) {
    throw new HttpError(400, `${what}不是合法 JSON：${e.message}`);
  }
  if (shape === "object" && (!v || typeof v !== "object" || Array.isArray(v))) throw new HttpError(400, `${what}必须是 JSON 对象`);
  return v;
}

/** 规格配置校验：训练集规格必须定义样本模板 messages */
export function checkSpecConfig(cfg: any, kind: string) {
  if (kind === "sft") {
    if (!Array.isArray(cfg.messages) || !cfg.messages.length || cfg.messages.some((m: any) => !m?.role || typeof m.content !== "string")) {
      throw new HttpError(400, "训练集规格的 config 必须包含 messages 样本模板（[{role, content}]）");
    }
  }
  for (const d of cfg.dimensions ?? []) if (!d?.var) throw new HttpError(400, "dimensions 中每个维度都必须有 var");
}
