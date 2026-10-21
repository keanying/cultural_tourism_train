import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 用户名称映射（显示用） */
export const GET = handle((req) => {
  requireUser(req);
  const users = getDb().prepare("SELECT user_id, display_name, role_type FROM ads.ads_llm_sys_user_f").all();
  return Response.json({ users });
});
