import { clearCookie, logout } from "@/lib/auth";
import { jsonError } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    logout(req);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie } });
  } catch (e) {
    return jsonError(e);
  }
}
