"use client";

import { Button, Drawer, Input, Label, TextArea, TextField, toast, useOverlayState } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/AppShell";
import { RequirementDrawer, sourceSummary, type SourceBrief } from "@/components/RequirementDrawer";
import { ListTable, PageHeader, Progress, ReqStatusChip } from "@/components/ui";
import { api, fmtNum } from "@/lib/client";
import { can } from "@/lib/roles";

const STANDARD_TEMPLATE = `一、标注目标
逐条检查样本是否符合任务规范，必要时直接修正内容。

二、判定规则
1. 正确：内容符合业务规则与格式要求，无需修改；
2. 已修正：存在错误（数值计算、约束违规、话术与库存不符等），已在平台内修正；
3. 无效剔除：样本本身无意义或无法修正，交付时剔除。

三、重点检查项
- 输入与输出中的数字必须可复算，严禁编造；
- 训练样本须保持 <thought>/<answer> 结构，JSON 字段完整；
- 编码字段取值必须在定义范围内。

四、验收标准
抽检合格率 ≥ 98%。`;

type SrcSel = { checked: boolean; split_type: string; max_qty: string };

export default function RequirementsPage() {
  const me = useMe();
  const [reqs, setReqs] = useState<any[]>([]);
  const [sources, setSources] = useState<SourceBrief[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const form = useOverlayState();
  const [f, setF] = useState({ project_id: "", requirement_name: "", requirement_desc: "", standard_content: STANDARD_TEMPLATE });
  const [sel, setSel] = useState<Record<string, SrcSel>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const pid = new URLSearchParams(location.search).get("project_id");
    api(`/api/lbl/requirements${pid ? `?project_id=${pid}` : ""}`).then((j) => setReqs(j.requirements)).catch((e) => toast.danger(e.message));
  }, []);
  useEffect(() => {
    load();
    api("/api/lbl/sources").then((j) => setSources(j.sources)).catch(() => {});
    api("/api/lbl/projects").then((j) => setProjects(j.projects)).catch(() => {});
    const id = new URLSearchParams(location.search).get("id");
    if (id) setOpenId(Number(id));
  }, [load]);

  const publish = async () => {
    const source_config = Object.entries(sel)
      .filter(([, v]) => v.checked)
      .map(([k, v]) => ({ source_code: k, split_type: v.split_type || undefined, max_qty: v.max_qty ? Number(v.max_qty) : undefined }));
    setBusy(true);
    try {
      await api("/api/lbl/requirements", { method: "POST", json: { ...f, project_id: Number(f.project_id), source_config } });
      toast.success("需求已发布，等待管理员接收");
      form.close();
      setSel({});
      load();
    } catch (e: any) {
      toast.danger(e.message);
    } finally {
      setBusy(false);
    }
  };

  const total = Object.entries(sel)
    .filter(([, v]) => v.checked)
    .reduce((s, [k, v]) => {
      const src = sources.find((x) => x.name === k);
      const base = src ? (src.kind === "sft" && v.split_type ? (v.split_type === "train" ? src.rows * 0.94 : src.rows * 0.03) : src.rows) : 0;
      return s + (v.max_qty ? Math.min(Number(v.max_qty), base) : base);
    }, 0);

  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="需求区"
        desc={me.role_type === "requester" ? "指定数据并发布标注需求与标注标准；管理员接收后切块下发到标注区" : "接收需求员发布的标注需求，确认后按 5000 条/块下发到标注区"}
        actions={can(me.role_type, "publishRequirement") ? <Button variant="primary" onPress={form.open} isDisabled={!projects.length}>发布标注需求</Button> : null}
      />
      {can(me.role_type, "publishRequirement") && !projects.length ? (
        <p className="mb-4 text-sm text-warning">请先在「项目区」创建项目，再发布需求。</p>
      ) : null}
      <ListTable
        rows={reqs}
        idKey="requirement_id"
        onRowAction={(r) => setOpenId(r.requirement_id)}
        emptyText="暂无需求"
        columns={[
          { id: "requirement_id", name: "编号", render: (r) => `#${r.requirement_id}` },
          { id: "requirement_name", name: "需求名称" },
          { id: "project_name", name: "所属项目" },
          { id: "source_config", name: "指定数据", render: (r) => <span className="line-clamp-2 block min-w-[200px] max-w-[320px]">{sourceSummary(r.source_config, sources)}</span> },
          { id: "requirement_status", name: "状态", render: (r) => <ReqStatusChip status={r.requirement_status} /> },
          { id: "chunk_qty", name: "分块进度", render: (r) => (r.chunk_qty ? <Progress value={r.passed_chunk_qty} total={r.chunk_qty} /> : "—") },
          { id: "item_qty", name: "条数", render: (r) => (r.item_qty ? fmtNum(r.item_qty) : "—") },
          { id: "requester_name", name: "需求员" },
          { id: "create_time", name: "发布时间" },
          { id: "_op", name: "操作", render: (r) => <Button size="sm" variant="secondary" onPress={() => setOpenId(r.requirement_id)}>详情</Button> },
        ]}
      />

      <RequirementDrawer id={openId} sources={sources} onClose={() => setOpenId(null)} onChanged={load} />

      <Drawer state={form}>
        <Drawer.Backdrop>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="h-full w-[95vw]! max-w-[820px]! sm:w-[820px]!">
              <Drawer.CloseTrigger />
              <Drawer.Header>
                <Drawer.Heading>发布标注需求</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm">所属项目</label>
                  <select
                    className="w-full rounded-lg border border-field-border bg-field px-3 py-2 text-sm"
                    value={f.project_id}
                    onChange={(e) => setF({ ...f, project_id: e.target.value })}
                  >
                    <option value="">请选择项目</option>
                    {projects.map((p) => (
                      <option key={p.project_id} value={p.project_id}>{p.project_name}</option>
                    ))}
                  </select>
                </div>
                <TextField value={f.requirement_name} onChange={(v) => setF({ ...f, requirement_name: v })}>
                  <Label>需求名称</Label>
                  <Input placeholder="如：动态定价训练集人工校验（测试集）" />
                </TextField>
                <TextField value={f.requirement_desc} onChange={(v) => setF({ ...f, requirement_desc: v })}>
                  <Label>需求说明（可选）</Label>
                  <TextArea rows={2} />
                </TextField>
                <div>
                  <div className="mb-2 text-sm">指定数据（可多选；训练集可限定切分，均可设置条数上限）</div>
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    {sources.map((s) => {
                      const v = sel[s.name] ?? { checked: false, split_type: "", max_qty: "" };
                      const set = (patch: Partial<SrcSel>) => setSel({ ...sel, [s.name]: { ...v, ...patch } });
                      return (
                        <div key={s.name} className="flex flex-wrap items-center gap-3">
                          <label className="flex min-w-[300px] cursor-pointer items-center gap-2">
                            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.checked} onChange={(e) => set({ checked: e.target.checked })} />
                            <span className="text-sm">{s.title}</span>
                            <span className="font-mono text-xs text-muted">{fmtNum(s.rows)} 条</span>
                          </label>
                          {v.checked ? (
                            <>
                              {s.kind === "sft" ? (
                                <select className="rounded-md border border-field-border bg-field px-2 py-1 text-sm" value={v.split_type} onChange={(e) => set({ split_type: e.target.value })}>
                                  <option value="">全部切分</option>
                                  <option value="train">训练集</option>
                                  <option value="val">验证集</option>
                                  <option value="test">测试集</option>
                                </select>
                              ) : null}
                              <input
                                className="w-32 rounded-md border border-field-border bg-field px-2 py-1 text-sm"
                                placeholder="条数上限（可空）"
                                inputMode="numeric"
                                value={v.max_qty}
                                onChange={(e) => set({ max_qty: e.target.value.replace(/\D/g, "") })}
                              />
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    预计约 {fmtNum(Math.round(total))} 条，将切分为约 {Math.max(1, Math.ceil(total / 5000))} 个分块
                  </p>
                </div>
                <TextField value={f.standard_content} onChange={(v) => setF({ ...f, standard_content: v })}>
                  <Label>标注标准（标注员与审核员在作业页可随时查看）</Label>
                  <TextArea rows={14} className="font-mono text-xs" />
                </TextField>
              </Drawer.Body>
              <Drawer.Footer>
                <Button variant="tertiary" onPress={form.close}>取消</Button>
                <Button
                  variant="primary"
                  isDisabled={busy || !f.project_id || !f.requirement_name.trim() || !Object.values(sel).some((v) => v.checked)}
                  onPress={publish}
                >
                  发布需求
                </Button>
              </Drawer.Footer>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </div>
  );
}
