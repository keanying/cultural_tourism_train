import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// 按客户命名规范分库：每个分层一个 SQLite 文件，ATTACH 后统一以“库.表”访问
const DATA_DIR = process.env.CT_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data");
const SCHEMAS = ["ads", "dim", "dwd", "dws"] as const;

/** 训练样本、修改记录、数据源目录（ads 应用层） */
export const SFT_TABLE = "ads.ads_llm_sft_sample_f";
export const LOG_TABLE = "ads.ads_llm_data_edit_log_f";
export const SOURCE_TABLE = "ads.ads_llm_data_source_f";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    const missing = SCHEMAS.filter((s) => !fs.existsSync(/*turbopackIgnore: true*/ path.join(DATA_DIR, `${s}.db`)));
    if (missing.length) {
      throw new Error(`数据库文件缺失：${missing.map((s) => `${s}.db`).join("、")}（目录 ${DATA_DIR}）。请先在项目根目录运行 python -m distill.build_db`);
    }
    const d = new DatabaseSync(":memory:");
    for (const s of SCHEMAS) {
      d.exec(`ATTACH DATABASE '${path.join(DATA_DIR, `${s}.db`).replace(/'/g, "''")}' AS ${s}`);
      d.exec(`PRAGMA ${s}.journal_mode=WAL;`);
    }
    d.exec("PRAGMA busy_timeout=5000;");
    db = d;
  }
  return db;
}

export type Source = {
  name: string;
  db: string;
  table: string;
  title: string;
  comment: string;
  kind: "dataset" | "sft";
  rows: number;
  columns: string[];
  viewColumns: string[];
  searchColumns: string[];
  labels: Record<string, string>;
  enums: Record<string, Record<string, string>>;
};

let sourceCache: Map<string, Source> | null = null;

export function getSources(): Map<string, Source> {
  if (!sourceCache) {
    const rows = getDb().prepare(`SELECT * FROM ${SOURCE_TABLE}`).all() as any[];
    sourceCache = new Map(
      rows.map((r) => [
        r.source_code,
        {
          name: r.source_code,
          db: r.db_name,
          table: r.table_name,
          title: r.title_name,
          comment: r.table_comment_desc,
          kind: r.source_type,
          rows: r.row_qty,
          columns: JSON.parse(r.column_list),
          viewColumns: JSON.parse(r.view_column_list),
          searchColumns: JSON.parse(r.search_column_list),
          labels: JSON.parse(r.column_comment_map ?? "{}"),
          enums: JSON.parse(r.column_enum_map ?? "{}"),
        },
      ]),
    );
  }
  return sourceCache;
}

/** 数据源白名单校验：所有表名/列名只能来自数据源目录，杜绝 SQL 注入 */
export function requireSource(name: string | null): Source {
  const s = name ? getSources().get(name) : undefined;
  if (!s) throw new HttpError(400, `未知数据源：${name}`);
  return s;
}

/** 库.表 */
export const tableOf = (s: Source) => (s.kind === "sft" ? SFT_TABLE : `${s.db}.${s.table}`);
export const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

const typeCache = new Map<string, Record<string, string>>();
export function columnTypes(s: Source): Record<string, string> {
  if (!typeCache.has(s.name)) {
    const info = getDb().prepare(`PRAGMA ${s.db}.table_info(${s.table})`).all() as any[];
    typeCache.set(s.name, Object.fromEntries(info.map((c) => [c.name, String(c.type)])));
  }
  return typeCache.get(s.name)!;
}

export type Filter = { where: string; params: (string | number)[] };

/** 构造列表/导出共用的过滤条件 */
export function buildFilter(s: Source, sp: URLSearchParams): Filter {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  const kw = (sp.get("q") ?? "").trim();
  if (s.kind === "sft") {
    conds.push("task_code = ?");
    params.push(s.name);
    const split = sp.get("split");
    if (split && ["train", "val", "test"].includes(split)) {
      conds.push("split_type = ?");
      params.push(split);
    }
  }
  if (kw) {
    const cols = s.searchColumns;
    conds.push(`(${cols.map((c) => `${q(c)} LIKE ?`).join(" OR ")})`);
    cols.forEach(() => params.push(`%${kw}%`));
  }
  if (sp.get("edited") === "1") conds.push("is_edited = 1");
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function jsonError(e: unknown) {
  const status = e instanceof HttpError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message }, { status });
}

export function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  return d.toISOString().replace("T", " ").slice(0, 19);
}
