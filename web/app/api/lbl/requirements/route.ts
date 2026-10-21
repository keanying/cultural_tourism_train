import { logAction, requireAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { getAllSources, type SourceConfig, T } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 需求列表：需求员看自己的；管理员/超管看全部。?project_id=&status=&area=delivery */
export const GET = handle((req) => {
  const sp = new URL(req.url).searchParams;
  const area = sp.get("area") === "delivery" ? "delivery" : "requirement";
  const u = requireArea(req, area);
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (u.role_type === "requester") {
    conds.push("r.requester_id = ?");
    params.push(u.user_id);
  }
  if (sp.get("project_id")) {
    conds.push("r.project_id = ?");
    params.push(Number(sp.get("project_id")));
  }
  if (area === "delivery") conds.push("r.requirement_status IN (3, 5, 6)");
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT r.requirement_id, r.project_id, r.requirement_name, r.requirement_desc, r.source_config, r.requirement_status,
              r.item_qty, r.chunk_qty, r.create_time, r.receive_time, r.dispatch_time, r.deliver_time, r.confirm_time,
              r.reject_reason_desc, p.project_name, rq.display_name AS requester_name, ad.display_name AS admin_name,
              (SELECT COUNT(*) FROM ${T.chunk} c WHERE c.requirement_id = r.requirement_id AND c.chunk_status = 5) AS passed_chunk_qty,
              (SELECT COUNT(*) FROM ${T.item} i WHERE i.requirement_id = r.requirement_id AND i.label_tag > 0) AS labeled_qty
       FROM ${T.req} r JOIN ${T.project} p ON p.project_id = r.project_id
       LEFT JOIN ${T.user} rq ON rq.user_id = r.requester_id LEFT JOIN ${T.user} ad ON ad.user_id = r.admin_id
       ${where} ORDER BY r.requirement_id DESC`,
    )
    .all(...params);
  return Response.json({ requirements: rows });
});

/** 发布需求：指定数据（可多个）+ 标注标准 */
export const POST = handle(async (req) => {
  const u = requireAction(req, "publishRequirement");
  const b = await body(req);
  const db = getDb();
  const p = db.prepare(`SELECT * FROM ${T.project} WHERE project_id = ?`).get(Number(b.project_id)) as any;
  if (!p) throw new HttpError(400, "请选择项目");
  if (u.role_type === "requester" && p.requester_id !== u.user_id) throw new HttpError(403, "只能在自己的项目下发布需求");
  const name = String(b.requirement_name ?? "").trim();
  const standard = String(b.standard_content ?? "").trim();
  if (!name) throw new HttpError(400, "请填写需求名称");
  if (standard.length < 10) throw new HttpError(400, "请填写标注标准（至少 10 个字）");
  const cfg: SourceConfig[] = Array.isArray(b.source_config) ? b.source_config : [];
  if (!cfg.length) throw new HttpError(400, "请至少指定一个数据源");
  const sources = getAllSources();
  const clean = cfg.map((c) => {
    const s = sources.get(String(c.source_code));
    if (!s) throw new HttpError(400, `未知数据源：${c.source_code}`);
    if (s.kind === "gen" && s.gen!.status !== 2) throw new HttpError(400, `资产「${s.title}」尚未生成完成`);
    const max = c.max_qty ? Math.floor(Number(c.max_qty)) : 0;
    if (max < 0 || !Number.isFinite(max)) throw new HttpError(400, "条数上限无效");
    return { source_code: s.name, ...(s.kind === "sft" && c.split_type ? { split_type: String(c.split_type) } : {}), ...(max ? { max_qty: max } : {}) };
  });
  const r = db
    .prepare(
      `INSERT INTO ${T.req} (project_id, requirement_name, requirement_desc, source_config, standard_content, requester_id, requirement_status, create_time)
       VALUES (?,?,?,?,?,?,1,?)`,
    )
    .run(p.project_id, name, String(b.requirement_desc ?? ""), JSON.stringify(clean), standard, u.user_id, nowStr());
  logAction(u.user_id, "requirement.publish", "requirement", Number(r.lastInsertRowid), name);
  return Response.json({ requirement_id: Number(r.lastInsertRowid) });
});
