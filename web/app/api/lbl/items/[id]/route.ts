import { logAction, requireUser } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { chunkAccess, getChunk, loadContent, normalizeContent, sourceOf, T, validateContent } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getItem(id: number) {
  const it = getDb().prepare(`SELECT * FROM ${T.item} WHERE item_id = ?`).get(id) as any;
  if (!it) throw new HttpError(404, "条目不存在");
  return it;
}

/** 条目详情：原始内容（AI/规则初标）+ 当前标注内容 + 条目级意见 */
export const GET = handle((req, { id }) => {
  const u = requireUser(req);
  const mode = new URL(req.url).searchParams.get("mode") === "review" ? "review" : "label";
  const it = getItem(Number(id));
  chunkAccess(u, getChunk(it.chunk_id), mode);
  const src = sourceOf(it.source_code);
  const original = loadContent(src, it.source_row_id);
  const comments = getDb()
    .prepare(
      `SELECT m.*, u.display_name AS user_name, u.role_type FROM ${T.comment} m JOIN ${T.user} u ON u.user_id = m.user_id
       WHERE m.item_id = ? ORDER BY m.comment_id DESC`,
    )
    .all(it.item_id);
  const { label_content, ...rest } = it;
  return Response.json({
    item: rest,
    source: { name: src.name, title: src.title, kind: src.kind, labels: src.labels, enums: src.enums, columns: src.columns },
    original,
    content: label_content ? JSON.parse(label_content) : original,
    comments,
  });
});

/**
 * 保存：
 *   mode=label  标注员：content（可选，修改后的内容）+ label_tag（1-正确 2-已修正 3-无效剔除）+ ai（是否采用了 AI 再标）
 *   mode=review 审核员：review_result（1-合格 2-不合格已修改）+ content（不合格时的修改内容）
 */
export const PATCH = handle(async (req, { id }) => {
  const u = requireUser(req);
  const b = await body(req);
  const mode = b.mode === "review" ? "review" : "label";
  const it = getItem(Number(id));
  const c = getChunk(it.chunk_id);
  const { canEdit } = chunkAccess(u, c, mode);
  if (!canEdit) throw new HttpError(403, mode === "label" ? "分块不在你的标注中状态" : "请先领取该分块的审核");
  const src = sourceOf(it.source_code);
  const original = loadContent(src, it.source_row_id);
  const origNorm = normalizeContent(src, original);
  let stored: string | null = it.label_content;
  if (b.content !== undefined) {
    const errs = validateContent(src, b.content);
    if (errs.length) throw new HttpError(422, errs.join("；"));
    const norm = normalizeContent(src, b.content);
    stored = norm === origNorm ? null : norm;
  }
  const db = getDb();
  const now = nowStr();
  if (mode === "label") {
    let tag = Number(b.label_tag);
    if (![1, 2, 3].includes(tag)) throw new HttpError(400, "请选择标注结论");
    if (tag !== 3) tag = stored ? 2 : 1; // 内容有改动即为“已修正”，否则为“正确”
    db.prepare(
      `UPDATE ${T.item} SET label_content = ?, label_tag = ?, label_source_type = ?, annotator_id = ?, label_time = ? WHERE item_id = ?`,
    ).run(stored, tag, b.ai ? 2 : 1, u.user_id, now, it.item_id);
    logAction(u.user_id, "item.label", "item", it.item_id, `tag=${tag}`);
    return Response.json({ ok: true, label_tag: tag });
  }
  const result = Number(b.review_result);
  if (![1, 2].includes(result)) throw new HttpError(400, "请选择审核结论");
  if (result === 2 && b.content === undefined && !b.label_tag) throw new HttpError(400, "不合格需要修改内容或调整标注结论");
  const tag = b.label_tag && [1, 2, 3].includes(Number(b.label_tag)) ? (Number(b.label_tag) === 3 ? 3 : stored ? 2 : 1) : it.label_tag;
  db.prepare(`UPDATE ${T.item} SET review_result = ?, reviewer_id = ?, review_time = ?, label_content = ?, label_tag = ? WHERE item_id = ?`).run(
    result, u.user_id, now, stored, tag, it.item_id,
  );
  logAction(u.user_id, "item.review", "item", it.item_id, `result=${result}`);
  return Response.json({ ok: true, review_result: result, label_tag: tag });
});
