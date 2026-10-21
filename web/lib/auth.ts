import "server-only";
import { randomBytes } from "node:crypto";
import { getDb, HttpError, nowStr } from "./db";
import { verifyPassword } from "./password";
import { ACTION_ROLES, type Action, type Area, AREA_ROLES, type Role } from "./roles";

export const SESSION_COOKIE = "ct_session";
const SESSION_DAYS = 7;

export type User = { user_id: number; login_name: string; display_name: string; role_type: Role };

function cookieOf(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function login(loginName: string, password: string): { user: User; token: string } {
  const db = getDb();
  const u = db.prepare("SELECT * FROM ads.ads_llm_sys_user_f WHERE login_name = ?").get(loginName) as any;
  if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, "账号或密码错误");
  if (!u.is_active) throw new HttpError(403, "账号已停用，请联系超级管理员");
  const token = randomBytes(32).toString("hex");
  const now = nowStr();
  const expire = new Date(Date.now() + 8 * 3600e3 + SESSION_DAYS * 86400e3).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("INSERT INTO ads.ads_llm_sys_session_f (session_no, user_id, create_time, expire_time) VALUES (?,?,?,?)").run(token, u.user_id, now, expire);
  db.prepare("UPDATE ads.ads_llm_sys_user_f SET last_login_time = ? WHERE user_id = ?").run(now, u.user_id);
  return { user: pick(u), token };
}

export function logout(req: Request) {
  const t = cookieOf(req, SESSION_COOKIE);
  if (t) getDb().prepare("DELETE FROM ads.ads_llm_sys_session_f WHERE session_no = ?").run(t);
}

function pick(u: any): User {
  return { user_id: u.user_id, login_name: u.login_name, display_name: u.display_name, role_type: u.role_type };
}

export function currentUser(req: Request): User | null {
  const t = cookieOf(req, SESSION_COOKIE);
  if (!t) return null;
  const u = getDb()
    .prepare(
      `SELECT u.* FROM ads.ads_llm_sys_session_f s JOIN ads.ads_llm_sys_user_f u ON u.user_id = s.user_id
       WHERE s.session_no = ? AND s.expire_time > ? AND u.is_active = 1`,
    )
    .get(t, nowStr()) as any;
  return u ? pick(u) : null;
}

/** 登录校验；传入 roles 时同时校验角色 */
export function requireUser(req: Request, roles?: readonly Role[]): User {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, "请先登录");
  if (roles && !roles.includes(u.role_type)) throw new HttpError(403, "当前角色无权执行此操作");
  return u;
}

export const requireArea = (req: Request, area: Area) => requireUser(req, AREA_ROLES[area]);
export const requireAction = (req: Request, a: Action) => requireUser(req, ACTION_ROLES[a] as Role[]);

export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function logAction(userId: number | null, action: string, targetType: string, targetId: number | null, detail = "") {
  getDb()
    .prepare("INSERT INTO ads.ads_llm_lbl_action_log_f (user_id, action_code, target_type, target_id, detail_desc, create_time) VALUES (?,?,?,?,?,?)")
    .run(userId, action, targetType, targetId, detail, nowStr());
}
