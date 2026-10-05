import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.CT_DB_PATH ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "ct.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ DB_PATH)) {
      throw new Error(`数据库不存在：${DB_PATH}。请先在项目根目录运行 python -m distill.build_db`);
    }
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  }
  return db;
}

export type Source = {
  name: string;
  title: string;
  kind: "dataset" | "sft";
  rows: number;
  columns: string[];
  viewColumns: string[];
  searchColumns: string[];
  labels: Record<string, string>;
};

let sourceCache: Map<string, Source> | null = null;

export function getSources(): Map<string, Source> {
  if (!sourceCache) {
    const rows = getDb().prepare("SELECT * FROM sources").all() as any[];
    sourceCache = new Map(
      rows.map((r) => [
        r.name,
        {
          name: r.name,
          title: r.title,
          kind: r.kind,
          rows: r.rows,
          columns: JSON.parse(r.columns),
          viewColumns: JSON.parse(r.view_columns),
          searchColumns: JSON.parse(r.search_columns),
          labels: JSON.parse(r.labels ?? "{}"),
        },
      ]),
    );
  }
  return sourceCache;
}

/** 数据源白名单校验：所有表名/列名只能来自 sources 表，杜绝 SQL 注入 */
export function requireSource(name: string | null): Source {
  const s = name ? getSources().get(name) : undefined;
  if (!s) throw new HttpError(400, `未知数据源：${name}`);
  return s;
}

export const tableOf = (s: Source) => `"ds_${s.name}"`;
export const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

const typeCache = new Map<string, Record<string, string>>();
export function columnTypes(s: Source): Record<string, string> {
  if (!typeCache.has(s.name)) {
    const info = getDb().prepare(`PRAGMA table_info(${tableOf(s)})`).all() as any[];
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
    conds.push("task = ?");
    params.push(s.name);
    const split = sp.get("split");
    if (split && ["train", "val", "test"].includes(split)) {
      conds.push("split = ?");
      params.push(split);
    }
  }
  if (kw) {
    const cols = s.searchColumns;
    conds.push(`(${cols.map((c) => `${q(c)} LIKE ?`).join(" OR ")})`);
    cols.forEach(() => params.push(`%${kw}%`));
  }
  if (sp.get("edited") === "1") conds.push("_edited = 1");
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
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
