import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { checkCode } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 提示词列表 ?spec_code= */
export const GET = handle((req) => {
  requireArea(req, "data");
  const spec = new URL(req.url).searchParams.get("spec_code");
  const rows = getDb()
    .prepare(
      `SELECT p.*, s.spec_name, s.spec_kind_type, (SELECT COUNT(*) FROM ${G.task} t WHERE t.prompt_id = p.prompt_id) AS task_qty
       FROM ${G.prompt} p LEFT JOIN ${G.spec} s ON s.spec_code = p.spec_code ${spec ? "WHERE p.spec_code = ?" : ""} ORDER BY s.sort_no, p.prompt_id`,
    )
    .all(...(spec ? [spec] : []));
  return Response.json({ prompts: rows });
});

export const POST = handle(async (req) => {
  const u = requireArea(req, "data");
  const b = await body(req);
  const db = getDb();
  const spec = String(b.spec_code ?? "");
  if (!db.prepare(`SELECT 1 FROM ${G.spec} WHERE spec_code = ?`).get(spec)) throw new HttpError(400, "请选择数据规格");
  const name = String(b.prompt_name ?? "").trim();
  const sys = String(b.system_prompt_text ?? "");
  const user = String(b.user_prompt_text ?? "");
  if (!name || !sys.trim() || !user.trim()) throw new HttpError(400, "请填写名称、系统提示词与用户提示词");
  let code = b.prompt_code ? checkCode(b.prompt_code, "提示词编码") : "";
  if (!code) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${G.prompt} WHERE spec_code = ?`).get(spec) as any).n;
    code = `${spec}_v${n + 1}`;
    while (db.prepare(`SELECT 1 FROM ${G.prompt} WHERE prompt_code = ?`).get(code)) code += "_1";
  } else if (db.prepare(`SELECT 1 FROM ${G.prompt} WHERE prompt_code = ?`).get(code)) throw new HttpError(409, "提示词编码已存在");
  const now = nowStr();
  db.exec("BEGIN");
  try {
    const id = Number(
      db
        .prepare(
          `INSERT INTO ${G.prompt} (prompt_code, prompt_name, spec_code, system_prompt_text, user_prompt_text, version_no, remark_desc, update_time) VALUES (?,?,?,?,?,1,?,?)`,
        )
        .run(code, name, spec, sys, user, String(b.remark_desc ?? ""), now).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO ${G.promptVer} (prompt_id, version_no, system_prompt_text, user_prompt_text, note_desc, user_id, create_time) VALUES (?,1,?,?,'初始版本',?,?)`,
    ).run(id, sys, user, u.user_id, now);
    db.exec("COMMIT");
    logAction(u.user_id, "gen.prompt.create", "gen_prompt", id, code);
    return Response.json({ prompt_id: id });
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
});
