import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getPrompt(id: number) {
  const p = getDb().prepare(`SELECT * FROM ${G.prompt} WHERE prompt_id = ?`).get(id) as any;
  if (!p) throw new HttpError(404, "提示词不存在");
  return p;
}

/** 提示词详情与全部历史版本 */
export const GET = handle((req, { id }) => {
  requireArea(req, "data");
  const p = getPrompt(Number(id));
  const versions = getDb()
    .prepare(
      `SELECT v.*, u.display_name AS user_name FROM ${G.promptVer} v LEFT JOIN ads.ads_llm_sys_user_f u ON u.user_id = v.user_id
       WHERE v.prompt_id = ? ORDER BY v.version_no DESC`,
    )
    .all(p.prompt_id);
  const task_qty = (getDb().prepare(`SELECT COUNT(*) AS n FROM ${G.task} WHERE prompt_id = ?`).get(p.prompt_id) as any).n;
  return Response.json({ prompt: { ...p, task_qty }, versions });
});

/**
 * 修改提示词：正文有变化时版本号 +1，旧版本只读保留（已执行的任务固化了版本号，数据可回溯）。
 * restore_version=n：把第 n 版内容恢复为新的当前版本。
 */
export const PATCH = handle(async (req, { id }) => {
  const u = requireArea(req, "data");
  const p = getPrompt(Number(id));
  const b = await body(req);
  const db = getDb();
  let sys = b.system_prompt_text !== undefined ? String(b.system_prompt_text) : p.system_prompt_text;
  let user = b.user_prompt_text !== undefined ? String(b.user_prompt_text) : p.user_prompt_text;
  let note = String(b.note_desc ?? "").trim();
  if (b.restore_version) {
    const v = db.prepare(`SELECT * FROM ${G.promptVer} WHERE prompt_id = ? AND version_no = ?`).get(p.prompt_id, Number(b.restore_version)) as any;
    if (!v) throw new HttpError(404, "版本不存在");
    sys = v.system_prompt_text;
    user = v.user_prompt_text;
    note = note || `恢复自 v${v.version_no}`;
  }
  if (!sys.trim() || !user.trim()) throw new HttpError(400, "系统提示词与用户提示词不能为空");
  const now = nowStr();
  const changed = sys !== p.system_prompt_text || user !== p.user_prompt_text;
  db.exec("BEGIN");
  try {
    const version = changed ? p.version_no + 1 : p.version_no;
    db.prepare(
      `UPDATE ${G.prompt} SET prompt_name = ?, remark_desc = ?, is_active = ?, system_prompt_text = ?, user_prompt_text = ?, version_no = ?, update_time = ? WHERE prompt_id = ?`,
    ).run(
      b.prompt_name !== undefined ? String(b.prompt_name).trim() || p.prompt_name : p.prompt_name,
      b.remark_desc !== undefined ? String(b.remark_desc) : p.remark_desc,
      b.is_active !== undefined ? (b.is_active ? 1 : 0) : p.is_active,
      sys, user, version, now, p.prompt_id,
    );
    if (changed) {
      db.prepare(
        `INSERT INTO ${G.promptVer} (prompt_id, version_no, system_prompt_text, user_prompt_text, note_desc, user_id, create_time) VALUES (?,?,?,?,?,?,?)`,
      ).run(p.prompt_id, version, sys, user, note || "修改", u.user_id, now);
    }
    db.exec("COMMIT");
    logAction(u.user_id, "gen.prompt.update", "gen_prompt", p.prompt_id, changed ? `v${version}` : "meta");
    return Response.json({ ok: true, version_no: version, changed });
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
});

export const DELETE = handle((req, { id }) => {
  const u = requireArea(req, "data");
  const p = getPrompt(Number(id));
  const db = getDb();
  if ((db.prepare(`SELECT COUNT(*) AS n FROM ${G.task} WHERE prompt_id = ?`).get(p.prompt_id) as any).n) {
    throw new HttpError(409, "已有生成任务使用该提示词，不能删除（可停用）");
  }
  db.prepare(`DELETE FROM ${G.promptVer} WHERE prompt_id = ?`).run(p.prompt_id);
  db.prepare(`DELETE FROM ${G.prompt} WHERE prompt_id = ?`).run(p.prompt_id);
  logAction(u.user_id, "gen.prompt.delete", "gen_prompt", p.prompt_id, p.prompt_code);
  return Response.json({ ok: true });
});
