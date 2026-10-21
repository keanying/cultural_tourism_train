import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { parseJsonText } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getDict(code: string) {
  const d = getDb().prepare(`SELECT * FROM ${G.dict} WHERE dict_code = ?`).get(code) as any;
  if (!d) throw new HttpError(404, "字典不存在");
  return d;
}

export const PATCH = handle(async (req, { code }) => {
  const u = requireArea(req, "data");
  const d = getDict(code);
  const b = await body(req);
  const value = b.value_json !== undefined ? JSON.stringify(parseJsonText(b.value_json, "字典内容", "any")) : d.value_json;
  const name = b.dict_name !== undefined ? String(b.dict_name).trim() || d.dict_name : d.dict_name;
  getDb().prepare(`UPDATE ${G.dict} SET dict_name = ?, value_json = ?, update_time = ? WHERE dict_code = ?`).run(name, value, nowStr(), code);
  logAction(u.user_id, "gen.dict.update", "gen_dict", null, code);
  return Response.json({ ok: true });
});

export const DELETE = handle((req, { code }) => {
  const u = requireArea(req, "data");
  getDict(code);
  const db = getDb();
  const used = (db.prepare(`SELECT spec_code FROM ${G.spec} WHERE config_json LIKE ?`).all(`%"dict": "${code}"%`) as any[]).map((r) => r.spec_code);
  const usedP = (db.prepare(`SELECT prompt_code FROM ${G.prompt} WHERE system_prompt_text LIKE ? OR user_prompt_text LIKE ?`).all(`%{{dict_${code}}}%`, `%{{dict_${code}}}%`) as any[]).map((r) => r.prompt_code);
  if (used.length || usedP.length) throw new HttpError(409, `字典正在被引用：${[...used, ...usedP].join("、")}`);
  db.prepare(`DELETE FROM ${G.dict} WHERE dict_code = ?`).run(code);
  logAction(u.user_id, "gen.dict.delete", "gen_dict", null, code);
  return Response.json({ ok: true });
});
