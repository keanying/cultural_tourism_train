import { logAction, requireAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { T } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 项目列表：需求员只看自己的；附带需求数与进度 */
export const GET = handle((req) => {
  const u = requireArea(req, "project");
  const own = u.role_type === "requester";
  const projects = getDb()
    .prepare(
      `SELECT p.*, u.display_name AS requester_name,
              (SELECT COUNT(*) FROM ${T.req} r WHERE r.project_id = p.project_id) AS requirement_qty,
              (SELECT COALESCE(SUM(item_qty),0) FROM ${T.req} r WHERE r.project_id = p.project_id) AS item_qty,
              (SELECT COUNT(*) FROM ${T.req} r WHERE r.project_id = p.project_id AND r.requirement_status = 6) AS done_qty
       FROM ${T.project} p LEFT JOIN ${T.user} u ON u.user_id = p.requester_id
       ${own ? "WHERE p.requester_id = ?" : ""} ORDER BY p.project_id DESC`,
    )
    .all(...(own ? [u.user_id] : []));
  return Response.json({ projects });
});

/** 创建项目（需求员/超级管理员） */
export const POST = handle(async (req) => {
  const u = requireAction(req, "createProject");
  const b = await body(req);
  const name = String(b.project_name ?? "").trim();
  if (!name) throw new HttpError(400, "请填写项目名称");
  const r = getDb()
    .prepare(`INSERT INTO ${T.project} (project_name, project_desc, requester_id, create_time) VALUES (?,?,?,?)`)
    .run(name, String(b.project_desc ?? ""), u.user_id, nowStr());
  logAction(u.user_id, "project.create", "project", Number(r.lastInsertRowid), name);
  return Response.json({ project_id: Number(r.lastInsertRowid) });
});
