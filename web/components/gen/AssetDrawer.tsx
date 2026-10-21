"use client";

import { Button, Chip, Drawer, SearchField, Spinner, toast, useOverlayState } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { JsonEditor } from "@/components/JsonEditor";
import { ReqStatusChip } from "@/components/ui";
import { api, fmtNum } from "@/lib/client";
import { GenAssetChip, KindChip, MessagesView, TurnsView } from "./common";

const PAGE = 5;

/** 生成资产详情：基本信息、来源任务与提示词版本、会话预览、导出、用于标注需求 */
export function AssetDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const state = useOverlayState({ isOpen: id !== null, onOpenChange: (o) => !o && onClose() });
  const [d, setD] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const load = useCallback(() => {
    if (id === null) return;
    api(`/api/gen/assets/${id}?page=${page}&pageSize=${PAGE}&q=${encodeURIComponent(q)}`).then(setD).catch((e) => toast.danger(e.message));
  }, [id, page, q]);
  useEffect(load, [load]);
  useEffect(() => {
    setPage(1);
    setQ("");
    setD(null);
  }, [id]);

  const del = async () => {
    if (!window.confirm("确认删除该资产及其全部会话与样本？")) return;
    try {
      await api(`/api/gen/assets/${id}`, { method: "DELETE" });
      toast.success("已删除");
      onChanged();
      state.close();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  const a = d?.asset;
  return (
    <Drawer state={state}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="h-full w-[95vw]! max-w-[980px]! sm:w-[980px]!">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="flex flex-wrap items-center gap-2">
                资产 #{id} {a ? <>{a.asset_name} <KindChip kind={a.asset_kind_type} /> <GenAssetChip status={a.asset_status} /></> : null}
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
                    <Info k="数据规格" v={`${a.spec_name ?? a.spec_code}（${a.spec_code}）`} />
                    <Info k="版本" v={a.version_no} />
                    <Info k="会话数" v={fmtNum(a.unit_qty)} />
                    <Info k={a.asset_kind_type === "sft" ? "训练样本数" : "问答对数"} v={`${fmtNum(a.pair_qty)}${d.invalid ? `（${fmtNum(d.invalid)} 条未通过规格校验）` : ""}`} />
                    <Info k="生成任务" v={a.task_no ? `${a.task_name}（${a.task_no}）` : a.task_id ? "任务已删除" : "历史导入"} />
                    <Info k="模型 / 提示词" v={a.model_name ? `${a.model_name} / ${a.prompt_name} v${a.prompt_version_no}` : "—"} />
                    <Info k="来源明细资产" v={a.source_asset_name ?? "—"} />
                    <Info k="生成时间" v={a.create_time} />
                  </section>
                  <section>
                    <h3 className="mb-2 text-sm font-medium">标注流转</h3>
                    {d.requirements.length ? (
                      <div className="space-y-1 text-sm">
                        {d.requirements.map((r: any) => (
                          <div key={r.requirement_id} className="flex items-center gap-2">
                            <Link className="text-accent" href={`/requirements?id=${r.requirement_id}`}>需求 #{r.requirement_id} {r.requirement_name}</Link>
                            <span className="text-muted">{r.project_name} · {fmtNum(r.item_qty)} 条</span>
                            <ReqStatusChip status={r.requirement_status} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted">尚未用于标注需求。AI 生成的数据需经人工标注审核后交付，可点击下方「发布标注需求」。</p>
                    )}
                  </section>
                  <section>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">会话预览（机器产出）</h3>
                      <SearchField aria-label="搜索会话" value={q} onChange={(v) => { setQ(v); setPage(1); }} className="w-64">
                        <SearchField.Group>
                          <SearchField.SearchIcon />
                          <SearchField.Input placeholder="会话编号或内容关键词" />
                          <SearchField.ClearButton />
                        </SearchField.Group>
                      </SearchField>
                    </div>
                    <div className="space-y-3">
                      {d.convs.map((c: any) => (
                        <div key={c.conv_row_id} className="rounded-lg border border-border p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-mono font-medium">{c.conversation_id}</span>
                            <span className="text-xs text-muted">{c.turn_qty} 轮</span>
                            {(d.cfg.conv_fields ?? []).filter((f: any) => f.list).map((f: any) =>
                              c.payload[f.key] ? <Chip key={f.key} size="sm">{f.label}：{String(c.payload[f.key])}</Chip> : null,
                            )}
                          </div>
                          {a.asset_kind_type === "sft" ? (
                            <div className="space-y-3">
                              {c.samples.map((s: any) => (
                                <div key={s.turn_no}>
                                  <div className="mb-1 flex items-center gap-2 text-xs">
                                    <span className="font-mono">{s.sample_id}</span>
                                    {s.is_valid ? <Chip size="sm" color="success">校验通过</Chip> : <Chip size="sm" color="danger">{s.invalid_reason_desc}</Chip>}
                                  </div>
                                  <MessagesView messages={s.content.messages} />
                                </div>
                              ))}
                            </div>
                          ) : (
                            <TurnsView payload={c.payload} cfg={d.cfg} />
                          )}
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer text-muted">原始 JSON</summary>
                            <div className="mt-2">
                              <JsonEditor value={c.payload} readOnly defaultDepth={1} />
                            </div>
                          </details>
                        </div>
                      ))}
                      {!d.convs.length ? <p className="py-6 text-center text-sm text-muted">没有会话</p> : null}
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-3 text-sm">
                      <Button size="sm" variant="tertiary" isDisabled={page === 1} onPress={() => setPage(page - 1)}>上一页</Button>
                      <span className="text-muted">
                        {d.total ? (page - 1) * PAGE + 1 : 0}–{Math.min(page * PAGE, d.total)} / {fmtNum(d.total)}
                      </span>
                      <Button size="sm" variant="tertiary" isDisabled={page * PAGE >= d.total} onPress={() => setPage(page + 1)}>下一页</Button>
                    </div>
                  </section>
                </Drawer.Body>
                <Drawer.Footer className="flex-wrap">
                  <Button variant="danger-soft" onPress={del} isDisabled={a.asset_status === 1 || d.requirements.length > 0}>删除</Button>
                  <a href={`/api/gen/assets/${id}/export?format=jsonl`}>
                    <Button variant="secondary">导出 JSONL（机器产出）</Button>
                  </a>
                  {a.asset_kind_type === "detail" ? (
                    <a href={`/api/gen/assets/${id}/export?format=csv`}>
                      <Button variant="secondary">导出明细 CSV</Button>
                    </a>
                  ) : null}
                  {a.asset_kind_type === "detail" && a.asset_status === 2 ? (
                    <Link href={`/assets/tasks?new=1&source_asset_id=${id}`}>
                      <Button variant="secondary">基于此资产 AI 预标注</Button>
                    </Link>
                  ) : null}
                  {a.asset_status === 2 ? (
                    <Link href={`/requirements?source=gen_asset_${id}`}>
                      <Button variant="primary">发布标注需求</Button>
                    </Link>
                  ) : null}
                </Drawer.Footer>
              </>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

function Info({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{k}</div>
      <div className="break-all">{v}</div>
    </div>
  );
}
