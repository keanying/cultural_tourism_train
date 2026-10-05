import { columnTypes, getDb, HttpError, jsonError, LOG_TABLE, nowStr, q, requireSource, SFT_TABLE, tableOf } from "@/lib/db";
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
        ? db
            .prepare(
              `SELECT row_id AS _id, sample_no AS sid, split_type AS split, split_seq_no AS idx, system_content AS system,
                      user_content AS user, assistant_content AS assistant, meta_content AS meta, is_edited AS _edited, update_time AS updated_at
               FROM ${SFT_TABLE} WHERE row_id = ? AND task_code = ?`,
            )
            .get(id, s.name)
        : db.prepare(`SELECT row_id AS _id, *, is_edited AS _edited FROM ${tableOf(s)} WHERE row_id = ?`).get(id);
    if (!row) throw new HttpError(404, "记录不存在");
    const logs = db
      .prepare(
        `SELECT edit_time AS ts, field_name AS field, old_value_content AS old_value, new_value_content AS new_value
         FROM ${LOG_TABLE} WHERE source_code = ? AND data_row_id = ? ORDER BY row_id DESC LIMIT 50`,
      )
      .all(s.name, id);
    return Response.json({ row, logs });
  } catch (e) {
    return jsonError(e);
  }
}

/** 编码字段 -> 对应名称字段，如 order_status -> order_status_name、sales_channel_code -> sales_channel_name */
function codeNamePairs(s: { columns: string[]; enums: Record<string, Record<string, string>> }): [string, string][] {
  const pairs: [string, string][] = [];
  for (const c of Object.keys(s.enums)) {
    const cand = [`${c}_name`, c.replace(/_(type|code|status)$/, "_name")];
    const n = cand.find((x) => x !== c && s.columns.includes(x));
    if (n) pairs.push([c, n]);
  }
  return pairs;
}

function coerce(field: string, type: string, v: unknown, enums?: Record<string, string>): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (type === "INTEGER" || type === "REAL") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, `${field}：“${v}” 不是有效数字`);
    if (type === "INTEGER" && !Number.isInteger(n)) throw new HttpError(400, `${field}：“${v}” 必须是整数`);
    if (enums && !(String(n) in enums)) {
      throw new HttpError(400, `${field}：编码 ${n} 未定义，可选 ${Object.entries(enums).map(([k, x]) => `${k}-${x}`).join(" ")}`);
    }
    return n;
  }
  if (field === "travel_date" && !/^\d{8}$/.test(String(v))) throw new HttpError(400, "travel_date 必须为 YYYYMMDD");
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
    const log = db.prepare(
      `INSERT INTO ${LOG_TABLE} (edit_time, source_code, data_row_id, field_name, old_value_content, new_value_content) VALUES (?,?,?,?,?,?)`,
    );
    db.exec("BEGIN");
    try {
      if (s.kind === "sft") {
        const old = db.prepare(`SELECT user_content, assistant_content FROM ${SFT_TABLE} WHERE row_id = ? AND task_code = ?`).get(id, s.name) as any;
        if (!old) throw new HttpError(404, "记录不存在");
        const errs = validateSft(s.name, String(body.user ?? ""), String(body.assistant ?? ""));
        if (errs.length) throw new HttpError(422, errs.join("；"));
        const user = pyDumps(JSON.parse(body.user)); // 统一为原数据的紧凑 JSON 风格
        const assistant = String(body.assistant);
        let changed = 0;
        for (const [f, nv] of [["user_content", user], ["assistant_content", assistant]] as const) {
          if (old[f] !== nv) {
            log.run(ts, s.name, id, f, old[f], nv);
            changed++;
          }
        }
        if (changed) {
          db.prepare(`UPDATE ${SFT_TABLE} SET user_content = ?, assistant_content = ?, is_edited = 1, update_time = ? WHERE row_id = ?`).run(user, assistant, ts, id);
        }
        db.exec("COMMIT");
        return Response.json({ ok: true, changed });
      }
      const types = columnTypes(s);
      const values = (body.values ?? {}) as Record<string, unknown>;
      const fields = Object.keys(values).filter((k) => s.columns.includes(k));
      const old = db.prepare(`SELECT * FROM ${tableOf(s)} WHERE row_id = ?`).get(id) as any;
      if (!old) throw new HttpError(404, "记录不存在");
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      for (const f of fields) {
        const nv = coerce(f, types[f], values[f], s.enums[f]);
        if (nv !== old[f] && !(nv === null && old[f] === null)) {
          sets.push(`${q(f)} = ?`);
          params.push(nv);
          log.run(ts, s.name, id, f, old[f] === null ? null : String(old[f]), nv === null ? null : String(nv));
        }
      }
      // 编码字段与名称字段保持一致：改编码自动同步名称；名称与编码矛盾则拒绝
      const next: Record<string, any> = { ...old };
      sets.forEach((st, i) => (next[st.slice(1, st.indexOf('"', 1))] = params[i]));
      for (const [codeCol, nameCol] of codeNamePairs(s)) {
        const label = s.enums[codeCol]?.[String(next[codeCol])];
        if (label === undefined || next[nameCol] === label) continue;
        if (next[codeCol] !== old[codeCol]) {
          sets.push(`${q(nameCol)} = ?`);
          params.push(label);
          log.run(ts, s.name, id, nameCol, old[nameCol], label);
        } else {
          throw new HttpError(400, `${nameCol}“${next[nameCol]}”与 ${codeCol}=${next[codeCol]}（${label}）不一致，请修改编码字段`);
        }
      }
      if (sets.length) db.prepare(`UPDATE ${tableOf(s)} SET ${sets.join(", ")}, is_edited = 1 WHERE row_id = ?`).run(...params, id);
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
