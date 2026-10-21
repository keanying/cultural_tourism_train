import { requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getAllSources } from "@/lib/lbl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 可指定为标注数据的数据源：蒸馏数据（训练集 + 明细数据集）+ 已生成完成的 AI 生成资产（标注单位为会话） */
export const GET = handle((req) => {
  requireArea(req, "requirement");
  const sources = [...getAllSources().values()]
    .filter((s) => s.kind !== "gen" || s.gen!.status === 2)
    .map((s) => ({
      name: s.name,
      title: s.title,
      kind: s.kind,
      rows: s.rows,
      group: s.kind === "gen" ? "AI 生成资产" : "蒸馏数据",
      gen_kind: s.gen?.kind,
      spec_name: s.gen?.specName,
      table: s.kind === "sft" ? "ads.ads_llm_sft_sample_f" : `${s.db}.${s.table}`,
    }));
  return Response.json({ sources });
});
