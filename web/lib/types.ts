export type SourceInfo = {
  name: string;
  db: string;
  table: string;
  comment: string;
  enums: Record<string, Record<string, string>>;
  title: string;
  kind: "dataset" | "sft";
  rows: number;
  columns: string[];
  viewColumns: string[];
  searchColumns: string[];
  labels: Record<string, string>;
  edited: number;
};

export type Row = Record<string, any> & { _id: number; _edited?: number };

export type ListResult = { rows: Row[]; total: number; page: number; pageSize: number };

export const SPLIT_LABEL: Record<string, string> = { train: "训练集", val: "验证集", test: "测试集" };

/** 字段注释的简短标题：去掉“：编码说明”和括号内补充说明 */
export function shortLabel(label: string | undefined, fallback: string): string {
  if (!label) return fallback;
  return label.split("：")[0].replace(/（.*?）/g, "").replace(/=.*/, "").trim() || fallback;
}

/** 编码字段显示为“编码-含义” */
export function decodeEnum(enums: Record<string, Record<string, string>>, col: string, v: unknown): string | null {
  const m = enums[col];
  if (!m || v === null || v === undefined || v === "") return null;
  const k = String(v);
  return m[k] ? `${k}-${m[k]}` : k;
}
