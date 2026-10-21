import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError } from "@/lib/db";
import { cancelTask, G, isRunning, startTask } from "@/lib/gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIST_SQL = `SELECT t.*, s.spec_name, s.spec_kind_type, m.model_name, p.prompt_name, u.display_name AS user_name,
  a.asset_name, a.asset_status, a.unit_qty AS asset_unit_qty, a.pair_qty AS asset_pair_qty, sa.asset_name AS source_asset_name
  FROM ${G.task} t LEFT JOIN ${G.spec} s ON s.spec_code = t.spec_code LEFT JOIN ${G.model} m ON m.model_id = t.model_id
  LEFT JOIN ${G.prompt} p ON p.prompt_id = t.prompt_id LEFT JOIN ads.ads_llm_sys_user_f u ON u.user_id = t.user_id
  LEFT JOIN ${G.asset} a ON a.asset_id = t.asset_id LEFT JOIN ${G.asset} sa ON sa.asset_id = t.source_asset_id`;

function getTask(id: number) {
  const t = getDb().prepare(`${LIST_SQL} WHERE t.task_id = ?`).get(id) as any;
  if (!t) throw new HttpError(404, "任务不存在");
  return t;
}

/** 任务详情：进度、日志（最近 300 条） */
export const GET = handle((req, { id }) => {
  requireArea(req, "data");
  const t = getTask(Number(id));
  const logs = getDb().prepare(`SELECT * FROM ${G.log} WHERE task_id = ? ORDER BY log_id DESC LIMIT 300`).all(t.task_id);
  return Response.json({ task: { ...t, running: isRunning(t.task_id) }, logs });
});

/** start 执行（停止/失败后再次执行会在原资产上续跑）/ cancel 停止 / rerun 重新执行（产出新版本资产） */
export const POST = handle(async (req, { id }) => {
  const u = requireArea(req, "data");
  const t = getTask(Number(id));
  const action = String((await body(req)).action);
  if (action === "start") {
    if (t.task_status === 3) throw new HttpError(409, "任务已完成；如需再生成一份请用「重新执行」");
    startTask(t.task_id);
  } else if (action === "cancel") cancelTask(t.task_id);
  else if (action === "rerun") {
    if (isRunning(t.task_id)) throw new HttpError(409, "任务正在执行");
    getDb()
      .prepare(`UPDATE ${G.task} SET done_unit_qty = 0, done_pair_qty = 0, dup_qty = 0, fail_qty = 0, call_qty = 0, token_in_qty = 0, token_out_qty = 0, asset_id = 0 WHERE task_id = ?`)
      .run(t.task_id);
    startTask(t.task_id);
  } else throw new HttpError(400, "未知操作");
  logAction(u.user_id, `gen.task.${action}`, "gen_task", t.task_id, t.task_name);
  return Response.json({ ok: true });
});

/** 删除任务（产出的资产保留） */
export const DELETE = handle((req, { id }) => {
  const u = requireArea(req, "data");
  const t = getTask(Number(id));
  if (isRunning(t.task_id)) throw new HttpError(409, "任务正在执行，请先停止");
  const db = getDb();
  db.prepare(`DELETE FROM ${G.log} WHERE task_id = ?`).run(t.task_id);
  db.prepare(`DELETE FROM ${G.task} WHERE task_id = ?`).run(t.task_id);
  logAction(u.user_id, "gen.task.delete", "gen_task", t.task_id, t.task_name);
  return Response.json({ ok: true });
});
