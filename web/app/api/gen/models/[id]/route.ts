import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G } from "@/lib/gen";
import { modelFields } from "@/lib/genApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = handle(async (req, { id }) => {
  const u = requireArea(req, "data");
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM ${G.model} WHERE model_id = ?`).get(Number(id))) throw new HttpError(404, "模型配置不存在");
  const f = modelFields(await body(req), true);
  if (f.is_default) db.exec(`UPDATE ${G.model} SET is_default = 0`);
  const keys = Object.keys(f);
  if (keys.length) {
    db.prepare(`UPDATE ${G.model} SET ${keys.map((k) => `${k} = ?`).join(", ")}, update_time = ? WHERE model_id = ?`).run(...keys.map((k) => f[k]), nowStr(), Number(id));
  }
  logAction(u.user_id, "gen.model.update", "gen_model", Number(id), keys.filter((k) => k !== "api_key_value").join(","));
  return Response.json({ ok: true });
});

export const DELETE = handle((req, { id }) => {
  const u = requireArea(req, "data");
  const db = getDb();
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${G.task} WHERE model_id = ?`).get(Number(id)) as any).n;
  if (n) throw new HttpError(409, `已有 ${n} 个生成任务使用该模型，不能删除（可停用）`);
  db.prepare(`DELETE FROM ${G.model} WHERE model_id = ?`).run(Number(id));
  logAction(u.user_id, "gen.model.delete", "gen_model", Number(id));
  return Response.json({ ok: true });
});
