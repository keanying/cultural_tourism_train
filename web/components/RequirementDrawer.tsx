"use client";

import { Button, Drawer, Spinner, TextArea, toast, useOverlayState } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { api, fmtNum } from "@/lib/client";
import { can, LABEL_TAG } from "@/lib/roles";
import { useMe } from "./AppShell";
import { ChunkStatusChip, ListTable, Progress, ReqStatusChip, StandardView } from "./ui";

export type SourceBrief = { name: string; title: string; kind: string; rows: number; table: string };

export function sourceSummary(cfg: string, sources: SourceBrief[]) {
  try {
    return (JSON.parse(cfg) as any[])
      .map((c) => {
        const s = sources.find((x) => x.name === c.source_code);
        const extra = [c.split_type ? { train: "训练集", val: "验证集", test: "测试集" }[c.split_type as string] : "", c.max_qty ? `≤${fmtNum(c.max_qty)}条` : ""].filter(Boolean).join("，");
        return `${s?.title ?? c.source_code}${extra ? `（${extra}）` : ""}`;
      })
      .join("、");
  } catch {
    return cfg;
  }
}

/** 需求详情抽屉：标准、数据、分块进度，以及按角色/状态可执行的流转操作 */
export function RequirementDrawer({ id, sources, onClose, onChanged }: { id: number | null; sources: SourceBrief[]; onClose: () => void; onChanged: () => void }) {
  const me = useMe();
  const state = useOverlayState({ isOpen: id !== null, onOpenChange: (o) => !o && onClose() });
  const [d, setD] = useState<any>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (id === null) return;
    setD(null);
    api(`/api/lbl/requirements/${id}`).then(setD).catch((e) => toast.danger(e.message));
  }, [id]);
  useEffect(load, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const j = await api(`/api/lbl/requirements/${id}`, { method: "POST", json: { action, ...extra } });
      toast.success(action === "dispatch" ? `已下发：${fmtNum(j.item_qty)} 条，切分为 ${j.chunk_qty} 个分块` : "操作成功");
      load();
      onChanged();
    } catch (e: any) {
      toast.danger(e.message);
    } finally {
      setBusy(false);
    }
  };

  const r = d?.requirement;
  const passed = d?.chunks?.filter((c: any) => c.chunk_status === 5).length ?? 0;
  return (
    <Drawer state={state}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="h-full w-[95vw]! max-w-[900px]! sm:w-[900px]!">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="flex items-center gap-2">
                需求 #{id} {r ? <>{r.requirement_name} <ReqStatusChip status={r.requirement_status} /></> : null}
              </Drawer.Heading>
            </Drawer.Header>
            {!d ? (
              <Drawer.Body className="flex justify-center py-20">
                <Spinner />
              </Drawer.Body>
            ) : (
              <>
                <Drawer.Body className="space-y-5">
                  <section className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
                    <Info k="指定数据" v={sourceSummary(r.source_config, sources)} wide />
                    <Info k="标注条数" v={r.item_qty ? fmtNum(r.item_qty) : "下发后生成"} />
                    <Info k="分块数" v={r.chunk_qty ? `${r.chunk_qty}（5000 条/块）` : "—"} />
                    <Info k="发布时间" v={r.create_time} />
                    <Info k="接收时间" v={r.receive_time ?? "—"} />
                    <Info k="下发时间" v={r.dispatch_time ?? "—"} />
                    <Info k="交付时间" v={r.deliver_time ?? "—"} />
                    {r.reject_reason_desc ? <Info k="驳回原因" v={r.reject_reason_desc} wide /> : null}
                  </section>
                  {r.requirement_desc ? <p className="text-sm">{r.requirement_desc}</p> : null}
                  <section>
                    <h3 className="mb-2 text-sm font-medium">标注标准</h3>
                    <StandardView text={r.standard_content} />
                  </section>
                  {d.chunks.length ? (
                    <section>
                      <h3 className="mb-2 flex items-center gap-3 text-sm font-medium">
                        分块进度 <Progress value={passed} total={d.chunks.length} />
                        <span className="text-xs font-normal text-muted">
                          {d.tags.map((t: any) => `${LABEL_TAG[t.label_tag]} ${fmtNum(t.n)}`).join(" · ")}
                        </span>
                      </h3>
                      <ListTable
                        rows={d.chunks}
                        idKey="chunk_id"
                        pageSize={8}
                        columns={[
                          { id: "chunk_seq_no", name: "分块", render: (c) => `第 ${c.chunk_seq_no} 块` },
                          { id: "chunk_status", name: "状态", render: (c) => <ChunkStatusChip status={c.chunk_status} /> },
                          { id: "labeled_qty", name: "标注进度", render: (c) => <Progress value={c.labeled_qty} total={c.item_qty} /> },
                          { id: "annotator_name", name: "标注员" },
                          { id: "reviewer_name", name: "审核员" },
                          { id: "return_qty", name: "退回次数" },
                        ]}
                      />
                    </section>
                  ) : null}
                  {d.delivery ? (
                    <section className="text-sm">
                      <h3 className="mb-2 font-medium">交付记录</h3>
                      交付于 {d.delivery.deliver_time}，共 {fmtNum(d.delivery.item_qty)} 条，有效 {fmtNum(d.delivery.valid_item_qty)} 条
                      {d.delivery.confirm_time ? `；需求员已于 ${d.delivery.confirm_time} 确认` : "；待需求员确认"}
                    </section>
                  ) : null}
                  {can(me.role_type, "receiveRequirement") && [1, 2].includes(r.requirement_status) ? (
                    <TextArea placeholder="驳回原因（驳回时必填）" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                  ) : null}
                </Drawer.Body>
                <Drawer.Footer>
                  {can(me.role_type, "receiveRequirement") && r.requirement_status === 1 ? (
                    <Button variant="primary" isDisabled={busy} onPress={() => act("receive")}>接收需求</Button>
                  ) : null}
                  {can(me.role_type, "dispatchRequirement") && r.requirement_status === 2 ? (
                    <Button variant="primary" isDisabled={busy} onPress={() => act("dispatch")}>
                      {busy ? "下发中…" : "下发标注任务（5000 条/块）"}
                    </Button>
                  ) : null}
                  {can(me.role_type, "receiveRequirement") && [1, 2].includes(r.requirement_status) ? (
                    <Button variant="danger-soft" isDisabled={busy || !reason.trim()} onPress={() => act("reject", { reason })}>驳回</Button>
                  ) : null}
                  <Button variant="tertiary" onPress={state.close}>关闭</Button>
                </Drawer.Footer>
              </>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

function Info({ k, v, wide }: { k: string; v: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 md:col-span-4" : ""}>
      <div className="text-xs text-muted">{k}</div>
      <div className="break-all">{v}</div>
    </div>
  );
}
