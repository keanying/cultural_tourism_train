import { getDb, getSources, jsonError, SFT_TABLE, tableOf } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const sources = [...getSources().values()].map((s) => {
      const r =
        s.kind === "sft"
          ? (db.prepare(`SELECT COUNT(*) AS n FROM ${SFT_TABLE} WHERE task_code = ? AND is_edited = 1`).get(s.name) as any)
          : (db.prepare(`SELECT COUNT(*) AS n FROM ${tableOf(s)} WHERE is_edited = 1`).get() as any);
      return { ...s, edited: r.n as number };
    });
    return Response.json({ sources });
  } catch (e) {
    return jsonError(e);
  }
}
