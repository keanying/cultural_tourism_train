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
    const table = s.kind === "sft" ? "sft" : tableOf(s);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as any).n as number;
    const offset = (page - 1) * pageSize;
    if (s.kind === "sft") {
      const rows = (
        db
          .prepare(`SELECT _id, sid, split, idx, user, assistant, _edited, updated_at FROM sft ${where} ORDER BY _id LIMIT ? OFFSET ?`)
          .all(...params, pageSize, offset) as any[]
      ).map((r) => ({
        _id: r._id,
        sid: r.sid,
        split: r.split,
        idx: r.idx,
        user: r.user.length > 160 ? r.user.slice(0, 160) + "…" : r.user,
        answer: answerPreview(r.assistant),
        _edited: r._edited,
        updated_at: r.updated_at,
      }));
      return Response.json({ rows, total, page, pageSize });
    }
    const cols = ["_id", ...s.viewColumns, "_edited"].map(q).join(", ");
    const rows = db.prepare(`SELECT ${cols} FROM ${table} ${where} ORDER BY _id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return Response.json({ rows, total, page, pageSize });
  } catch (e) {
    return jsonError(e);
  }
}
