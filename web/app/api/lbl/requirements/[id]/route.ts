import { logAction, requireAction, requireUser } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { assertRequirementVisible, dispatchRequirement, getRequirement, T } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 需求详情（含分块进度与交付记录） */
export const GET = handle((req, { id }) => {
  const u = requireUser(req, ["superadmin", "admin", "requester"]);
  const r = getRequirement(Number(id));
  assertRequirementVisible(u, r);
  const db = getDb();
  const chunks = db
    .prepare(
      `SELECT c.*, a.display_name AS annotator_name, rv.display_name AS reviewer_name,
              (SELECT COUNT(*) FROM ${T.item} i WHERE i.chunk_id = c.chunk_id AND i.label_tag > 0) AS labeled_qty
       FROM ${T.chunk} c LEFT JOIN ${T.user} a ON a.user_id = c.annotator_id LEFT JOIN ${T.user} rv ON rv.user_id = c.reviewer_id
       WHERE c.requirement_id = ? ORDER BY c.chunk_seq_no`,
    )
    .all(r.requirement_id);
  const delivery = db.prepare(`SELECT * FROM ${T.delivery} WHERE requirement_id = ? ORDER BY delivery_id DESC LIMIT 1`).get(r.requirement_id) ?? null;
  const tags = db
    .prepare(`SELECT label_tag, COUNT(*) AS n FROM ${T.item} WHERE requirement_id = ? GROUP BY label_tag`)
    .all(r.requirement_id);
  return Response.json({ requirement: r, chunks, delivery, tags });
});

/** 需求流转：receive 接收 / reject 驳回 / dispatch 下发 / deliver 交付 / confirm 确认 */
export const POST = handle(async (req, { id }) => {
  const b = await body(req);
  const action = String(b.action);
  const db = getDb();
  const r = getRequirement(Number(id));
  const now = nowStr();
  const expect = (st: number[], msg: string) => {
    if (!st.includes(r.requirement_status)) throw new HttpError(409, msg);
  };
  if (action === "receive") {
    const u = requireAction(req, "receiveRequirement");
    expect([1], "需求不是待接收状态");
    db.prepare(`UPDATE ${T.req} SET requirement_status = 2, admin_id = ?, receive_time = ? WHERE requirement_id = ?`).run(u.user_id, now, r.requirement_id);
    logAction(u.user_id, "requirement.receive", "requirement", r.requirement_id);
  } else if (action === "reject") {
    const u = requireAction(req, "receiveRequirement");
    expect([1, 2], "只有未下发的需求可以驳回");
    const reason = String(b.reason ?? "").trim();
    if (!reason) throw new HttpError(400, "请填写驳回原因");
    db.prepare(`UPDATE ${T.req} SET requirement_status = 9, admin_id = ?, reject_reason_desc = ? WHERE requirement_id = ?`).run(u.user_id, reason, r.requirement_id);
    logAction(u.user_id, "requirement.reject", "requirement", r.requirement_id, reason);
  } else if (action === "dispatch") {
    const u = requireAction(req, "dispatchRequirement");
    expect([2], "需求需先接收再下发");
    const res = dispatchRequirement(r.requirement_id);
    logAction(u.user_id, "requirement.dispatch", "requirement", r.requirement_id, JSON.stringify(res));
    return Response.json({ ok: true, ...res });
  } else if (action === "deliver") {
    const u = requireAction(req, "deliver");
    expect([3], "需求不在标注审核阶段");
    const s = db
      .prepare(`SELECT COUNT(*) AS n, SUM(chunk_status = 5) AS passed FROM ${T.chunk} WHERE requirement_id = ?`)
      .get(r.requirement_id) as any;
    if (!s.n || s.passed !== s.n) throw new HttpError(409, `还有 ${s.n - (s.passed ?? 0)} 个分块未审核通过，不能交付`);
    const valid = (db.prepare(`SELECT COUNT(*) AS n FROM ${T.item} WHERE requirement_id = ? AND label_tag <> 3`).get(r.requirement_id) as any).n;
    db.prepare(
      `INSERT INTO ${T.delivery} (requirement_id, deliver_user_id, deliver_time, item_qty, valid_item_qty, delivery_note) VALUES (?,?,?,?,?,?)`,
    ).run(r.requirement_id, u.user_id, now, r.item_qty, valid, String(b.note ?? ""));
    db.prepare(`UPDATE ${T.req} SET requirement_status = 5, deliver_time = ? WHERE requirement_id = ?`).run(now, r.requirement_id);
    logAction(u.user_id, "requirement.deliver", "requirement", r.requirement_id);
  } else if (action === "confirm") {
    const u = requireAction(req, "confirmDelivery");
    assertRequirementVisible(u, r);
    expect([5], "需求尚未交付");
    db.prepare(`UPDATE ${T.req} SET requirement_status = 6, confirm_time = ? WHERE requirement_id = ?`).run(now, r.requirement_id);
    db.prepare(
      `UPDATE ${T.delivery} SET confirm_user_id = ?, confirm_time = ? WHERE delivery_id = (SELECT MAX(delivery_id) FROM ${T.delivery} WHERE requirement_id = ?)`,
    ).run(u.user_id, now, r.requirement_id);
    logAction(u.user_id, "requirement.confirm", "requirement", r.requirement_id);
  } else {
    throw new HttpError(400, `未知操作：${action}`);
  }
  return Response.json({ ok: true });
});
