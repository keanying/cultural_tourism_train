import { logAction, requireArea } from "@/lib/auth";
import { getDb, HttpError, jsonError, nowStr } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 用户列表（超级管理员） */
export async function GET(req: Request) {
  try {
    requireArea(req, "users");
    const users = getDb()
      .prepare("SELECT user_id, login_name, display_name, role_type, is_active, create_time, last_login_time FROM ads.ads_llm_sys_user_f ORDER BY user_id")
      .all();
    return Response.json({ users });
  } catch (e) {
    return jsonError(e);
  }
}

/** 新建用户 */
export async function POST(req: Request) {
  try {
    const me = requireArea(req, "users");
    const { login_name, display_name, role_type, password } = await req.json();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(login_name ?? "")) throw new HttpError(400, "登录名为 3-32 位字母、数字或下划线");
    if (!ROLES.includes(role_type)) throw new HttpError(400, "角色无效");
    if (String(password ?? "").length < 8) throw new HttpError(400, "密码至少 8 位");
    const db = getDb();
    if (db.prepare("SELECT 1 FROM ads.ads_llm_sys_user_f WHERE login_name = ?").get(login_name)) throw new HttpError(400, "登录名已存在");
    const r = db
      .prepare("INSERT INTO ads.ads_llm_sys_user_f (login_name, display_name, role_type, password_hash, create_time) VALUES (?,?,?,?,?)")
      .run(login_name, String(display_name || login_name), role_type, hashPassword(String(password)), nowStr());
    logAction(me.user_id, "user.create", "user", Number(r.lastInsertRowid), `${login_name}/${role_type}`);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

/** 修改角色/启停/重置密码 */
export async function PATCH(req: Request) {
  try {
    const me = requireArea(req, "users");
    const { user_id, role_type, is_active, password, display_name } = await req.json();
    const db = getDb();
    if (Number(user_id) === me.user_id && (is_active === 0 || (role_type && role_type !== "superadmin"))) {
      throw new HttpError(400, "不能停用自己或修改自己的角色");
    }
    if (role_type !== undefined) {
      if (!ROLES.includes(role_type)) throw new HttpError(400, "角色无效");
      db.prepare("UPDATE ads.ads_llm_sys_user_f SET role_type = ? WHERE user_id = ?").run(role_type, user_id);
    }
    if (is_active !== undefined) db.prepare("UPDATE ads.ads_llm_sys_user_f SET is_active = ? WHERE user_id = ?").run(is_active ? 1 : 0, user_id);
    if (display_name) db.prepare("UPDATE ads.ads_llm_sys_user_f SET display_name = ? WHERE user_id = ?").run(String(display_name), user_id);
    if (password) {
      if (String(password).length < 8) throw new HttpError(400, "密码至少 8 位");
      db.prepare("UPDATE ads.ads_llm_sys_user_f SET password_hash = ? WHERE user_id = ?").run(hashPassword(String(password)), user_id);
      db.prepare("DELETE FROM ads.ads_llm_sys_session_f WHERE user_id = ?").run(user_id);
    }
    logAction(me.user_id, "user.update", "user", Number(user_id), JSON.stringify({ role_type, is_active, reset: !!password }));
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
