import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { checkCode, checkSpecConfig, parseJsonText } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 数据规格列表 */
export const GET = handle((req) => {
  requireArea(req, "data");
  const rows = getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM ${G.task} t WHERE t.spec_code = s.spec_code) AS task_qty,
              (SELECT COUNT(*) FROM ${G.asset} a WHERE a.spec_code = s.spec_code) AS asset_qty,
              (SELECT COUNT(*) FROM ${G.prompt} p WHERE p.spec_code = s.spec_code) AS prompt_qty
       FROM ${G.spec} s ORDER BY s.sort_no, s.spec_id`,
    )
    .all();
  return Response.json({ specs: rows });
});

export const POST = handle(async (req) => {
  const u = requireArea(req, "data");
  const b = await body(req);
  const code = checkCode(b.spec_code, "规格编码");
  const kind = b.spec_kind_type === "sft" ? "sft" : "detail";
  const name = String(b.spec_name ?? "").trim();
  if (!name) throw new HttpError(400, "请填写规格名称");
  const cfg = parseJsonText(b.config_json ?? "{}", "规格配置");
  checkSpecConfig(cfg, kind);
  const db = getDb();
  if (db.prepare(`SELECT 1 FROM ${G.spec} WHERE spec_code = ?`).get(code)) throw new HttpError(409, "规格编码已存在");
  const src = kind === "sft" ? String(b.source_spec_code ?? "") : "";
  if (kind === "sft" && !db.prepare(`SELECT 1 FROM ${G.spec} WHERE spec_code = ? AND spec_kind_type = 'detail'`).get(src)) {
    throw new HttpError(400, "训练集规格需要指定来源明细规格");
  }
  const now = nowStr();
  const id = Number(
    db
      .prepare(
        `INSERT INTO ${G.spec} (spec_code, spec_name, spec_kind_type, task_type, source_spec_code, tag_json, config_json, remark_desc, sort_no, create_time, update_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(code, name, kind, kind === "sft" ? "ai_label" : "detail_gen", src, JSON.stringify(parseJsonText(b.tag_json ?? "{}", "资产标签")),
        JSON.stringify(cfg, null, 2), String(b.remark_desc ?? ""), Number(b.sort_no) || 100, now, now).lastInsertRowid,
  );
  logAction(u.user_id, "gen.spec.create", "gen_spec", id, code);
  return Response.json({ spec_id: id });
});
