import { buildFilter, getDb, jsonError, q, requireSource, tableOf } from "@/lib/db";
import { pyDumps } from "@/lib/sft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 一键导出 JSONL（流式，包含页面上的所有修改）：
 *   GET /api/export?source=&split=&q=&edited=&meta=
 * 训练集：每行 {"messages":[system,user,assistant]}，可直接喂给训练框架；meta=1 时额外附带 id 与评测真值。
 * 明细数据集：每行一个 JSON 对象（全部规范字段，含 travel_date 分区字段）。
 */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const s = requireSource(sp.get("source"));
    const { where, params } = buildFilter(s, sp);
    const withMeta = sp.get("meta") === "1";
    const db = getDb();
    const sql =
      s.kind === "sft"
        ? `SELECT sample_no AS sid, system_content AS system, user_content AS user, assistant_content AS assistant, meta_content AS meta
           FROM ${tableOf(s)} ${where} ORDER BY row_id`
        : `SELECT ${s.columns.map(q).join(", ")} FROM ${tableOf(s)} ${where} ORDER BY row_id`;
    const iter = db.prepare(sql).iterate(...params) as IterableIterator<any>;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        let buf = "";
        for (let i = 0; i < 2000; i++) {
          const n = iter.next();
          if (n.done) {
            if (buf) controller.enqueue(enc.encode(buf));
            controller.close();
            return;
          }
          const r = n.value;
          const obj =
            s.kind === "sft"
              ? {
                  ...(withMeta ? { id: r.sid } : {}),
                  messages: [
                    { role: "system", content: r.system },
                    { role: "user", content: r.user },
                    { role: "assistant", content: r.assistant },
                  ],
                  ...(withMeta ? { meta: JSON.parse(r.meta) } : {}),
                }
              : { ...r };
          buf += pyDumps(obj) + "\n";
        }
        controller.enqueue(enc.encode(buf));
      },
      cancel() {
        iter.return?.();
      },
    });
    const parts = [s.kind === "sft" ? s.name : `${s.db}.${s.table}`, sp.get("split") || (s.kind === "sft" ? "all" : ""), sp.get("edited") === "1" ? "edited" : "", sp.get("q") ? "filtered" : ""];
    const filename = parts.filter(Boolean).join("_") + ".jsonl";
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return jsonError(e);
  }
}
