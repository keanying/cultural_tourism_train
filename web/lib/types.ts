export type SourceInfo = {
  name: string;
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
