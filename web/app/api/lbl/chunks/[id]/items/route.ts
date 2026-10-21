import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, type Source } from "@/lib/db";
import { genPreview } from "@/lib/gen";
import { chunkAccess, getChunk, loadContent, sourceOf, T } from "@/lib/lbl";
import { answerPreview } from "@/lib/sft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS: Record<string, string> = {
  all: "",
  unlabeled: "AND i.label_tag = 0",
  labeled: "AND i.label_tag > 0",
  fixed: "AND i.label_tag = 2",
  dropped: "AND i.label_tag = 3",
  sampled: "AND i.is_sampled = 1",
  unreviewed: "AND i.is_sampled = 1 AND i.review_result = 0",
  unqualified: "AND i.review_result = 2",
  commented: `AND EXISTS (SELECT 1 FROM ${T.comment} m WHERE m.item_id = i.item_id)`,
};

/** 分块内条目列表 ?mode=&filter=&page=&pageSize= */
export const GET = handle((req, { id }) => {
  const u = requireUser(req);
  const sp = new URL(req.url).searchParams;
  const mode = sp.get("mode") === "review" ? "review" : "label";
  const c = getChunk(Number(id));
  chunkAccess(u, c, mode);
  const filter = FILTERS[sp.get("filter") ?? "all"] ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize") ?? 50) || 50));
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${T.item} i WHERE i.chunk_id = ? ${filter}`).get(c.chunk_id) as any).n;
  const rows = db
    .prepare(
      `SELECT i.item_id, i.item_seq_no, i.source_code, i.source_row_id, i.label_tag, i.label_source_type, i.is_sampled, i.review_result,
              i.label_content IS NOT NULL AS is_modified,
              (SELECT COUNT(*) FROM ${T.comment} m WHERE m.item_id = i.item_id) AS comment_qty, i.label_content
       FROM ${T.item} i WHERE i.chunk_id = ? ${filter} ORDER BY i.item_seq_no LIMIT ? OFFSET ?`,
    )
    .all(c.chunk_id, pageSize, (page - 1) * pageSize) as any[];
  const cache = new Map<string, Source>();
  const items = rows.map((r) => {
    if (!cache.has(r.source_code)) cache.set(r.source_code, sourceOf(r.source_code));
    const src = cache.get(r.source_code)!;
    const content = r.label_content ? JSON.parse(r.label_content) : loadContent(src, r.source_row_id);
    const preview =
      src.kind === "gen"
        ? genPreview(src, content)
        : src.kind === "sft"
        ? answerPreview(content.assistant, 90)
        : src.viewColumns.slice(0, 4).map((k) => content[k]).filter((v) => v !== null && v !== "").join(" · ");
    const { label_content, ...rest } = r;
    return { ...rest, source_title: src.title, preview };
  });
  return Response.json({ items, total, page, pageSize });
});
