import { requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getSources } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 可指定为标注数据的数据源（训练集 + 明细数据集） */
export const GET = handle((req) => {
  requireArea(req, "requirement");
  const sources = [...getSources().values()].map((s) => ({
    name: s.name, title: s.title, kind: s.kind, rows: s.rows, table: s.kind === "sft" ? "ads.ads_llm_sft_sample_f" : `${s.db}.${s.table}`,
  }));
  return Response.json({ sources });
});
