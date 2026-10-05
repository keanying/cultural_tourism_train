import { columnTypes, getDb, HttpError, jsonError, nowStr, q, requireSource, tableOf } from "@/lib/db";
import { pyDumps, validateSft } from "@/lib/sft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单行详情：GET /api/row?source=&id= */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const s = requireSource(sp.get("source"));
    const id = Number(sp.get("id"));
    const db = getDb();
    const row =
      s.kind === "sft"
        ? db.prepare("SELECT * FROM sft WHERE _id = ? AND task = ?").get(id, s.name)
        : db.prepare(`SELECT * FROM ${tableOf(s)} WHERE _id = ?`).get(id);
    if (!row) throw new HttpError(404, "记录不存在");
    const logs = db
      .prepare("SELECT ts, field, old_value, new_value FROM edit_log WHERE source = ? AND row_id = ? ORDER BY id DESC LIMIT 50")
      .all(s.name, id);
    return Response.json({ row, logs });
  } catch (e) {
    return jsonError(e);
  }
}

function coerce(type: string, v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (type === "INTEGER" || type === "REAL") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, `“${v}” 不是有效数字`);
    if (type === "INTEGER" && !Number.isInteger(n)) throw new HttpError(400, `“${v}” 必须是整数`);
    return n;
  }
  return String(v);
}

/** 保存修改：PATCH /api/row  body={source,id,values} 或 {source,id,user,assistant} */
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const s = requireSource(body.source);
    const id = Number(body.id);
    const db = getDb();
    const ts = nowStr();
    const log = db.prepare("INSERT INTO edit_log (ts, source, row_id, field, old_value, new_value) VALUES (?,?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      if (s.kind === "sft") {
        const old = db.prepare("SELECT user, assistant FROM sft WHERE _id = ? AND task = ?").get(id, s.name) as any;
        if (!old) throw new HttpError(404, "记录不存在");
        const errs = validateSft(s.name, String(body.user ?? ""), String(body.assistant ?? ""));
        if (errs.length) throw new HttpError(422, errs.join("；"));
        const user = pyDumps(JSON.parse(body.user)); // 统一为原数据的紧凑 JSON 风格
        const assistant = String(body.assistant);
        let changed = 0;
        for (const [f, nv] of [["user", user], ["assistant", assistant]] as const) {
          if (old[f] !== nv) {
            log.run(ts, s.name, id, f, old[f], nv);
            changed++;
          }
        }
        if (changed) db.prepare("UPDATE sft SET user = ?, assistant = ?, _edited = 1, updated_at = ? WHERE _id = ?").run(user, assistant, ts, id);
        db.exec("COMMIT");
        return Response.json({ ok: true, changed });
      }
      const types = columnTypes(s);
      const values = (body.values ?? {}) as Record<string, unknown>;
      const fields = Object.keys(values).filter((k) => s.columns.includes(k));
      const old = db.prepare(`SELECT * FROM ${tableOf(s)} WHERE _id = ?`).get(id) as any;
      if (!old) throw new HttpError(404, "记录不存在");
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      for (const f of fields) {
        const nv = coerce(types[f], values[f]);
        if (nv !== old[f] && !(nv === null && old[f] === null)) {
          sets.push(`${q(f)} = ?`);
          params.push(nv);
          log.run(ts, s.name, id, f, old[f] === null ? null : String(old[f]), nv === null ? null : String(nv));
        }
      }
      if (sets.length) db.prepare(`UPDATE ${tableOf(s)} SET ${sets.join(", ")}, _edited = 1 WHERE _id = ?`).run(...params, id);
      db.exec("COMMIT");
      return Response.json({ ok: true, changed: sets.length });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } catch (e) {
    return jsonError(e);
  }
}
