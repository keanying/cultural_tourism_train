import "server-only";
import { columnTypes, getDb, getSources, HttpError, nowStr, q, type Source, SFT_TABLE, tableOf } from "./db";
import type { User } from "./auth";
import { G, genContext, genSources, loadGenContent, normalizeGenContent, validateGenContent } from "./gen";
import { pyDumps, validateSft } from "./sft";

export const CHUNK_SIZE = Number(process.env.LBL_CHUNK_SIZE ?? 5000);
export const SAMPLE_RATE = Number(process.env.LBL_SAMPLE_RATE ?? 0.05);
export const SAMPLE_MIN = Number(process.env.LBL_SAMPLE_MIN ?? 50);

export const T = {
  project: "ads.ads_llm_lbl_project_f",
  req: "ads.ads_llm_lbl_requirement_f",
  chunk: "ads.ads_llm_lbl_chunk_f",
  item: "ads.ads_llm_lbl_item_f",
  comment: "ads.ads_llm_lbl_comment_f",
  delivery: "ads.ads_llm_lbl_delivery_f",
  user: "ads.ads_llm_sys_user_f",
};

export type SourceConfig = { source_code: string; split_type?: string; max_qty?: number };

// ---------------------------------------------------------------- 条目内容

/** 训练样本：{system,user,assistant}；明细数据：全部规范字段 */
export function loadContent(src: Source, rowId: number): Record<string, any> {
  if (src.kind === "gen") return loadGenContent(src, rowId);
  const db = getDb();
  if (src.kind === "sft") {
    const r = db
      .prepare(`SELECT system_content AS system, user_content AS user, assistant_content AS assistant FROM ${SFT_TABLE} WHERE row_id = ?`)
      .get(rowId) as any;
    if (!r) throw new HttpError(404, "源数据不存在");
    return { system: r.system, user: r.user, assistant: r.assistant };
  }
  const r = db.prepare(`SELECT ${src.columns.map(q).join(", ")} FROM ${tableOf(src)} WHERE row_id = ?`).get(rowId) as any;
  if (!r) throw new HttpError(404, "源数据不存在");
  return { ...r };
}

/** 全部可标注数据源：蒸馏数据（明细 + 训练集）+ AI 生成资产 */
export function getAllSources(): Map<string, Source> {
  const m = new Map(getSources());
  for (const s of genSources()) m.set(s.name, s);
  return m;
}

export function sourceOf(code: string): Source {
  const s = getSources().get(code) ?? (code.startsWith("gen_asset_") ? genSources().find((x) => x.name === code) : undefined);
  if (!s) throw new HttpError(400, `未知数据源：${code}`);
  return s;
}

/** 内容校验：训练样本走 SFT 格式与业务约束；明细数据校验字段集合、类型、编码取值 */
export function validateContent(src: Source, content: Record<string, any>, rowId: number): string[] {
  if (src.kind === "gen") return validateGenContent(src, content, loadGenContent(src, rowId), genContext(src, rowId));
  if (src.kind === "sft") {
    if (typeof content?.user !== "string" || typeof content?.assistant !== "string") return ["训练样本必须包含 user 与 assistant 字符串"];
    return validateSft(src.name, content.user, content.assistant);
  }
  const errs: string[] = [];
  const keys = Object.keys(content ?? {});
  const extra = keys.filter((k) => !src.columns.includes(k));
  const missing = src.columns.filter((k) => !keys.includes(k));
  if (extra.length) errs.push(`存在未定义字段：${extra.join("、")}`);
  if (missing.length) errs.push(`缺少字段：${missing.join("、")}`);
  const types = columnTypes(src);
  for (const c of src.columns) {
    const v = content?.[c];
    if (v === null || v === undefined || v === "") continue;
    if (types[c] === "INTEGER" || types[c] === "REAL") {
      if (typeof v !== "number" || !Number.isFinite(v)) errs.push(`${c} 必须是数字`);
      else if (types[c] === "INTEGER" && !Number.isInteger(v)) errs.push(`${c} 必须是整数`);
      else if (src.enums[c] && !(String(v) in src.enums[c])) errs.push(`${c} 编码 ${v} 未定义`);
    } else if (typeof v !== "string") errs.push(`${c} 必须是字符串`);
  }
  if (content?.travel_date && !/^\d{8}$/.test(String(content.travel_date))) errs.push("travel_date 必须为 YYYYMMDD");
  // 编码字段与名称字段一致
  for (const c of Object.keys(src.enums)) {
    const n = [`${c}_name`, c.replace(/_(type|code|status)$/, "_name")].find((x) => x !== c && src.columns.includes(x));
    const label = src.enums[c]?.[String(content?.[c])];
    if (n && label !== undefined && content?.[n] !== label) errs.push(`${n} 应为“${label}”（与 ${c}=${content[c]} 一致）`);
  }
  return errs;
}

