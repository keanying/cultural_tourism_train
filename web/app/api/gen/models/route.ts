import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { maskKey, modelFields } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 模型配置列表（API Key 只返回掩码） */
export const GET = handle((req) => {
  requireArea(req, "data");
  const rows = getDb().prepare(`SELECT * FROM ${G.model} ORDER BY is_default DESC, model_id`).all() as any[];
  return Response.json({ models: rows.map(({ api_key_value, ...m }) => ({ ...m, api_key_mask: maskKey(api_key_value), has_key: !!api_key_value })) });
});

export const POST = handle(async (req) => {
  const u = requireArea(req, "data");
  const f = modelFields(await body(req));
  const now = nowStr();
  const db = getDb();
  if (f.is_default) db.exec(`UPDATE ${G.model} SET is_default = 0`);
  const keys = Object.keys(f);
  const id = Number(
    db
      .prepare(`INSERT INTO ${G.model} (${keys.join(", ")}, create_time, update_time) VALUES (${keys.map(() => "?").join(", ")}, ?, ?)`)
      .run(...keys.map((k) => f[k]), now, now).lastInsertRowid,
  );
  logAction(u.user_id, "gen.model.create", "gen_model", id, f.model_name);
  return Response.json({ model_id: id });
});
