import { logAction, requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, HttpError } from "@/lib/db";
import { G, GEN_SOURCE_PREFIX, getSpec } from "@/lib/gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getAsset(id: number) {
  const a = getDb()
    .prepare(
      `SELECT a.*, s.spec_name, t.task_no, t.task_name, t.prompt_version_no, p.prompt_name, m.model_name, sa.asset_name AS source_asset_name
       FROM ${G.asset} a LEFT JOIN ${G.spec} s ON s.spec_code = a.spec_code LEFT JOIN ${G.task} t ON t.task_id = a.task_id
       LEFT JOIN ${G.prompt} p ON p.prompt_id = t.prompt_id LEFT JOIN ${G.model} m ON m.model_id = t.model_id
       LEFT JOIN ${G.asset} sa ON sa.asset_id = t.source_asset_id WHERE a.asset_id = ?`,
    )
    .get(id) as any;
  if (!a) throw new HttpError(404, "资产不存在");
  return a;
}

/** 资产详情与会话预览 ?page=&pageSize=&q= */
export const GET = handle((req, { id }) => {
  requireArea(req, "data");
  const a = getAsset(Number(id));
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const size = Math.min(50, Math.max(1, Number(sp.get("pageSize") ?? 10) || 10));
  const q = (sp.get("q") ?? "").trim();
  const db = getDb();
  const where = `asset_id = ?${q ? " AND (conversation_id LIKE ? OR payload_json LIKE ?)" : ""}`;
  const args: (string | number)[] = [a.asset_id, ...(q ? [`%${q}%`, `%${q}%`] : [])];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${G.conv} WHERE ${where}`).get(...args) as any).n;
  const convs = (db.prepare(`SELECT * FROM ${G.conv} WHERE ${where} ORDER BY seq_no LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size) as any[]).map((c) => ({
    conv_row_id: c.conv_row_id,
    conversation_id: c.conversation_id,
    seq_no: c.seq_no,
    turn_qty: c.turn_qty,
    source_conversation_id: c.source_conversation_id,
    payload: JSON.parse(c.payload_json),
    samples:
      a.asset_kind_type === "sft"
        ? (db.prepare(`SELECT turn_no, sample_id, content_json, is_valid, invalid_reason_desc FROM ${G.sample} WHERE asset_id = ? AND conversation_id = ? ORDER BY turn_no`)
            .all(a.asset_id, c.conversation_id) as any[]).map((s) => ({ ...s, content: JSON.parse(s.content_json), content_json: undefined }))
        : [],
  }));
  const invalid = a.asset_kind_type === "sft" ? (db.prepare(`SELECT COUNT(*) AS n FROM ${G.sample} WHERE asset_id = ? AND is_valid = 0`).get(a.asset_id) as any).n : 0;
  const requirements = db
    .prepare(
      `SELECT r.requirement_id, r.requirement_name, r.requirement_status, p.project_name, COUNT(*) AS item_qty
       FROM ads.ads_llm_lbl_item_f i JOIN ads.ads_llm_lbl_requirement_f r ON r.requirement_id = i.requirement_id
       JOIN ads.ads_llm_lbl_project_f p ON p.project_id = r.project_id WHERE i.source_code = ? GROUP BY r.requirement_id ORDER BY r.requirement_id DESC`,
    )
    .all(`${GEN_SOURCE_PREFIX}${a.asset_id}`);
  let cfg = {};
  try {
    cfg = getSpec(a.spec_code).cfg;
  } catch {
    /* 规格已删除 */
  }
  return Response.json({ asset: a, cfg, total, page, pageSize: size, convs, invalid, requirements });
});

/** 删除资产（已被标注需求引用、或任务正在生成时不能删除） */
export const DELETE = handle((req, { id }) => {
  const u = requireArea(req, "data");
  const a = getAsset(Number(id));
  const db = getDb();
  if (a.asset_status === 1) throw new HttpError(409, "资产正在生成中");
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ads.ads_llm_lbl_item_f WHERE source_code = ?`).get(`${GEN_SOURCE_PREFIX}${a.asset_id}`) as any).n;
  if (n) throw new HttpError(409, "该资产已被标注需求引用，不能删除");
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM ${G.sample} WHERE asset_id = ?`).run(a.asset_id);
    db.prepare(`DELETE FROM ${G.conv} WHERE asset_id = ?`).run(a.asset_id);
    db.prepare(`DELETE FROM ${G.asset} WHERE asset_id = ?`).run(a.asset_id);
    db.prepare(`UPDATE ${G.task} SET asset_id = 0 WHERE asset_id = ?`).run(a.asset_id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  logAction(u.user_id, "gen.asset.delete", "gen_asset", a.asset_id, a.asset_name);
  return Response.json({ ok: true });
});
