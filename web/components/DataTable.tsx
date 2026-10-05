"use client";

import { Pagination, Table } from "@heroui/react";
import type { ReactNode } from "react";
import type { Row } from "@/lib/types";

export type Column = { id: string; name: string; width?: string; render?: (row: Row) => ReactNode };

type Props = {
  columns: Column[];
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  loading?: boolean;
  onPageChange: (p: number) => void;
  onRowAction?: (row: Row) => void;
  emptyText?: string;
};

/** 页码窗口：1 … p-1 p p+1 … last，避免 1 万页时渲染全部页码 */
function pageWindow(page: number, totalPages: number): (number | "ellipsis-l" | "ellipsis-r")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const out: (number | "ellipsis-l" | "ellipsis-r")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(totalPages - 1, page + 1);
  if (lo > 2) out.push("ellipsis-l");
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < totalPages - 1) out.push("ellipsis-r");
  out.push(totalPages);
  return out;
}

/** 沿用客户提供的 HeroUI Table + Pagination 写法，数据改为服务端分页 */
export function DataTable({ columns, rows, total, page, pageSize, loading, onPageChange, onRowAction, emptyText }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const fmt = (n: number) => n.toLocaleString("zh-CN");

  return (
    <Table className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
      <Table.ScrollContainer>
        <Table.Content
          aria-label="数据表格"
          className="min-w-[900px]"
          onRowAction={onRowAction ? (key) => {
            const r = rows.find((x) => x._id === Number(key));
            if (r) onRowAction(r);
          } : undefined}
        >
          <Table.Header columns={columns}>
            {(column) => (
              <Table.Column isRowHeader={column.id === columns[0].id} className={`whitespace-nowrap ${column.width ?? ""}`}>
                {column.name}
              </Table.Column>
            )}
          </Table.Header>
          <Table.Body items={rows} renderEmptyState={() => <div className="py-10 text-center text-sm text-muted">{loading ? "加载中…" : emptyText ?? "没有数据"}</div>}>
            {(row) => (
              <Table.Row id={row._id}>
                <Table.Collection items={columns} dependencies={[columns]}>
                  {(column) => (
                    <Table.Cell>
                      {column.render ? column.render(row) : <CellText value={row[column.id]} />}
                    </Table.Cell>
                  )}
                </Table.Collection>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
      <Table.Footer>
        <Pagination size="sm">
          <Pagination.Summary>
            {fmt(start)}–{fmt(end)} / 共 {fmt(total)} 条
          </Pagination.Summary>
          <Pagination.Content>
            <Pagination.Item>
              <Pagination.Previous isDisabled={page === 1} onPress={() => onPageChange(Math.max(1, page - 1))}>
                <Pagination.PreviousIcon />
                上一页
              </Pagination.Previous>
            </Pagination.Item>
            {pageWindow(page, totalPages).map((p) =>
              typeof p === "number" ? (
                <Pagination.Item key={p}>
                  <Pagination.Link isActive={p === page} onPress={() => onPageChange(p)}>
                    {p}
                  </Pagination.Link>
                </Pagination.Item>
              ) : (
                <Pagination.Item key={p}>
                  <Pagination.Ellipsis />
                </Pagination.Item>
              ),
            )}
            <Pagination.Item>
              <Pagination.Next isDisabled={page >= totalPages} onPress={() => onPageChange(Math.min(totalPages, page + 1))}>
                下一页
                <Pagination.NextIcon />
              </Pagination.Next>
            </Pagination.Item>
          </Pagination.Content>
        </Pagination>
      </Table.Footer>
    </Table>
  );
}

/** 短值不换行；长文本限制宽度并最多显示两行 */
function CellText({ value }: { value: unknown }) {
  const t = fmtCell(value);
  return t.length > 14 ? (
    <span className="line-clamp-2 block min-w-[180px] max-w-[320px] break-all" title={t}>{t}</span>
  ) : (
    <span className="whitespace-nowrap">{t}</span>
  );
}

export function fmtCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("zh-CN") : String(Math.round(v * 10000) / 10000);
  return String(v);
}
