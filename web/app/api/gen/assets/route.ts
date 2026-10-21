import { requireArea } from "@/lib/auth";
import { handle } from "@/lib/api";
import { getDb, getSources } from "@/lib/db";
import { G, GEN_SOURCE_PREFIX } from "@/lib/gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 数据资产总览：蒸馏数据（规则引擎蒸馏的明细/训练集）+ AI 生成资产 */
export const GET = handle((req) => {
  requireArea(req, "data");
  const db = getDb();
  const distilled = [...getSources().values()].map((s) => ({
    name: s.name,
    title: s.title,
    kind: s.kind,
    rows: s.rows,
    table: s.kind === "sft" ? `ads.ads_llm_sft_sample_f（task_code=${s.name}）` : `${s.db}.${s.table}`,
    comment: s.comment,
  }));
  const generated = db
    .prepare(
      `SELECT a.*, s.spec_name, t.task_no, t.task_name, u.display_name AS user_name,
              (SELECT COUNT(DISTINCT i.requirement_id) FROM ads.ads_llm_lbl_item_f i WHERE i.source_code = '${GEN_SOURCE_PREFIX}' || a.asset_id) AS requirement_qty
       FROM ${G.asset} a LEFT JOIN ${G.spec} s ON s.spec_code = a.spec_code LEFT JOIN ${G.task} t ON t.task_id = a.task_id
       LEFT JOIN ads.ads_llm_sys_user_f u ON u.user_id = a.user_id ORDER BY a.asset_id DESC`,
    )
    .all();
  return Response.json({ distilled, generated });
});
