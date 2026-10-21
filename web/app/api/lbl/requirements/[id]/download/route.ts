import { requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/db";
import { assertRequirementVisible, getRequirement, iterDeliveryItems } from "@/lib/lbl";
import { LABEL_TAG, REVIEW_RESULT } from "@/lib/roles";
import { pyDumps } from "@/lib/sft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 交付下载（交付后可用）：
 *   format=jsonl  训练可用的 JSONL：训练样本每行 {"messages":[...]}，明细数据每行一个对象；剔除“无效”条目
 *   format=detail 标注明细 CSV：每条的来源、标注结论、审核结论、标注/审核人与最终内容（含剔除条目）
 */
export const GET = handle((req, { id }) => {
  const u = requireArea(req, "delivery");
  const r = getRequirement(Number(id));
  assertRequirementVisible(u, r);
  if (![5, 6].includes(r.requirement_status)) throw new HttpError(409, "需求尚未交付，不能下载");
  const format = new URL(req.url).searchParams.get("format") === "detail" ? "detail" : "jsonl";
  const it = iterDeliveryItems(r.requirement_id);
  const enc = new TextEncoder();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      let buf = "";
      if (first && format === "detail") {
        buf += "﻿" + ["item_id", "chunk_seq_no", "item_seq_no", "source_code", "source_row_id", "label_tag", "label_tag_name", "label_source_type",
          "review_result", "review_result_name", "annotator_name", "reviewer_name", "label_time", "content"].join(",") + "\n";
      }
      first = false;
      for (let i = 0; i < 1000; i++) {
        const n = it.next();
        if (n.done) {
          if (buf) controller.enqueue(enc.encode(buf));
          controller.close();
          return;
        }
        const { item, src, content } = n.value;
        if (format === "jsonl") {
          if (item.label_tag === 3) continue; // 无效剔除
          const obj = src.kind === "sft"
            ? { messages: [{ role: "system", content: content.system }, { role: "user", content: content.user }, { role: "assistant", content: content.assistant }] }
            : content;
          buf += pyDumps(obj) + "\n";
        } else {
          buf += [item.item_id, item.chunk_seq_no, item.item_seq_no, item.source_code, item.source_row_id, item.label_tag, LABEL_TAG[item.label_tag],
            item.label_source_type, item.review_result, REVIEW_RESULT[item.review_result], item.annotator_name, item.reviewer_name, item.label_time,
            pyDumps(content)].map(csvCell).join(",") + "\n";
        }
      }
      controller.enqueue(enc.encode(buf));
    },
  });
  const name = `requirement_${r.requirement_id}_${format === "jsonl" ? "train.jsonl" : "detail.csv"}`;
  return new Response(stream, {
    headers: {
      "Content-Type": format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
});
