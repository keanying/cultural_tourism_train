"use client";

import { Button, Tabs, toast } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtNum } from "@/lib/client";
import { can } from "@/lib/roles";
import { useMe } from "./AppShell";
import { ChunkStatusChip, ListTable, PageHeader, Progress } from "./ui";

/** 标注区 / 审核区的分块列表 */
export function ChunkList({ mode }: { mode: "label" | "review" }) {
  const me = useMe();
  const isMgr = me.role_type === "admin" || me.role_type === "superadmin";
  const tabs =
    mode === "label"
      ? [
          { id: "pool", name: "待认领" },
          ...(can(me.role_type, "claimChunk") ? [{ id: "mine", name: "我的分块" }] : []),
          ...(isMgr ? [{ id: "all", name: "全部分块" }] : []),
        ]
      : [
          { id: "review_pool", name: "待审核" },
          ...(can(me.role_type, "reviewChunk") ? [{ id: "review_mine", name: "我的审核" }] : []),
          ...(isMgr ? [{ id: "all", name: "全部分块" }] : []),
        ];
  const [view, setView] = useState(tabs[0].id);
  const [chunks, setChunks] = useState<any[]>([]);
  const load = useCallback(() => {
    api(`/api/lbl/chunks?view=${view}`).then((j) => setChunks(j.chunks)).catch((e) => toast.danger(e.message));
  }, [view]);
  useEffect(load, [load]);

  const act = async (id: number, action: string, extra: Record<string, unknown> = {}) => {
    try {
      const j = await api(`/api/lbl/chunks/${id}`, { method: "POST", json: { action, ...extra } });
      toast.success(
        { claim: "认领成功", release: "已退回到待认领", review_claim: `已领取审核，随机抽检 ${j.sample_qty} 条`, review_release: "已放回待审核" }[action] ?? "操作成功",
      );
      if (action === "claim") location.href = `/label/${id}`;
      else if (action === "review_claim") location.href = `/review/${id}`;
      else load();
    } catch (e: any) {
      toast.danger(e.message);
      load();
    }
  };

  const href = (c: any) => `/${mode}/${c.chunk_id}`;
  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title={mode === "label" ? "标注区" : "审核区"}
        desc={
          mode === "label"
            ? "认领分块后进入逐条标注；已被认领的分块不能再被认领，可退回；全部标注完成后提交审核"
            : "领取标注完成的分块后系统自动随机抽检（5%，至少 50 条）；抽检合格则通过，不合格可修改或退回返修"
        }
      />
      <Tabs selectedKey={view} onSelectionChange={(k) => setView(String(k))} className="mb-4">
        <Tabs.ListContainer>
          <Tabs.List aria-label="分块视图">
            {tabs.map((t) => (
              <Tabs.Tab key={t.id} id={t.id} className="whitespace-nowrap">
                {t.name}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <ListTable
        rows={chunks}
        idKey="chunk_id"
        pageSize={15}
        emptyText={view === "pool" ? "暂无待认领分块（需管理员下发需求）" : view === "review_pool" ? "暂无待审核分块" : "暂无分块"}
        columns={[
          { id: "chunk_id", name: "分块", render: (c) => <span className="whitespace-nowrap">#{c.chunk_id} · 第 {c.chunk_seq_no} 块</span> },
          { id: "requirement_name", name: "需求", render: (c) => <span className="line-clamp-2 block max-w-[240px]">{c.requirement_name}</span> },
          { id: "project_name", name: "项目" },
          { id: "item_qty", name: "条数", render: (c) => fmtNum(c.item_qty) },
          { id: "labeled_qty", name: "标注进度", render: (c) => <Progress value={c.labeled_qty} total={c.item_qty} /> },
          { id: "chunk_status", name: "状态", render: (c) => <ChunkStatusChip status={c.chunk_status} /> },
          { id: "annotator_name", name: "标注员", render: (c) => c.annotator_name ?? "—" },
          { id: "reviewer_name", name: "审核员", render: (c) => c.reviewer_name ?? "—" },
          { id: "comment_qty", name: "意见", render: (c) => (c.comment_qty ? `${c.comment_qty} 条` : "—") },
          {
            id: "_op",
            name: "操作",
            render: (c) => (
              <div className="flex items-center gap-2">
                {view === "pool" && can(me.role_type, "claimChunk") ? (
                  <Button size="sm" variant="primary" onPress={() => act(c.chunk_id, "claim")}>认领</Button>
                ) : null}
                {view === "review_pool" && can(me.role_type, "reviewChunk") ? (
                  <Button size="sm" variant="primary" onPress={() => act(c.chunk_id, "review_claim")}>领取审核</Button>
                ) : null}
                {view === "mine" && [2, 6].includes(c.chunk_status) ? (
                  <>
                    <Link className="whitespace-nowrap text-sm text-accent" href={href(c)}>{c.chunk_status === 6 ? "进入返修" : "进入标注"}</Link>
                    <Button size="sm" variant="tertiary" onPress={() => window.confirm("确认退回该分块？退回后其他标注员可认领（已标注内容保留）") && act(c.chunk_id, "release")}>
                      退回
                    </Button>
                  </>
                ) : null}
                {view === "review_mine" && c.chunk_status === 4 ? (
                  <>
                    <Link className="whitespace-nowrap text-sm text-accent" href={href(c)}>进入审核</Link>
                    <Button size="sm" variant="tertiary" onPress={() => act(c.chunk_id, "review_release")}>放回</Button>
                  </>
                ) : null}
                {(view === "all" || (view === "mine" && ![2, 6].includes(c.chunk_status)) || (view === "review_mine" && c.chunk_status !== 4)) && c.chunk_status !== 1 ? (
                  <Link className="whitespace-nowrap text-sm text-accent" href={`/${c.chunk_status >= 3 && mode === "review" ? "review" : mode}/${c.chunk_id}`}>查看</Link>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
