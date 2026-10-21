import { logAction, requireUser } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { chunkAccess, getChunk, T } from "@/lib/lbl";

export const runtime = "nodejs";

/** 发表意见：分块级（item_id 为空）或条目级 */
export const POST = handle(async (req) => {
  const u = requireUser(req);
  const b = await body(req);
  const c = getChunk(Number(b.chunk_id));
  chunkAccess(u, c, u.role_type === "annotator" ? "label" : "review");
  const content = String(b.content ?? "").trim();
  if (!content) throw new HttpError(400, "意见内容不能为空");
  let itemId: number | null = null;
  if (b.item_id) {
    const it = getDb().prepare(`SELECT chunk_id FROM ${T.item} WHERE item_id = ?`).get(Number(b.item_id)) as any;
    if (!it || it.chunk_id !== c.chunk_id) throw new HttpError(400, "条目不属于该分块");
    itemId = Number(b.item_id);
  }
  const r = getDb()
    .prepare(`INSERT INTO ${T.comment} (chunk_id, item_id, user_id, comment_content, create_time) VALUES (?,?,?,?,?)`)
    .run(c.chunk_id, itemId, u.user_id, content, nowStr());
  logAction(u.user_id, "comment.create", itemId ? "item" : "chunk", itemId ?? c.chunk_id, content.slice(0, 100));
  return Response.json({ comment_id: Number(r.lastInsertRowid) });
});
