import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, HttpError } from "@/lib/db";
import { T } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 分块列表 ?view=
 *   pool        标注区：待认领分块（标注员/管理员/超管）
 *   mine        标注区：我认领的分块（标注中 / 被退回 / 已提交）
 *   review_pool 审核区：待审核分块
 *   review_mine 审核区：我审核中/审核过的分块
 *   all         全部（管理员/超管监控）
 */
export const GET = handle((req) => {
  const u = requireUser(req);
  const view = new URL(req.url).searchParams.get("view") ?? "pool";
  const conds: string[] = ["r.requirement_status = 3"];
  const params: (string | number)[] = [];
  const role = u.role_type;
  const isMgr = role === "admin" || role === "superadmin";
  if (view === "pool") {
    if (!isMgr && role !== "annotator") throw new HttpError(403, "无权访问标注区");
    conds.push("c.chunk_status = 1");
  } else if (view === "mine") {
    if (role !== "annotator" && role !== "superadmin") throw new HttpError(403, "只有标注员有自己的分块");
    conds.push("c.annotator_id = ?");
    params.push(u.user_id);
  } else if (view === "review_pool") {
    if (!isMgr && role !== "reviewer") throw new HttpError(403, "无权访问审核区");
    conds.push("c.chunk_status = 3");
  } else if (view === "review_mine") {
    if (role !== "reviewer" && role !== "superadmin") throw new HttpError(403, "只有审核员有自己的审核分块");
    conds.push("c.reviewer_id = ?");
    params.push(u.user_id);
  } else if (view === "all") {
    if (!isMgr) throw new HttpError(403, "无权查看全部分块");
  } else throw new HttpError(400, "未知视图");
  const chunks = getDb()
    .prepare(
      `SELECT c.*, r.requirement_name, p.project_name, a.display_name AS annotator_name, rv.display_name AS reviewer_name,
              (SELECT COUNT(*) FROM ${T.item} i WHERE i.chunk_id = c.chunk_id AND i.label_tag > 0) AS labeled_qty,
              (SELECT COUNT(*) FROM ${T.comment} m WHERE m.chunk_id = c.chunk_id) AS comment_qty
       FROM ${T.chunk} c JOIN ${T.req} r ON r.requirement_id = c.requirement_id JOIN ${T.project} p ON p.project_id = r.project_id
       LEFT JOIN ${T.user} a ON a.user_id = c.annotator_id LEFT JOIN ${T.user} rv ON rv.user_id = c.reviewer_id
       WHERE ${conds.join(" AND ")} ORDER BY c.requirement_id, c.chunk_seq_no LIMIT 500`,
    )
    .all(...params);
  return Response.json({ chunks });
});
