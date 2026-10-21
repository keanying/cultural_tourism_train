"use client";

import { Button, Chip, toast } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AssetDrawer } from "@/components/gen/AssetDrawer";
import { GenAssetChip, KindChip } from "@/components/gen/common";
import { ListTable, PageHeader } from "@/components/ui";
import { api, fmtNum } from "@/lib/client";

const FLOW = ["数据资产：蒸馏或 AI 生成", "项目区：创建项目", "需求区：选择资产，发布需求与标注标准", "管理员：接收并按 5000 条/块下发", "标注区 / 审核区：标注、抽检", "交付区：确认并下载"];

export default function AssetsPage() {
  const [d, setD] = useState<{ distilled: any[]; generated: any[] } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const load = useCallback(() => {
    api("/api/gen/assets").then(setD).catch((e) => toast.danger(e.message));
  }, []);
  useEffect(() => {
    load();
    const id = new URLSearchParams(location.search).get("asset");
    if (id) setOpenId(Number(id));
  }, [load]);

  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="数据资产"
        desc="两类 AI 蒸馏数据：规则引擎蒸馏的明细数据集与训练集，以及大模型按数据规格生成的会话明细与训练集。资产在需求区作为数据源发布标注需求，经人工标注审核后交付。"
        actions={
          <>
            <Link href="/assets/tasks?new=1"><Button variant="secondary">新建 AI 生成任务</Button></Link>
            <Link href="/projects"><Button variant="primary">去创建项目 / 发布需求</Button></Link>
          </>
        }
      />
      <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        {FLOW.map((f, i) => (
          <li key={f} className="flex items-center gap-2">
            <span className="rounded-full bg-surface-secondary px-3 py-1">
              <span className="mr-1 font-mono text-accent">{i + 1}</span>
              {f}
            </span>
            {i < FLOW.length - 1 ? <span className="text-muted">→</span> : null}
          </li>
        ))}
      </ol>

      <h2 className="mb-2 text-lg font-medium">AI 生成资产</h2>
      <div className="mb-8">
        <ListTable
          rows={d?.generated ?? []}
          idKey="asset_id"
          pageSize={8}
          onRowAction={(r) => setOpenId(r.asset_id)}
          emptyText={d ? "暂无 AI 生成资产，可在「AI 生成任务」中新建" : "加载中…"}
          columns={[
            { id: "asset_id", name: "编号", render: (r) => `#${r.asset_id}` },
            { id: "asset_name", name: "资产名称" },
            { id: "kind", name: "类型", render: (r) => <KindChip kind={r.asset_kind_type} /> },
            { id: "asset_status", name: "状态", render: (r) => <GenAssetChip status={r.asset_status} /> },
            { id: "unit_qty", name: "会话数", render: (r) => fmtNum(r.unit_qty) },
            { id: "pair_qty", name: "样本 / 问答对", render: (r) => fmtNum(r.pair_qty) },
            { id: "task_name", name: "生成任务", render: (r) => r.task_name ?? (r.task_id ? "任务已删除" : "历史导入") },
            { id: "requirement_qty", name: "标注需求", render: (r) => (r.requirement_qty ? <Chip size="sm" color="accent">已用于 {r.requirement_qty} 个</Chip> : "—") },
            { id: "create_time", name: "生成时间" },
            { id: "_op", name: "操作", render: (r) => <Button size="sm" variant="secondary" onPress={() => setOpenId(r.asset_id)}>详情</Button> },
          ]}
        />
      </div>

      <h2 className="mb-2 text-lg font-medium">蒸馏数据</h2>
      <ListTable
        rows={(d?.distilled ?? []).map((s, i) => ({ ...s, _i: i + 1 }))}
        idKey="_i"
        pageSize={12}
        emptyText={d ? "暂无" : "加载中…"}
        columns={[
          { id: "title", name: "数据集" },
          { id: "kind", name: "类型", render: (r) => <Chip size="sm" color={r.kind === "sft" ? "accent" : "default"}>{r.kind === "sft" ? "训练集" : "明细数据"}</Chip> },
          { id: "table", name: "库.表", render: (r) => <span className="font-mono text-xs">{r.table}</span> },
          { id: "rows", name: "条数", render: (r) => fmtNum(r.rows) },
          {
            id: "_op",
            name: "操作",
            render: (r) => (
              <div className="flex gap-2">
                <Link href={`/assets/data?source=${r.name}`}><Button size="sm" variant="secondary">查看 / 修改</Button></Link>
                <Link href={`/requirements?source=${r.name}`}><Button size="sm" variant="tertiary">发布标注需求</Button></Link>
              </div>
            ),
          },
        ]}
      />
      <AssetDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />
    </div>
  );
}
