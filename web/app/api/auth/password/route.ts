import { requireUser } from "@/lib/auth";
import { getDb, HttpError, jsonError } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";

export const runtime = "nodejs";

/** 修改自己的密码 */
export async function POST(req: Request) {
  try {
    const u = requireUser(req);
    const { old_password, new_password } = await req.json();
    const row = getDb().prepare("SELECT password_hash FROM ads.ads_llm_sys_user_f WHERE user_id = ?").get(u.user_id) as any;
    if (!verifyPassword(String(old_password ?? ""), row.password_hash)) throw new HttpError(400, "原密码错误");
    if (String(new_password ?? "").length < 8) throw new HttpError(400, "新密码至少 8 位");
    getDb().prepare("UPDATE ads.ads_llm_sys_user_f SET password_hash = ? WHERE user_id = ?").run(hashPassword(String(new_password)), u.user_id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
