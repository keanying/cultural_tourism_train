"use client";

import { Alert, Button, Chip, Drawer, Input, Label, Spinner, TextField, toast, useOverlayState } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GenTaskChip, KindChip } from "@/components/gen/common";
import { JsonEditor, type Json } from "@/components/JsonEditor";
import { ListTable, PageHeader, Progress } from "@/components/ui";
import { api, fmtNum } from "@/lib/client";
import { GEN_TASK_TYPE } from "@/lib/roles";

const sel = "w-full rounded-lg border border-field-border bg-field px-3 py-2 text-sm";

export default function GenTasksPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const form = useOverlayState();
  const [preset, setPreset] = useState<{ source_asset_id?: number }>({});

  const load = useCallback(() => {
    api("/api/gen/tasks").then((j) => setTasks(j.tasks)).catch((e) => toast.danger(e.message));
  }, []);
  useEffect(() => {
    load();
    const sp = new URLSearchParams(location.search);
    if (sp.get("new")) {
      setPreset({ source_asset_id: sp.get("source_asset_id") ? Number(sp.get("source_asset_id")) : undefined });
      form.open();
    }
    if (sp.get("id")) setOpenId(Number(sp.get("id")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  const anyRunning = tasks.some((t) => t.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="AI 生成任务"
        desc="明细生成：按数据规格的维度轮转批量生成会话并去重；AI 预标注：对明细资产逐轮产出训练样本。产出自动成为数据资产，可发布标注需求进入人工审核。"
        actions={<Button variant="primary" onPress={() => { setPreset({}); form.open(); }}>新建生成任务</Button>}
      />
      <ListTable
        rows={tasks}
        idKey="task_id"
        onRowAction={(r) => setOpenId(r.task_id)}
        emptyText="暂无生成任务"
        columns={[
          { id: "task_no", name: "任务编号", render: (r) => <span className="font-mono text-xs">{r.task_no}</span> },
          { id: "task_name", name: "任务名称" },
          { id: "task_type", name: "方式", render: (r) => <span className="whitespace-nowrap">{GEN_TASK_TYPE[r.task_type] ?? r.task_type}</span> },
          { id: "spec_name", name: "数据规格" },
          { id: "task_status", name: "状态", render: (r) => <GenTaskChip status={r.task_status} /> },
          { id: "progress", name: "进度（会话）", render: (r) => <Progress value={r.done_unit_qty} total={r.target_qty} /> },
          { id: "stat", name: "调用 / 失败 / 去重", render: (r) => `${fmtNum(r.call_qty)} / ${fmtNum(r.fail_qty)} / ${fmtNum(r.dup_qty)}` },
          { id: "asset_name", name: "产出资产", render: (r) => (r.asset_id ? <Link className="text-accent" href={`/assets?asset=${r.asset_id}`}>{r.asset_name}</Link> : "—") },
          { id: "model_name", name: "模型" },
          { id: "create_time", name: "创建时间" },
          { id: "_op", name: "操作", render: (r) => <Button size="sm" variant="secondary" onPress={() => setOpenId(r.task_id)}>详情</Button> },
        ]}
      />
      <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />
      <NewTaskDrawer state={form} preset={preset} onCreated={(id) => { load(); setOpenId(id); }} />
    </div>
  );
}

/* ---------------------------------------------------------------- 新建任务 */

function NewTaskDrawer({ state, preset, onCreated }: { state: ReturnType<typeof useOverlayState>; preset: { source_asset_id?: number }; onCreated: (id: number) => void }) {
  const [opts, setOpts] = useState<{ specs: any[]; prompts: any[]; models: any[]; assets: any[]; dicts: Record<string, any> } | null>(null);
  const [f, setF] = useState<any>({ spec_code: "", prompt_id: "", model_id: "", task_name: "", target_qty: "50", batch_qty: "5", concurrency_qty: "3", source_asset_id: "", source_scope: "all", autostart: true });
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [variables, setVariables] = useState<Json>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state.isOpen) return;
    Promise.all([api("/api/gen/specs"), api("/api/gen/prompts"), api("/api/gen/models"), api("/api/gen/assets"), api("/api/gen/dicts")])
      .then(([s, p, m, a, d]) => {
        const specs = s.specs.filter((x: any) => x.is_active);
        const assets = a.generated;
        setOpts({ specs, prompts: p.prompts.filter((x: any) => x.is_active), models: m.models.filter((x: any) => x.is_active), assets, dicts: Object.fromEntries(d.dicts.map((x: any) => [x.dict_code, x.value])) });
        const def = m.models.find((x: any) => x.is_default && x.is_active) ?? m.models[0];
        let spec = "";
        let src = "";
        if (preset.source_asset_id) {
          const asset = assets.find((x: any) => x.asset_id === preset.source_asset_id);
          spec = specs.find((x: any) => x.spec_kind_type === "sft" && x.source_spec_code === asset?.spec_code)?.spec_code ?? "";
          src = String(preset.source_asset_id);
        }
        setF((o: any) => ({ ...o, model_id: def ? String(def.model_id) : "", spec_code: spec, source_asset_id: src }));
      })
      .catch((e) => toast.danger(e.message));
  }, [state.isOpen, preset]);

  const spec = opts?.specs.find((s) => s.spec_code === f.spec_code);
  const cfg = useMemo(() => {
    try {
      return spec ? JSON.parse(spec.config_json) : {};
    } catch {
      return {};
    }
  }, [spec]);
  useEffect(() => {
    setFilters({});
    setVariables(cfg.variables ?? {});
    const p = opts?.prompts.find((x) => x.spec_code === f.spec_code);
    setF((o: any) => ({ ...o, prompt_id: p ? String(p.prompt_id) : "", batch_qty: spec?.spec_kind_type === "sft" ? "1" : "5" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.spec_code, opts]);

  const prompts = opts?.prompts.filter((p) => p.spec_code === f.spec_code) ?? [];
  const srcAssets = opts?.assets.filter((a) => a.asset_kind_type === "detail" && a.asset_status === 2 && (!spec?.source_spec_code || a.spec_code === spec.source_spec_code)) ?? [];
  const model = opts?.models.find((m) => String(m.model_id) === f.model_id);
  const dims = (cfg.dimensions ?? []).filter((d: any) => d.filterable && d.mode !== "compose");
  const dimValues = (d: any): string[] => {
    let v: any = d.dict ? opts?.dicts[d.dict] : d.values;
    if (v && !Array.isArray(v) && typeof v === "object") v = v[d.path];
    return (Array.isArray(v) ? v : []).map((it: any) => (it && typeof it === "object" ? it[d.value_field || "name"] ?? it.name : it)).map(String);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const params: any = { variables, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v.length)) };
      if (spec?.spec_kind_type === "sft") params.source_scope = f.source_scope;
      const j = await api("/api/gen/tasks", {
        method: "POST",
        json: { ...f, model_id: Number(f.model_id), prompt_id: Number(f.prompt_id), source_asset_id: Number(f.source_asset_id) || 0, params },
      });
      toast.success(f.autostart ? "任务已创建并开始执行" : "任务已创建");
      state.close();
      onCreated(j.task_id);
    } catch (e: any) {
      toast.danger(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer state={state}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="h-full w-[95vw]! max-w-[820px]! sm:w-[820px]!">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading>新建 AI 生成任务</Drawer.Heading>
            </Drawer.Header>
            {!opts ? (
              <Drawer.Body className="flex justify-center py-20"><Spinner /></Drawer.Body>
            ) : (
              <>
                <Drawer.Body className="space-y-4">
                  <Field label="数据规格（决定生成什么数据）">
                    <select className={sel} value={f.spec_code} onChange={(e) => setF({ ...f, spec_code: e.target.value })}>
                      <option value="">请选择</option>
                      {opts.specs.map((s) => (
                        <option key={s.spec_code} value={s.spec_code}>
                          {s.spec_kind_type === "sft" ? "【AI 预标注 → 训练集】" : "【明细生成】"} {s.spec_name}（{s.spec_code}）
                        </option>
                      ))}
                    </select>
                    {spec?.remark_desc ? <p className="mt-1 text-xs text-muted">{spec.remark_desc}</p> : null}
                  </Field>
                  {spec ? (
                    <>
                      {spec.spec_kind_type === "sft" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="来源明细资产">
                            <select className={sel} value={f.source_asset_id} onChange={(e) => setF({ ...f, source_asset_id: e.target.value })}>
                              <option value="">请选择</option>
                              {srcAssets.map((a) => (
                                <option key={a.asset_id} value={a.asset_id}>#{a.asset_id} {a.asset_name}（{fmtNum(a.unit_qty)} 段会话）</option>
                              ))}
                            </select>
                            {!srcAssets.length ? <p className="mt-1 text-xs text-warning">还没有「{spec.source_spec_code}」规格的明细资产，请先执行明细生成任务。</p> : null}
                          </Field>
                          <Field label="来源范围">
                            <select className={sel} value={f.source_scope} onChange={(e) => setF({ ...f, source_scope: e.target.value })}>
                              <option value="all">全部会话（机器产出）</option>
                              <option value="delivered">仅已交付的标注结果（人工审核后的内容，剔除无效）</option>
                            </select>
                          </Field>
                        </div>
                      ) : null}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="提示词（执行时固化当前版本）">
                          <select className={sel} value={f.prompt_id} onChange={(e) => setF({ ...f, prompt_id: e.target.value })}>
                            {prompts.map((p) => (
                              <option key={p.prompt_id} value={p.prompt_id}>{p.prompt_name} · v{p.version_no}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="模型">
                          <select className={sel} value={f.model_id} onChange={(e) => setF({ ...f, model_id: e.target.value })}>
                            {opts.models.map((m) => (
                              <option key={m.model_id} value={m.model_id}>{m.model_name}{m.has_key ? "" : "（未填 API Key）"}</option>
                            ))}
                          </select>
                          {model && !model.has_key ? (
                            <p className="mt-1 text-xs text-warning">
                              该模型还没有 API Key，请先到 <Link className="underline" href="/assets/config">生成配置 → 模型管理</Link> 填写。
                            </p>
                          ) : null}
                        </Field>
                      </div>
                      <TextField value={f.task_name} onChange={(v) => setF({ ...f, task_name: v })}>
                        <Label>任务名称（可空，默认为规格名称 + 时间）</Label>
                        <Input />
                      </TextField>
                      <div className="grid grid-cols-3 gap-3">
                        <TextField value={f.target_qty} onChange={(v) => setF({ ...f, target_qty: v.replace(/\D/g, "") })}>
                          <Label>{spec.spec_kind_type === "sft" ? "预标注会话数上限" : "目标会话数"}</Label>
                          <Input inputMode="numeric" />
                        </TextField>
                        {spec.spec_kind_type === "detail" ? (
                          <TextField value={f.batch_qty} onChange={(v) => setF({ ...f, batch_qty: v.replace(/\D/g, "") })}>
                            <Label>每次调用生成</Label>
                            <Input inputMode="numeric" />
                          </TextField>
                        ) : <div />}
                        <TextField value={f.concurrency_qty} onChange={(v) => setF({ ...f, concurrency_qty: v.replace(/\D/g, "") })}>
                          <Label>并发数</Label>
                          <Input inputMode="numeric" />
                        </TextField>
                      </div>
                      {dims.length ? (
                        <div>
                          <div className="mb-1 text-sm">维度筛选（不选 = 全部轮转）</div>
                          <div className="space-y-2 rounded-lg border border-border p-3">
                            {dims.map((d: any) => (
                              <div key={d.var}>
                                <div className="mb-1 text-xs text-muted">{d.label ?? d.var}</div>
                                <div className="flex flex-wrap gap-1">
                                  {dimValues(d).map((v) => {
                                    const on = (filters[d.var] ?? []).includes(v);
                                    return (
                                      <button
                                        key={v}
                                        type="button"
                                        onClick={() => setFilters({ ...filters, [d.var]: on ? filters[d.var].filter((x) => x !== v) : [...(filters[d.var] ?? []), v] })}
                                        className={`rounded-full px-2 py-0.5 text-xs ${on ? "bg-accent text-accent-foreground" : "bg-surface-secondary hover:bg-surface-tertiary"}`}
                                      >
                                        {v}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {variables && typeof variables === "object" && Object.keys(variables).length ? (
                        <div>
                          <div className="mb-1 text-sm">任务变量（覆盖规格中的默认值，提示词以 {"{{变量名}}"} 引用）</div>
                          <JsonEditor value={variables} onChange={setVariables} fixedKeys />
                        </div>
                      ) : null}
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="size-4" checked={f.autostart} onChange={(e) => setF({ ...f, autostart: e.target.checked })} />
                        创建后立即执行
                      </label>
                    </>
                  ) : null}
                </Drawer.Body>
                <Drawer.Footer>
                  <Button variant="tertiary" onPress={state.close}>取消</Button>
                  <Button
                    variant="primary"
                    isDisabled={busy || !spec || !f.prompt_id || !f.model_id || (spec.spec_kind_type === "sft" && !f.source_asset_id)}
                    onPress={submit}
                  >
                    创建任务
                  </Button>
                </Drawer.Footer>
              </>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm">{label}</label>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- 任务详情 */

function TaskDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const state = useOverlayState({ isOpen: id !== null, onOpenChange: (o) => !o && onClose() });
  const [d, setD] = useState<any>(null);
  const load = useCallback(() => {
    if (id === null) return;
    api(`/api/gen/tasks/${id}`).then(setD).catch((e) => toast.danger(e.message));
  }, [id]);
  useEffect(() => {
    setD(null);
    load();
  }, [load]);
  const running = !!d?.task.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      load();
      onChanged();
    }, 2000);
    return () => clearInterval(t);
  }, [running, load, onChanged]);

  const act = async (action: string) => {
    try {
      await api(`/api/gen/tasks/${id}`, { method: "POST", json: { action } });
      toast.success({ start: "已开始执行", cancel: "已发送停止指令", rerun: "已重新执行（将产出新版本资产）" }[action] ?? "完成");
      load();
      onChanged();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };
  const del = async () => {
    if (!window.confirm("删除任务（产出的资产会保留）？")) return;
    try {
      await api(`/api/gen/tasks/${id}`, { method: "DELETE" });
      onChanged();
      state.close();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  const t = d?.task;
  return (
    <Drawer state={state}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="h-full w-[95vw]! max-w-[900px]! sm:w-[900px]!">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="flex flex-wrap items-center gap-2">
                {t ? <>{t.task_name} <GenTaskChip status={t.task_status} /> <KindChip kind={t.spec_kind_type} /></> : "任务详情"}
              </Drawer.Heading>
            </Drawer.Header>
            {!t ? (
              <Drawer.Body className="flex justify-center py-20"><Spinner /></Drawer.Body>
            ) : (
              <>
                <Drawer.Body className="space-y-5">
                  {t.task_status === 4 && t.error_desc ? (
                    <Alert status="danger">
                      <Alert.Content>
                        <Alert.Title>执行失败</Alert.Title>
                        <Alert.Description><pre className="whitespace-pre-wrap font-sans">{t.error_desc}</pre></Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}
                  <section className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
                    <Info k="任务编号" v={t.task_no} />
                    <Info k="方式" v={GEN_TASK_TYPE[t.task_type] ?? t.task_type} />
                    <Info k="数据规格" v={`${t.spec_name}（${t.spec_code}）`} />
                    <Info k="模型" v={t.model_name} />
                    <Info k="提示词" v={`${t.prompt_name} · v${t.prompt_version_no}`} />
                    <Info k="来源明细资产" v={t.source_asset_name ?? "—"} />
                    <Info k="每批 / 并发" v={`${t.batch_qty} / ${t.concurrency_qty}`} />
                    <Info k="创建人" v={t.user_name} />
                    <Info k="开始时间" v={t.start_time ?? "—"} />
                    <Info k="结束时间" v={t.finish_time ?? "—"} />
                    <Info k="token（入 / 出）" v={`${fmtNum(t.token_in_qty)} / ${fmtNum(t.token_out_qty)}`} />
                    <Info k="调用 / 失败 / 去重" v={`${fmtNum(t.call_qty)} / ${fmtNum(t.fail_qty)} / ${fmtNum(t.dup_qty)}`} />
                  </section>
                  <section className="flex flex-wrap items-center gap-4 text-sm">
                    <span>会话进度</span>
                    <div className="w-72"><Progress value={t.done_unit_qty} total={t.target_qty} /></div>
                    <span className="text-muted">{t.spec_kind_type === "sft" ? "训练样本" : "问答对"} {fmtNum(t.done_pair_qty)}</span>
                    {t.asset_id ? (
                      <Link className="text-accent" href={`/assets?asset=${t.asset_id}`}>产出资产：{t.asset_name} →</Link>
                    ) : null}
                    {running ? <Chip size="sm" color="accent">执行中，自动刷新</Chip> : null}
                  </section>
                  <section>
                    <h3 className="mb-2 text-sm font-medium">执行日志</h3>
                    <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border bg-surface-secondary p-2 font-mono text-xs">
                      {d.logs.map((l: any) => (
                        <div key={l.log_id} className={l.level_type === "error" ? "text-danger" : l.level_type === "warn" ? "text-warning" : ""}>
                          <span className="text-muted">{l.create_time.slice(11)}</span> {l.message_desc}
                        </div>
                      ))}
                    </div>
                  </section>
                </Drawer.Body>
                <Drawer.Footer className="flex-wrap">
                  <Button variant="danger-soft" isDisabled={running} onPress={del}>删除任务</Button>
                  {running ? <Button variant="secondary" onPress={() => act("cancel")}>停止</Button> : null}
                  {!running && [1, 4, 5].includes(t.task_status) ? (
                    <Button variant="primary" onPress={() => act("start")}>{t.task_status === 1 ? "开始执行" : "继续执行"}</Button>
                  ) : null}
                  {!running && t.task_status !== 1 ? <Button variant="secondary" onPress={() => window.confirm("重新执行会产出一份新版本资产，确认？") && act("rerun")}>重新执行</Button> : null}
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
