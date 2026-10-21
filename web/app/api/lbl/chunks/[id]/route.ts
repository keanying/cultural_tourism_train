import { logAction, requireAction, requireUser } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { chunkAccess, chunkStats, getChunk, getRequirement, sampleChunk, sourceOf, T } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 分块详情：?mode=label|review */
export const GET = handle((req, { id }) => {
  const u = requireUser(req);
  const mode = new URL(req.url).searchParams.get("mode") === "review" ? "review" : "label";
  const c = getChunk(Number(id));
  const { canEdit } = chunkAccess(u, c, mode);
  const r = getRequirement(c.requirement_id);
  const db = getDb();
  const comments = db
    .prepare(
      `SELECT m.*, u.display_name AS user_name, u.role_type, i.item_seq_no FROM ${T.comment} m
       JOIN ${T.user} u ON u.user_id = m.user_id LEFT JOIN ${T.item} i ON i.item_id = m.item_id
       WHERE m.chunk_id = ? ORDER BY m.comment_id DESC`,
    )
    .all(c.chunk_id);
  const names = db.prepare(`SELECT user_id, display_name FROM ${T.user} WHERE user_id IN (?, ?)`).all(c.annotator_id ?? 0, c.reviewer_id ?? 0) as any[];
  const nameOf = (uid: number) => names.find((n) => n.user_id === uid)?.display_name ?? null;
  const sources = [...new Set((JSON.parse(r.source_config) as any[]).map((s) => s.source_code))].map((s) => {
    const src = sourceOf(s);
    return { name: src.name, title: src.title, kind: src.kind, labels: src.labels, enums: src.enums, columns: src.columns };
  });
  return Response.json({
    chunk: { ...c, annotator_name: nameOf(c.annotator_id), reviewer_name: nameOf(c.reviewer_id) },
    requirement: { requirement_id: r.requirement_id, requirement_name: r.requirement_name, standard_content: r.standard_content, requirement_desc: r.requirement_desc },
    stats: chunkStats(c.chunk_id),
    comments,
    sources,
    canEdit,
  });
});

/**
 * 分块操作：
 *   claim 认领 / release 退回（放回待认领）/ submit 提交审核          —— 标注员
 *   review_claim 领取审核（自动抽检）/ review_pass 审核通过 / review_return 退回返修 / review_release 放回待审核 —— 审核员
 */
export const POST = handle(async (req, { id }) => {
  const b = await body(req);
  const action = String(b.action);
  const db = getDb();
  const c = getChunk(Number(id));
  const now = nowStr();
  const update = (sql: string, ...params: (string | number | null)[]) => {
    const res = db.prepare(sql).run(...params);
    if (!Number(res.changes)) throw new HttpError(409, "分块状态已变化，请刷新后重试");
  };
  if (action === "claim") {
    const u = requireAction(req, "claimChunk");
    // 原子认领：只有待认领状态才能成功，避免被二次认领
    update(`UPDATE ${T.chunk} SET chunk_status = 2, annotator_id = ?, claim_time = ? WHERE chunk_id = ? AND chunk_status = 1`, u.user_id, now, c.chunk_id);
    logAction(u.user_id, "chunk.claim", "chunk", c.chunk_id);
  } else if (action === "release") {
    const u = requireAction(req, "claimChunk");
    update(
      `UPDATE ${T.chunk} SET chunk_status = 1, annotator_id = NULL, claim_time = NULL WHERE chunk_id = ? AND annotator_id = ? AND chunk_status IN (2, 6)`,
      c.chunk_id, u.user_id,
    );
    logAction(u.user_id, "chunk.release", "chunk", c.chunk_id, String(b.reason ?? ""));
  } else if (action === "submit") {
    const u = requireAction(req, "claimChunk");
    const left = (db.prepare(`SELECT COUNT(*) AS n FROM ${T.item} WHERE chunk_id = ? AND label_tag = 0`).get(c.chunk_id) as any).n;
    if (left) throw new HttpError(409, `还有 ${left} 条未标注，不能提交`);
    update(
      `UPDATE ${T.chunk} SET chunk_status = 3, submit_time = ?, reviewer_id = NULL WHERE chunk_id = ? AND annotator_id = ? AND chunk_status IN (2, 6)`,
      now, c.chunk_id, u.user_id,
    );
    logAction(u.user_id, "chunk.submit", "chunk", c.chunk_id);
  } else if (action === "review_claim") {
    const u = requireAction(req, "reviewChunk");
    update(`UPDATE ${T.chunk} SET chunk_status = 4, reviewer_id = ?, review_start_time = ? WHERE chunk_id = ? AND chunk_status = 3`, u.user_id, now, c.chunk_id);
    const n = sampleChunk(c.chunk_id, c.item_qty);
    logAction(u.user_id, "chunk.review_claim", "chunk", c.chunk_id, `抽检 ${n} 条`);
    return Response.json({ ok: true, sample_qty: n });
  } else if (action === "review_pass") {
    const u = requireAction(req, "reviewChunk");
    const s = chunkStats(c.chunk_id);
    if (s.reviewed < s.sampled) throw new HttpError(409, `还有 ${s.sampled - s.reviewed} 条抽检数据未审核`);
    update(`UPDATE ${T.chunk} SET chunk_status = 5, review_end_time = ? WHERE chunk_id = ? AND reviewer_id = ? AND chunk_status = 4`, now, c.chunk_id, u.user_id);
    if (b.comment) db.prepare(`INSERT INTO ${T.comment} (chunk_id, user_id, comment_content, create_time) VALUES (?,?,?,?)`).run(c.chunk_id, u.user_id, `【审核通过】${b.comment}`, now);
    logAction(u.user_id, "chunk.review_pass", "chunk", c.chunk_id);
  } else if (action === "review_return") {
    const u = requireAction(req, "reviewChunk");
    const reason = String(b.comment ?? "").trim();
    if (!reason) throw new HttpError(400, "退回必须填写审核意见");
    update(
      `UPDATE ${T.chunk} SET chunk_status = 6, review_end_time = ?, return_qty = return_qty + 1 WHERE chunk_id = ? AND reviewer_id = ? AND chunk_status = 4`,
      now, c.chunk_id, u.user_id,
    );
    db.prepare(`INSERT INTO ${T.comment} (chunk_id, user_id, comment_content, create_time) VALUES (?,?,?,?)`).run(c.chunk_id, u.user_id, `【退回返修】${reason}`, now);
    logAction(u.user_id, "chunk.review_return", "chunk", c.chunk_id, reason);
  } else if (action === "review_release") {
    const u = requireAction(req, "reviewChunk");
    update(`UPDATE ${T.chunk} SET chunk_status = 3, reviewer_id = NULL WHERE chunk_id = ? AND reviewer_id = ? AND chunk_status = 4`, c.chunk_id, u.user_id);
    logAction(u.user_id, "chunk.review_release", "chunk", c.chunk_id);
  } else {
    throw new HttpError(400, `未知操作：${action}`);
  }
  return Response.json({ ok: true });
});
