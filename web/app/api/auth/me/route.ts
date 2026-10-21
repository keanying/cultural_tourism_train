import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return Response.json({ user: requireUser(req) });
  } catch (e) {
    return jsonError(e);
  }
}
