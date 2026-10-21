"use client";

import { Chip } from "@heroui/react";
import { useMemo, useState, type ReactNode } from "react";
import { DataTable, type Column } from "./DataTable";
import { CHUNK_STATUS, REQ_STATUS } from "@/lib/roles";
import type { Row } from "@/lib/types";

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {desc ? <p className="mt-1 text-sm text-muted">{desc}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

const chipColor = (c: string) => c as "default" | "accent" | "success" | "warning" | "danger";

export function ReqStatusChip({ status }: { status: number }) {
  const s = REQ_STATUS[status] ?? { name: String(status), color: "default" };
  return (
    <Chip size="sm" color={chipColor(s.color)} className="whitespace-nowrap">
      {s.name}
    </Chip>
  );
}

export function ChunkStatusChip({ status }: { status: number }) {
  const s = CHUNK_STATUS[status] ?? { name: String(status), color: "default" };
  return (
    <Chip size="sm" color={chipColor(s.color)} className="whitespace-nowrap">
      {s.name}
    </Chip>
  );
}

/** 小列表：沿用客户 Table 样式，前端分页 */
export function ListTable<T extends Record<string, any>>({
  rows,
  columns,
  idKey,
  pageSize = 10,
  emptyText,
  onRowAction,
}: {
  rows: T[];
  columns: Column[];
  idKey: keyof T;
  pageSize?: number;
  emptyText?: string;
  onRowAction?: (r: T) => void;
}) {
  const [page, setPage] = useState(1);
  const data = useMemo(() => rows.map((r) => ({ ...r, _id: Number(r[idKey]) }) as Row), [rows, idKey]);
  const totalPages = Math.max(1, Math.ceil(data.length / pageSize));
  const p = Math.min(page, totalPages);
  return (
    <DataTable
      columns={columns}
      rows={data.slice((p - 1) * pageSize, p * pageSize)}
      total={data.length}
      page={p}
      pageSize={pageSize}
      onPageChange={setPage}
      emptyText={emptyText}
      onRowAction={onRowAction as any}
    />
  );
}

export function Progress({ value, total }: { value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex min-w-[120px] items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-secondary">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-xs text-muted">
        {value.toLocaleString("zh-CN")}/{total.toLocaleString("zh-CN")}
      </span>
    </div>
  );
}

/** 标注标准（Markdown 文本按段落展示） */
export function StandardView({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap rounded-lg bg-surface-secondary p-3 text-sm leading-relaxed">{text}</div>;
}
