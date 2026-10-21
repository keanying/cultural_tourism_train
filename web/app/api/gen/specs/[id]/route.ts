import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { checkSpecConfig, parseJsonText } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSpecRow(id: number) {
  const s = getDb().prepare(`SELECT * FROM ${G.spec} WHERE spec_id = ?`).get(id) as any;
  if (!s) throw new HttpError(404, "数据规格不存在");
  return s;
}

/** 修改规格（编码与产出类型不可改）。已有资产按新配置组装样本、校验与导出 */
export const PATCH = handle(async (req, { id }) => {
  const u = requireArea(req, "data");
  const s = getSpecRow(Number(id));
  const b = await body(req);
  const f: Record<string, any> = {};
  if (b.spec_name !== undefined) {
    f.spec_name = String(b.spec_name).trim();
    if (!f.spec_name) throw new HttpError(400, "请填写规格名称");
  }
  if (b.config_json !== undefined) {
    const cfg = parseJsonText(b.config_json, "规格配置");
    checkSpecConfig(cfg, s.spec_kind_type);
    f.config_json = JSON.stringify(cfg, null, 2);
  }
  if (b.tag_json !== undefined) f.tag_json = JSON.stringify(parseJsonText(b.tag_json, "资产标签"));
  if (b.remark_desc !== undefined) f.remark_desc = String(b.remark_desc);
  if (b.sort_no !== undefined) f.sort_no = Number(b.sort_no) || 100;
  if (b.is_active !== undefined) f.is_active = b.is_active ? 1 : 0;
  const keys = Object.keys(f);
  if (keys.length) {
    getDb().prepare(`UPDATE ${G.spec} SET ${keys.map((k) => `${k} = ?`).join(", ")}, update_time = ? WHERE spec_id = ?`).run(...keys.map((k) => f[k]), nowStr(), s.spec_id);
  }
  logAction(u.user_id, "gen.spec.update", "gen_spec", s.spec_id, keys.join(","));
  return Response.json({ ok: true });
});

export const DELETE = handle((req, { id }) => {
  const u = requireArea(req, "data");
  const s = getSpecRow(Number(id));
  const db = getDb();
  const n = (db.prepare(`SELECT (SELECT COUNT(*) FROM ${G.task} WHERE spec_code = ?) + (SELECT COUNT(*) FROM ${G.asset} WHERE spec_code = ?) AS n`).get(s.spec_code, s.spec_code) as any).n;
  if (n) throw new HttpError(409, "该规格已有生成任务或资产，不能删除（可停用）");
  db.prepare(`DELETE FROM ${G.spec} WHERE spec_id = ?`).run(s.spec_id);
  logAction(u.user_id, "gen.spec.delete", "gen_spec", s.spec_id, s.spec_code);
  return Response.json({ ok: true });
});