/** 规范化后存储：训练样本 user 统一为原数据 JSON 风格 */
export function normalizeContent(src: Source, content: Record<string, any>): string {
  if (src.kind === "gen") return normalizeGenContent(src, content);
  if (src.kind === "sft") {
    return JSON.stringify({ system: content.system, user: pyDumps(JSON.parse(content.user)), assistant: content.assistant });
  }
  return JSON.stringify(Object.fromEntries(src.columns.map((c) => [c, content[c] ?? null])));
}

// ---------------------------------------------------------------- 下发：建条目与分块

export function dispatchRequirement(reqId: number) {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM ${T.req} WHERE requirement_id = ?`).get(reqId) as any;
  const cfg: SourceConfig[] = JSON.parse(r.source_config);
  db.exec("BEGIN");
  try {
    let seq = 0;
    const tmp = "temp.lbl_dispatch";
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS lbl_dispatch (gseq INTEGER PRIMARY KEY, source_code TEXT, source_row_id INTEGER)`);
    db.exec(`DELETE FROM ${tmp}`);
    for (const c of cfg) {
      const src = sourceOf(c.source_code);
      const conds: string[] = [];
      const params: (string | number)[] = [];
      if (src.kind === "sft") {
        conds.push("task_code = ?");
        params.push(src.name);
        if (c.split_type && ["train", "val", "test"].includes(c.split_type)) {
          conds.push("split_type = ?");
          params.push(c.split_type);
        }
      }
      const limit = c.max_qty && c.max_qty > 0 ? `LIMIT ${Math.floor(c.max_qty)}` : "";
      if (src.kind === "gen") {
        // 生成资产：标注单位为会话
        if (src.gen!.status !== 2) throw new HttpError(400, `资产「${src.title}」尚未生成完成`);
        seq += Number(
          db
            .prepare(`INSERT INTO ${tmp} (source_code, source_row_id) SELECT ?, conv_row_id FROM ${G.conv} WHERE asset_id = ? ORDER BY seq_no ${limit}`)
            .run(src.name, src.gen!.assetId).changes,
        );
        continue;
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const res = db
        .prepare(`INSERT INTO ${tmp} (source_code, source_row_id) SELECT ?, row_id FROM ${tableOf(src)} ${where} ORDER BY row_id ${limit}`)
        .run(src.name, ...params);
      seq += Number(res.changes);
    }
    if (!seq) throw new HttpError(400, "所选数据为空，无法下发");
    const chunks = Math.ceil(seq / CHUNK_SIZE);
    const insChunk = db.prepare(`INSERT INTO ${T.chunk} (requirement_id, chunk_seq_no, item_qty, chunk_status) VALUES (?,?,?,1)`);
    const chunkIds: number[] = [];
    for (let i = 0; i < chunks; i++) {
      const qty = Math.min(CHUNK_SIZE, seq - i * CHUNK_SIZE);
      chunkIds.push(Number(insChunk.run(reqId, i + 1, qty).lastInsertRowid));
    }
    // 按全局序号切块：每 CHUNK_SIZE 条一块
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS lbl_chunk_map (chunk_seq_no INTEGER PRIMARY KEY, chunk_id INTEGER)`);
    db.exec("DELETE FROM temp.lbl_chunk_map");
    const insMap = db.prepare("INSERT INTO temp.lbl_chunk_map VALUES (?,?)");
    chunkIds.forEach((id, i) => insMap.run(i + 1, id));
    db.prepare(
      `INSERT INTO ${T.item} (requirement_id, chunk_id, item_seq_no, source_code, source_row_id)
       SELECT ?, m.chunk_id, ((d.gseq - 1) % ${CHUNK_SIZE}) + 1, d.source_code, d.source_row_id
       FROM ${tmp} d JOIN temp.lbl_chunk_map m ON m.chunk_seq_no = ((d.gseq - 1) / ${CHUNK_SIZE}) + 1
       ORDER BY d.gseq`,
    ).run(reqId);
    db.prepare(`UPDATE ${T.req} SET requirement_status = 3, item_qty = ?, chunk_qty = ?, dispatch_time = ? WHERE requirement_id = ?`).run(
      seq,
      chunks,
      nowStr(),
      reqId,
    );
    db.exec(`DELETE FROM ${tmp}`);
    db.exec("COMMIT");
    return { item_qty: seq, chunk_qty: chunks };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 抽检：本轮随机抽取 max(SAMPLE_MIN, 条数×SAMPLE_RATE) 条（不超过分块条数） */
export function sampleChunk(chunkId: number, itemQty: number) {
  const db = getDb();
  const n = Math.min(itemQty, Math.max(SAMPLE_MIN, Math.ceil(itemQty * SAMPLE_RATE)));
  db.prepare(`UPDATE ${T.item} SET is_sampled = 0 WHERE chunk_id = ?`).run(chunkId);
  db.prepare(
    `UPDATE ${T.item} SET is_sampled = 1, review_result = 0 WHERE item_id IN (SELECT item_id FROM ${T.item} WHERE chunk_id = ? ORDER BY RANDOM() LIMIT ?)`,
  ).run(chunkId, n);
  db.prepare(`UPDATE ${T.chunk} SET sample_qty = ? WHERE chunk_id = ?`).run(n, chunkId);
  return n;
}

// ---------------------------------------------------------------- 权限辅助

export function getRequirement(reqId: number) {
  const r = getDb().prepare(`SELECT * FROM ${T.req} WHERE requirement_id = ?`).get(reqId) as any;
  if (!r) throw new HttpError(404, "需求不存在");
  return r;
}

export function getChunk(chunkId: number) {
  const c = getDb().prepare(`SELECT * FROM ${T.chunk} WHERE chunk_id = ?`).get(chunkId) as any;
  if (!c) throw new HttpError(404, "分块不存在");
  return c;
}

/** 需求员只能看到自己的需求 */
export function assertRequirementVisible(u: User, r: any) {
  if (u.role_type === "requester" && r.requester_id !== u.user_id) throw new HttpError(403, "只能查看自己发布的需求");
}

/** 分块访问：标注员只能操作自己认领的；审核员只能操作自己审核中的（待审核的可查看） */
export function chunkAccess(u: User, c: any, mode: "label" | "review"): { canEdit: boolean } {
  if (u.role_type === "superadmin") {
    return { canEdit: mode === "label" ? [2, 6].includes(c.chunk_status) : c.chunk_status === 4 };
  }
  if (u.role_type === "admin") return { canEdit: false };
  if (mode === "label") {
    if (u.role_type !== "annotator") throw new HttpError(403, "无权访问标注分块");
    if (c.annotator_id !== u.user_id) throw new HttpError(403, "该分块不是你认领的");
    return { canEdit: [2, 6].includes(c.chunk_status) };
  }
  if (u.role_type !== "reviewer") throw new HttpError(403, "无权访问审核分块");
  if (c.chunk_status === 4 && c.reviewer_id !== u.user_id) throw new HttpError(403, "该分块正由其他审核员审核");
  if (![3, 4, 5, 6].includes(c.chunk_status)) throw new HttpError(403, "分块尚未提交审核");
  return { canEdit: c.chunk_status === 4 && c.reviewer_id === u.user_id };
}

// ---------------------------------------------------------------- 交付导出

/** 遍历需求的全部条目（标注内容优先），用于交付下载 */
export function* iterDeliveryItems(reqId: number): Generator<{ item: any; src: Source; content: Record<string, any> }> {
  const cache = new Map<string, Source>();
  const srcOf = (code: string) => {
    if (!cache.has(code)) cache.set(code, sourceOf(code));
    return cache.get(code)!;
  };
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.*, c.chunk_seq_no, a.display_name AS annotator_name, rv.display_name AS reviewer_name
       FROM ${T.item} i JOIN ${T.chunk} c ON c.chunk_id = i.chunk_id
       LEFT JOIN ${T.user} a ON a.user_id = i.annotator_id LEFT JOIN ${T.user} rv ON rv.user_id = c.reviewer_id
       WHERE i.requirement_id = ? ORDER BY c.chunk_seq_no, i.item_seq_no`,
    )
    .iterate(reqId) as IterableIterator<any>;
  for (const item of rows) {
    const src = srcOf(item.source_code);
    const content = item.label_content ? JSON.parse(item.label_content) : loadContent(src, item.source_row_id);
    yield { item, src, content };
  }
}

export function chunkStats(chunkId: number) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS total, SUM(label_tag > 0) AS labeled, SUM(label_tag = 2) AS fixed, SUM(label_tag = 3) AS dropped,
              SUM(is_sampled) AS sampled, SUM(is_sampled = 1 AND review_result > 0) AS reviewed,
              SUM(is_sampled = 1 AND review_result = 2) AS unqualified
       FROM ${T.item} WHERE chunk_id = ?`,
    )
    .get(chunkId) as any;
}
