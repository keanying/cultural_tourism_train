"use client";

import { Button, toast } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/AppShell";
import { RequirementDrawer, sourceSummary, type SourceBrief } from "@/components/RequirementDrawer";
import { ListTable, PageHeader, Progress, ReqStatusChip } from "@/components/ui";
import { api, fmtNum } from "@/lib/client";
import { can } from "@/lib/roles";

export default function DeliveryPage() {
  const me = useMe();
  const [reqs, setReqs] = useState<any[]>([]);
  const [sources, setSources] = useState<SourceBrief[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const load = useCallback(() => {
    api("/api/lbl/requirements?area=delivery").then((j) => setReqs(j.requirements)).catch((e) => toast.danger(e.message));
  }, []);
  useEffect(() => {
    load();
    api("/api/lbl/sources").then((j) => setSources(j.sources)).catch(() => {});
  }, [load]);

  const act = async (id: number, action: string) => {
    try {
      await api(`/api/lbl/requirements/${id}`, { method: "POST", json: { action } });
      toast.success(action === "deliver" ? "已交付，等待需求员确认" : "已确认交付");
      load();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="交付区"
        desc={
          me.role_type === "requester"
            ? "查看自己发布的需求是否交付；交付后可确认并下载训练用 JSONL 与标注明细"
            : "全部分块审核通过后即可交付；交付后需求员确认并下载"
        }
      />
      <ListTable
        rows={reqs}
        idKey="requirement_id"
        emptyText="暂无已下发的需求"
        columns={[
          { id: "requirement_id", name: "编号", render: (r) => `#${r.requirement_id}` },
          { id: "requirement_name", name: "需求名称" },
          { id: "project_name", name: "项目" },
          { id: "source_config", name: "数据", render: (r) => <span className="line-clamp-2 block min-w-[180px] max-w-[280px]">{sourceSummary(r.source_config, sources)}</span> },
          { id: "item_qty", name: "条数", render: (r) => fmtNum(r.item_qty) },
          { id: "passed_chunk_qty", name: "审核通过分块", render: (r) => <Progress value={r.passed_chunk_qty} total={r.chunk_qty} /> },
          { id: "requirement_status", name: "交付状态", render: (r) => <ReqStatusChip status={r.requirement_status} /> },
          { id: "deliver_time", name: "交付时间", render: (r) => r.deliver_time ?? "—" },
          {
            id: "_op",
            name: "操作",
            render: (r) => (
              <div className="flex flex-wrap items-center gap-2">
                {can(me.role_type, "deliver") && r.requirement_status === 3 ? (
                  <Button size="sm" variant="primary" isDisabled={r.passed_chunk_qty !== r.chunk_qty} onPress={() => act(r.requirement_id, "deliver")}>
                    交付
                  </Button>
                ) : null}
                {can(me.role_type, "confirmDelivery") && r.requirement_status === 5 ? (
                  <Button size="sm" variant="primary" onPress={() => act(r.requirement_id, "confirm")}>确认交付</Button>
                ) : null}
                {[5, 6].includes(r.requirement_status) ? (
                  <>
                    <a className="whitespace-nowrap text-sm text-accent" href={`/api/lbl/requirements/${r.requirement_id}/download?format=jsonl`} download>
                      下载 JSONL
                    </a>
                    <a className="whitespace-nowrap text-sm text-accent" href={`/api/lbl/requirements/${r.requirement_id}/download?format=detail`} download>
                      下载明细
                    </a>
                  </>
                ) : null}
                <Button size="sm" variant="tertiary" onPress={() => setOpenId(r.requirement_id)}>详情</Button>
              </div>
            ),
          },
        ]}
      />
      <RequirementDrawer id={openId} sources={sources} onClose={() => setOpenId(null)} onChanged={load} />
    </div>
  );
}
