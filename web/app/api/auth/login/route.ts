import { login, sessionCookie } from "@/lib/auth";
import { jsonError } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { login_name, password } = await req.json();
    const { user, token } = login(String(login_name ?? "").trim(), String(password ?? ""));
    return Response.json({ user }, { headers: { "Set-Cookie": sessionCookie(token) } });
  } catch (e) {
    return jsonError(e);
  }
}
