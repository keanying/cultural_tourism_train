import { logAction, requireArea } from "@/lib/auth";
import { body, handle } from "@/lib/api";
import { getDb, HttpError, nowStr } from "@/lib/db";
import { G, getSpec, isRunning, startTask } from "@/lib/gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TASK_LIST_SQL = `SELECT t.*, s.spec_name, s.spec_kind_type, m.model_name, p.prompt_name, u.display_name AS user_name,
  a.asset_name, a.asset_status, sa.asset_name AS source_asset_name
  FROM ${G.task} t LEFT JOIN ${G.spec} s ON s.spec_code = t.spec_code LEFT JOIN ${G.model} m ON m.model_id = t.model_id
  LEFT JOIN ${G.prompt} p ON p.prompt_id = t.prompt_id LEFT JOIN ads.ads_llm_sys_user_f u ON u.user_id = t.user_id
  LEFT JOIN ${G.asset} a ON a.asset_id = t.asset_id LEFT JOIN ${G.asset} sa ON sa.asset_id = t.source_asset_id`;

/** 生成任务列表 */
export const GET = handle((req) => {
  requireArea(req, "data");
  const rows = getDb().prepare(`${TASK_LIST_SQL} ORDER BY t.task_id DESC LIMIT 500`).all() as any[];
  return Response.json({ tasks: rows.map((r) => ({ ...r, running: isRunning(r.task_id) })) });
});

const int = (v: unknown, def: number, min: number, max: number, what: string) => {
  const n = v === undefined || v === "" || v === null ? def : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what}应为 ${min}~${max} 的整数`);
  return n;
};

/** 新建生成任务：明细生成（按维度轮转批量生成会话）/ AI 预标注（对明细资产逐轮产出训练样本） */
export const POST = handle(async (req) => {
  const u = requireArea(req, "data");
  const b = await body(req);
  const db = getDb();
  const spec = getSpec(String(b.spec_code ?? ""));
  if (!spec.is_active) throw new HttpError(400, "该规格已停用");
  const name = String(b.task_name ?? "").trim() || `${spec.spec_name}-${nowStr().slice(0, 16)}`;
  const model = db.prepare(`SELECT * FROM ${G.model} WHERE model_id = ? AND is_active = 1`).get(Number(b.model_id)) as any;
  if (!model) throw new HttpError(400, "请选择可用的模型");
  const prompt = db.prepare(`SELECT * FROM ${G.prompt} WHERE prompt_id = ?`).get(Number(b.prompt_id)) as any;
  if (!prompt || prompt.spec_code !== spec.spec_code) throw new HttpError(400, "请选择该规格下的提示词");
  const target = int(b.target_qty, 50, 1, 200000, "目标会话数");
  const batch = int(b.batch_qty, 5, 1, 50, "每批会话数");
  const conc = int(b.concurrency_qty, 3, 1, 32, "并发数");
  const params = b.params && typeof b.params === "object" ? b.params : {};
  let srcAsset = 0;
  if (spec.spec_kind_type === "sft") {
    const a = db.prepare(`SELECT * FROM ${G.asset} WHERE asset_id = ?`).get(Number(b.source_asset_id)) as any;
    if (!a || a.asset_kind_type !== "detail" || a.asset_status !== 2) throw new HttpError(400, "AI 预标注任务必须选择已生成完成的明细资产");
    if (spec.source_spec_code && a.spec_code !== spec.source_spec_code) throw new HttpError(400, `该规格的来源应为「${spec.source_spec_code}」规格的明细资产`);
    srcAsset = a.asset_id;
    params.source_scope = params.source_scope === "delivered" ? "delivered" : "all";
  }
  const no = `T${nowStr().replace(/\D/g, "").slice(0, 14)}${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
  const id = Number(
    db
      .prepare(
        `INSERT INTO ${G.task} (task_no, task_name, task_type, spec_code, source_asset_id, model_id, prompt_id, prompt_version_no, target_qty, batch_qty, concurrency_qty,
          param_json, task_status, user_id, create_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .run(no, name, spec.task_type, spec.spec_code, srcAsset, model.model_id, prompt.prompt_id, prompt.version_no, target, batch, conc, JSON.stringify(params), u.user_id, nowStr())
      .lastInsertRowid,
  );
  db.prepare(`INSERT INTO ${G.log} (task_id, level_type, message_desc, create_time) VALUES (?, 'info', ?, ?)`).run(id, `任务已创建：${name}，目标 ${target} 段会话`, nowStr());
  logAction(u.user_id, "gen.task.create", "gen_task", id, name);
  if (b.autostart) startTask(id);
  return Response.json({ task_id: id });
});
