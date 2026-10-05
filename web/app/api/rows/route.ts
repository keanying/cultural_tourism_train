import { buildFilter, getDb, jsonError, q, requireSource, tableOf } from "@/lib/db";
import { answerPreview } from "@/lib/sft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 分页列表：GET /api/rows?source=&page=&pageSize=&q=&split=&edited= */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const s = requireSource(sp.get("source"));
    const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize") ?? 20) || 20));
    const { where, params } = buildFilter(s, sp);
    const db = getDb();
    const table = tableOf(s);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as any).n as number;
    const offset = (page - 1) * pageSize;
    if (s.kind === "sft") {
      const rows = (
        db
          .prepare(
            `SELECT row_id, sample_no, split_type, split_seq_no, user_content, assistant_content, is_edited, update_time
             FROM ${table} ${where} ORDER BY row_id LIMIT ? OFFSET ?`,
          )
          .all(...params, pageSize, offset) as any[]
      ).map((r) => ({
        _id: r.row_id,
        sid: r.sample_no,
        split: r.split_type,
        idx: r.split_seq_no,
        user: r.user_content.length > 160 ? r.user_content.slice(0, 160) + "…" : r.user_content,
        answer: answerPreview(r.assistant_content),
        _edited: r.is_edited,
        updated_at: r.update_time,
      }));
      return Response.json({ rows, total, page, pageSize });
    }
    const cols = ["row_id AS _id", ...s.viewColumns.map(q), "is_edited AS _edited"].join(", ");
    const rows = db.prepare(`SELECT ${cols} FROM ${table} ${where} ORDER BY row_id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return Response.json({ rows, total, page, pageSize });
  } catch (e) {
    return jsonError(e);
  }
}
