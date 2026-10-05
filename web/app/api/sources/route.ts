import { getDb, getSources, jsonError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const edited = new Map<string, number>();
    for (const s of getSources().values()) {
      const r =
        s.kind === "sft"
          ? (db.prepare("SELECT COUNT(*) AS n FROM sft WHERE task = ? AND _edited = 1").get(s.name) as any)
          : (db.prepare(`SELECT COUNT(*) AS n FROM "ds_${s.name}" WHERE _edited = 1`).get() as any);
      edited.set(s.name, r.n);
    }
    const sources = [...getSources().values()].map((s) => ({ ...s, edited: edited.get(s.name) ?? 0 }));
    return Response.json({ sources });
  } catch (e) {
    return jsonError(e);
  }
}
