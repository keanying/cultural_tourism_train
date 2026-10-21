import { logAction, requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, HttpError } from "@/lib/db";
import { G, getSpec } from "@/lib/gen";
import { fieldText, pyDumps } from "@/lib/tpl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 导出资产的机器产出（未经人工审核，与 Lumos 导出格式一致）：
 *   format=jsonl 训练集每行 {sample_id, conversation_id, messages}；明细每行一段会话
 *   format=csv   明细按轮次展开：会话字段 + 轮次字段（首行中文表头、次行字段名）
 * 人工审核后的数据请走 需求→标注→审核→交付，在交付区下载。
 */
export const GET = handle((req, { id }) => {
  const u = requireArea(req, "data");
  const db = getDb();
  const a = db.prepare(`SELECT * FROM ${G.asset} WHERE asset_id = ?`).get(Number(id)) as any;
  if (!a) throw new HttpError(404, "资产不存在");
  const format = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "jsonl";
  if (format === "csv" && a.asset_kind_type !== "detail") throw new HttpError(400, "训练集资产只能导出 JSONL");
  const cfg = getSpec(a.spec_code).cfg;
  const convs = db.prepare(`SELECT conversation_id, payload_json FROM ${G.conv} WHERE asset_id = ? ORDER BY seq_no`).iterate(a.asset_id) as IterableIterator<any>;
  const samples = db.prepare(`SELECT content_json FROM ${G.sample} WHERE asset_id = ? AND conversation_id = ? ORDER BY turn_no`);
  const convFields = cfg.conv_fields ?? [];
  const turnFields = cfg.turn_fields ?? [];
  const enc = new TextEncoder();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      let buf = "";
      if (first && format === "csv") {
        buf += "﻿" + ["会话ID", "轮次", ...convFields.map((x: any) => x.label || x.key), ...turnFields.map((x: any) => x.label || x.key)].map(csvCell).join(",") + "\n";
        buf += ["conversation_id", "turn_no", ...convFields.map((x: any) => x.key), ...turnFields.map((x: any) => x.key)].map(csvCell).join(",") + "\n";
      }
      first = false;
      for (let i = 0; i < 500; i++) {
        const n = convs.next();
        if (n.done) {
          if (buf) controller.enqueue(enc.encode(buf));
          controller.close();
          return;
        }
        const c = n.value;
        const p = JSON.parse(c.payload_json);
        if (format === "csv") {
          const base = convFields.map((x: any) => fieldText(p, x));
          (p.turns ?? []).forEach((t: any, ti: number) => {
            buf += [c.conversation_id, ti + 1, ...base, ...turnFields.map((x: any) => fieldText(t, x))].map(csvCell).join(",") + "\n";
          });
        } else if (a.asset_kind_type === "sft") {
          for (const s of samples.all(a.asset_id, c.conversation_id) as any[]) {
            const o = JSON.parse(s.content_json);
            buf += pyDumps({ sample_id: o.sample_id, conversation_id: c.conversation_id, messages: o.messages }) + "\n";
          }
        } else buf += pyDumps(p) + "\n";
      }
      controller.enqueue(enc.encode(buf));
    },
  });
  logAction(u.user_id, "gen.asset.export", "gen_asset", a.asset_id, format);
  const name = `${a.asset_kind_type === "sft" ? "train" : "detail"}_${a.spec_code}_${a.version_no}.${format}`;
  return new Response(stream, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
});
