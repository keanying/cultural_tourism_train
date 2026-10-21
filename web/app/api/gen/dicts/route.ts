import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { checkCode, parseJsonText } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 业务字典列表：提示词以 {{dict_编码}} 引用，规格维度以 dict 编码取值 */
export const GET = handle((req) => {
  requireArea(req, "data");
  const rows = getDb().prepare(`SELECT * FROM ${G.dict} ORDER BY dict_code`).all() as any[];
  return Response.json({ dicts: rows.map((r) => ({ ...r, value: JSON.parse(r.value_json), columns: r.column_list ? JSON.parse(r.column_list) : null })) });
});

export const POST = handle(async (req) => {
  const u = requireArea(req, "data");
  const b = await body(req);
  const code = checkCode(b.dict_code, "字典编码");
  const name = String(b.dict_name ?? "").trim();
  if (!name) throw new HttpError(400, "请填写字典名称");
  const value = parseJsonText(b.value_json ?? "[]", "字典内容", "any");
  const db = getDb();
  if (db.prepare(`SELECT 1 FROM ${G.dict} WHERE dict_code = ?`).get(code)) throw new HttpError(409, "字典编码已存在");
  db.prepare(`INSERT INTO ${G.dict} (dict_code, dict_name, value_json, column_list, update_time) VALUES (?,?,?,?,?)`).run(
    code, name, JSON.stringify(value), null, nowStr(),
  );
  logAction(u.user_id, "gen.dict.create", "gen_dict", null, code);
  return Response.json({ ok: true });
});
