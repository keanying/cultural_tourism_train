"use client";

import { Button, Chip, Drawer, Input, Label, Modal, Spinner, Tabs, TextField, toast, useOverlayState } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KindChip } from "@/components/gen/common";
import { JsonEditor, type Json } from "@/components/JsonEditor";
import { ListTable, PageHeader } from "@/components/ui";
import { api } from "@/lib/client";
import { GEN_TASK_TYPE } from "@/lib/roles";

const sel = "w-full rounded-lg border border-field-border bg-field px-3 py-2 text-sm";
const mono = "w-full rounded-lg border border-field-border bg-field p-2 font-mono text-xs leading-relaxed";

export default function GenConfigPage() {
  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="生成配置"
        desc="模型、数据规格、提示词、业务字典。业务语义全部在规格与提示词中定义：新增一类生成数据只需新增规格和提示词，不改代码。"
      />
      <Tabs defaultSelectedKey="models">
        <Tabs.ListContainer>
          <Tabs.List aria-label="生成配置">
            <Tabs.Tab id="models">模型管理<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="specs">数据规格<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="prompts">提示词<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dicts">业务字典<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="models" className="pt-4"><Models /></Tabs.Panel>
        <Tabs.Panel id="specs" className="pt-4"><Specs /></Tabs.Panel>
        <Tabs.Panel id="prompts" className="pt-4"><Prompts /></Tabs.Panel>
        <Tabs.Panel id="dicts" className="pt-4"><Dicts /></Tabs.Panel>
      </Tabs>
    </div>
  );
}

function useList<T = any>(url: string, key: string) {
  const [rows, setRows] = useState<T[] | null>(null);
  const load = useCallback(() => {
    api(url).then((j) => setRows(j[key])).catch((e) => toast.danger(e.message));
  }, [url, key]);
  useEffect(load, [load]);
  return [rows, load] as const;
}

async function run(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
    toast.success(ok);
    return true;
  } catch (e: any) {
    toast.danger(e.message);
    return false;
  }
}

/* ---------------------------------------------------------------- 模型管理 */

const EMPTY_MODEL = {
  model_name: "", provider_name: "", base_url: "https://api.deepseek.com", model_code: "deepseek-chat", api_key_value: "", api_style_type: "auto",
  temperature_rate: "0.8", top_p_rate: "0.9", max_token_qty: "8192", timeout_sec_qty: "180", extra_body_json: "{}", is_default: false, is_active: true, remark_desc: "",
};

function Models() {
  const [rows, load] = useList("/api/gen/models", "models");
  const modal = useOverlayState();
  const [f, setF] = useState<any>(EMPTY_MODEL);
  const [editId, setEditId] = useState<number | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  const open = (m?: any) => {
    setEditId(m?.model_id ?? null);
    setF(m ? { ...EMPTY_MODEL, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" && !["is_default", "is_active"].includes(k) ? String(v) : v])), api_key_value: "", is_default: !!m.is_default, is_active: !!m.is_active } : EMPTY_MODEL);
    modal.open();
  };
  const save = async () => {
    const { api_key_mask, has_key, model_id, create_time, update_time, ...body } = f;
    if (!body.api_key_value) delete body.api_key_value;
    const ok = await run(() => api(editId ? `/api/gen/models/${editId}` : "/api/gen/models", { method: editId ? "PATCH" : "POST", json: body }), "已保存");
    if (ok) {
      modal.close();
      load();
    }
  };
  const test = async (id: number) => {
    setTesting(id);
    try {
      const j = await api(`/api/gen/models/${id}/test`, { method: "POST" });
      toast.success(`连通正常：「${j.reply}」（${j.style} 协议，${j.ms}ms）`);
    } catch (e: any) {
      toast.danger(e.message);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-sm text-muted">支持任何 OpenAI 兼容接口（DeepSeek、OpenAI、火山方舟、通义、自建网关等）。API Key 只保存在本地数据库，页面只显示掩码。</p>
        <Button variant="primary" onPress={() => open()}>新增模型</Button>
      </div>
      <ListTable
        rows={rows ?? []}
        idKey="model_id"
        emptyText={rows ? "暂无模型" : "加载中…"}
        columns={[
          { id: "model_name", name: "名称", render: (m) => <span>{m.model_name} {m.is_default ? <Chip size="sm" color="accent">默认</Chip> : null} {m.is_active ? null : <Chip size="sm">停用</Chip>}</span> },
          { id: "base_url", name: "接口地址", render: (m) => <span className="font-mono text-xs">{m.base_url}</span> },
          { id: "model_code", name: "模型编码", render: (m) => <span className="font-mono text-xs">{m.model_code}</span> },
          { id: "api_style_type", name: "协议" },
          { id: "key", name: "API Key", render: (m) => (m.has_key ? <span className="font-mono text-xs">{m.api_key_mask}</span> : <Chip size="sm" color="warning">未填写</Chip>) },
          { id: "temperature_rate", name: "温度" },
          { id: "max_token_qty", name: "最大输出" },
          {
            id: "_op",
            name: "操作",
            render: (m) => (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onPress={() => open(m)}>编辑</Button>
                <Button size="sm" variant="tertiary" isDisabled={!m.has_key || testing === m.model_id} onPress={() => test(m.model_id)}>{testing === m.model_id ? "测试中…" : "测试"}</Button>
                <Button size="sm" variant="ghost" onPress={() => window.confirm("删除该模型配置？") && run(() => api(`/api/gen/models/${m.model_id}`, { method: "DELETE" }), "已删除").then(load)}>删除</Button>
              </div>
            ),
          },
        ]}
      />
      <Modal state={modal}>
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.Header><Modal.Heading>{editId ? "编辑模型" : "新增模型"}</Modal.Heading></Modal.Header>
              <Modal.Body className="grid grid-cols-2 gap-3">
                <TF label="名称" v={f.model_name} on={(v) => setF({ ...f, model_name: v })} />
                <TF label="服务商（可选）" v={f.provider_name ?? ""} on={(v) => setF({ ...f, provider_name: v })} />
                <TF label="接口地址 Base URL" v={f.base_url} on={(v) => setF({ ...f, base_url: v })} wide />
                <TF label="模型编码 / 接入点ID" v={f.model_code} on={(v) => setF({ ...f, model_code: v })} />
                <div>
                  <label className="mb-1 block text-sm">接口协议</label>
                  <select className={sel} value={f.api_style_type} onChange={(e) => setF({ ...f, api_style_type: e.target.value })}>
                    <option value="auto">auto（自动探测）</option>
                    <option value="chat">chat（/chat/completions）</option>
                    <option value="responses">responses（/responses）</option>
                  </select>
                </div>
                <TF label={editId ? "API Key（留空则不修改）" : "API Key"} v={f.api_key_value} on={(v) => setF({ ...f, api_key_value: v })} type="password" wide />
                <TF label="温度" v={f.temperature_rate} on={(v) => setF({ ...f, temperature_rate: v })} />
                <TF label="top_p" v={f.top_p_rate} on={(v) => setF({ ...f, top_p_rate: v })} />
                <TF label="最大输出 token" v={f.max_token_qty} on={(v) => setF({ ...f, max_token_qty: v })} />
                <TF label="超时（秒）" v={f.timeout_sec_qty} on={(v) => setF({ ...f, timeout_sec_qty: v })} />
                <TF label="额外请求参数（JSON）" v={f.extra_body_json} on={(v) => setF({ ...f, extra_body_json: v })} wide />
                <TF label="备注" v={f.remark_desc ?? ""} on={(v) => setF({ ...f, remark_desc: v })} wide />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} />设为默认（AI 再标优先使用）</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />启用</label>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" onPress={modal.close}>取消</Button>
                <Button variant="primary" onPress={save} isDisabled={!f.model_name || !f.base_url || !f.model_code}>保存</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function TF({ label, v, on, type, wide }: { label: string; v: string; on: (v: string) => void; type?: string; wide?: boolean }) {
  return (
    <TextField value={v} onChange={on} type={type} className={wide ? "col-span-2" : ""}>
      <Label>{label}</Label>
      <Input />
    </TextField>
  );
}

/* ---------------------------------------------------------------- 数据规格 */

const SPEC_HELP = `config 常用键：
· 明细（detail）：dimensions 维度轮转（var/mode=rotate|weighted|random|compose/dict/value_field/extra/child/filterable）、variables 默认变量、
  required 必填字段、dedup_field 去重字段、avoid_field 防重复字段、conv_fields / turn_fields 导出字段、turn_view 预览与标注展示字段
· 训练集（sft）：expand 轮次展开（history_template 历史模板）、sample_id_template 样本编号模板、messages 样本模板（{{字段}}、{{字段|json}}、{{#x}}…{{/x}}）、
  validators 校验器（nonempty / json_key / int_range / max_chars）、ai_fields 标注时的 AI 字段说明`;

function Specs() {
  const [rows, load] = useList("/api/gen/specs", "specs");
  const drawer = useOverlayState();
  const [cur, setCur] = useState<any>(null);
  const [cfg, setCfg] = useState<Json>({});
  const [tags, setTags] = useState<Json>({});
  const [isNew, setIsNew] = useState(false);

  const open = (s?: any) => {
    setIsNew(!s);
    setCur(s ? { ...s } : { spec_code: "", spec_name: "", spec_kind_type: "detail", source_spec_code: "", remark_desc: "", sort_no: 100, is_active: 1 });
    setCfg(s ? JSON.parse(s.config_json) : { dimensions: [], variables: {}, required: ["turns"], dedup_field: "turns.0", conv_fields: [], turn_fields: [], turn_view: [] });
    setTags(s ? JSON.parse(s.tag_json || "{}") : { 业务: "", 任务: "", 类型: "明细", 领域: "旅游" });
    drawer.open();
  };
  const save = async () => {
    const body = { ...cur, config_json: JSON.stringify(cfg), tag_json: JSON.stringify(tags) };
    const ok = await run(() => api(isNew ? "/api/gen/specs" : `/api/gen/specs/${cur.spec_id}`, { method: isNew ? "POST" : "PATCH", json: body }), "已保存");
    if (ok) {
      drawer.close();
      load();
    }
  };

  return (
    <div>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-sm text-muted">一份规格 = 一类产出的定义：生成哪些维度、会话长什么样、训练样本怎么拼、如何校验。</p>
        <Button variant="primary" onPress={() => open()}>新建规格</Button>
      </div>
      <ListTable
        rows={rows ?? []}
        idKey="spec_id"
        pageSize={12}
        onRowAction={open}
        emptyText={rows ? "暂无规格" : "加载中…"}
        columns={[
          { id: "spec_code", name: "编码", render: (s) => <span className="font-mono text-xs">{s.spec_code}</span> },
          { id: "spec_name", name: "名称", render: (s) => <span>{s.spec_name} {s.is_active ? null : <Chip size="sm">停用</Chip>}</span> },
          { id: "kind", name: "产出", render: (s) => <KindChip kind={s.spec_kind_type} /> },
          { id: "task_type", name: "生产方式", render: (s) => GEN_TASK_TYPE[s.task_type] },
          { id: "source_spec_code", name: "来源规格", render: (s) => s.source_spec_code || "—" },
          { id: "prompt_qty", name: "提示词" },
          { id: "task_qty", name: "任务" },
          { id: "asset_qty", name: "资产" },
          { id: "remark_desc", name: "说明", render: (s) => <span className="line-clamp-2 block max-w-[280px] text-xs">{s.remark_desc}</span> },
          {
            id: "_op",
            name: "操作",
            render: (s) => (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onPress={() => open(s)}>编辑</Button>
                <Button size="sm" variant="ghost" isDisabled={s.task_qty + s.asset_qty > 0} onPress={() => window.confirm("删除该规格？") && run(() => api(`/api/gen/specs/${s.spec_id}`, { method: "DELETE" }), "已删除").then(load)}>删除</Button>
              </div>
            ),
          },
        ]}
      />
      <Drawer state={drawer}>
        <Drawer.Backdrop>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="h-full w-[95vw]! max-w-[900px]! sm:w-[900px]!">
              <Drawer.CloseTrigger />
              <Drawer.Header><Drawer.Heading>{isNew ? "新建数据规格" : `编辑规格 ${cur?.spec_code}`}</Drawer.Heading></Drawer.Header>
              {cur ? (
                <Drawer.Body className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    {isNew ? <TF label="规格编码（小写字母、数字、下划线）" v={cur.spec_code} on={(v) => setCur({ ...cur, spec_code: v })} /> : null}
                    <TF label="规格名称" v={cur.spec_name} on={(v) => setCur({ ...cur, spec_name: v })} />
                    {isNew ? (
                      <div>
                        <label className="mb-1 block text-sm">产出类型</label>
                        <select className={sel} value={cur.spec_kind_type} onChange={(e) => setCur({ ...cur, spec_kind_type: e.target.value })}>
                          <option value="detail">明细数据（明细生成）</option>
                          <option value="sft">训练集（AI 预标注）</option>
                        </select>
                      </div>
                    ) : null}
                    {isNew && cur.spec_kind_type === "sft" ? (
                      <div>
                        <label className="mb-1 block text-sm">来源明细规格</label>
                        <select className={sel} value={cur.source_spec_code} onChange={(e) => setCur({ ...cur, source_spec_code: e.target.value })}>
                          <option value="">请选择</option>
                          {(rows ?? []).filter((s) => s.spec_kind_type === "detail").map((s) => <option key={s.spec_code} value={s.spec_code}>{s.spec_name}</option>)}
                        </select>
                      </div>
                    ) : null}
                    <TF label="说明" v={cur.remark_desc ?? ""} on={(v) => setCur({ ...cur, remark_desc: v })} wide />
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={!!cur.is_active} onChange={(e) => setCur({ ...cur, is_active: e.target.checked ? 1 : 0 })} />启用</label>
                  <div>
                    <div className="mb-1 text-sm">资产标签</div>
                    <JsonEditor value={tags} onChange={setTags} defaultDepth={1} />
                  </div>
                  <div>
                    <div className="mb-1 text-sm">规格配置 config</div>
                    <pre className="mb-2 whitespace-pre-wrap rounded-lg bg-surface-secondary p-2 text-xs text-muted">{SPEC_HELP}</pre>
                    <JsonEditor value={cfg} onChange={setCfg} defaultDepth={1} expandStringJson={false} />
                  </div>
                </Drawer.Body>
              ) : null}
              <Drawer.Footer>
                <Button variant="tertiary" onPress={drawer.close}>取消</Button>
                <Button variant="primary" onPress={save}>保存</Button>
              </Drawer.Footer>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </div>
  );
}

/* ---------------------------------------------------------------- 提示词 */

/** 规格下提示词可用的模板变量 */
function promptVars(spec: any, dictCodes: string[]): { name: string; desc: string }[] {
  if (!spec) return [];
  let cfg: any = {};
  try {
    cfg = JSON.parse(spec.config_json);
  } catch {
    /* 忽略 */
  }
  const out: { name: string; desc: string }[] = [];
  if (spec.spec_kind_type === "detail") {
    for (const d of cfg.dimensions ?? []) {
      out.push({ name: d.var, desc: `维度：${d.label ?? d.var}` });
      for (const k of Object.keys(d.extra ?? {})) out.push({ name: k, desc: `维度 ${d.var} 附带字段` });
      if (d.child?.var) out.push({ name: d.child.var, desc: `维度 ${d.var} 的子项` });
    }
    for (const k of Object.keys(cfg.variables ?? {})) out.push({ name: k, desc: "任务变量" });
    out.push({ name: "batch_size", desc: "每次生成会话数" }, { name: "avoid_list", desc: "已生成内容（防重复）" });
  } else {
    out.push(
      { name: "conv_json", desc: "完整会话 JSON" },
      { name: "conv_id", desc: "会话编号" },
      { name: "turn_index", desc: "当前轮次" },
      { name: "turn_total", desc: "总轮次" },
      { name: "history", desc: "历史对话（按 history_template 拼接）" },
    );
    out.push({ name: "（会话与本轮字段）", desc: "如 question、kb_text、profile 等，直接以 {{字段名}} 引用" });
  }
  for (const c of dictCodes) out.push({ name: `dict_${c}`, desc: "业务字典" });
  return out;
}

function Prompts() {
  const [rows, load] = useList("/api/gen/prompts", "prompts");
  const [specs] = useList("/api/gen/specs", "specs");
  const [dicts] = useList("/api/gen/dicts", "dicts");
  const drawer = useOverlayState();
  const [cur, setCur] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [viewVer, setViewVer] = useState<any>(null);

  const open = async (p?: any) => {
    setViewVer(null);
    if (!p) {
      setCur({ prompt_name: "", spec_code: specs?.[0]?.spec_code ?? "", system_prompt_text: "", user_prompt_text: "", remark_desc: "", note_desc: "", isNew: true });
      setVersions([]);
    } else {
      const j = await api(`/api/gen/prompts/${p.prompt_id}`);
      setCur({ ...j.prompt, note_desc: "" });
      setVersions(j.versions);
    }
    drawer.open();
  };
  const save = async () => {
    const ok = await run(
      () => (cur.isNew ? api("/api/gen/prompts", { method: "POST", json: cur }) : api(`/api/gen/prompts/${cur.prompt_id}`, { method: "PATCH", json: cur })),
      cur.isNew ? "已创建" : "已保存（正文有改动时自动生成新版本）",
    );
    if (ok) {
      drawer.close();
      load();
    }
  };
  const restore = async (v: number) => {
    if (!window.confirm(`把 v${v} 的内容恢复为新的当前版本？`)) return;
    if (await run(() => api(`/api/gen/prompts/${cur.prompt_id}`, { method: "PATCH", json: { restore_version: v } }), "已恢复")) {
      drawer.close();
      load();
    }
  };
  const spec = specs?.find((s) => s.spec_code === cur?.spec_code);
  const vars = useMemo(() => promptVars(spec, (dicts ?? []).map((d: any) => d.dict_code)), [spec, dicts]);

  return (
    <div>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-sm text-muted">每次修改正文自动留存版本；生成任务执行时固化版本号，任何一条数据都能回溯到生成时的确切提示词，AI 再标也沿用该版本。</p>
        <Button variant="primary" onPress={() => open()}>新建提示词</Button>
      </div>
      <ListTable
        rows={rows ?? []}
        idKey="prompt_id"
        pageSize={12}
        onRowAction={open}
        emptyText={rows ? "暂无提示词" : "加载中…"}
        columns={[
          { id: "prompt_name", name: "名称", render: (p) => <span>{p.prompt_name} {p.is_active ? null : <Chip size="sm">停用</Chip>}</span> },
          { id: "prompt_code", name: "编码", render: (p) => <span className="font-mono text-xs">{p.prompt_code}</span> },
          { id: "spec_name", name: "适用规格", render: (p) => <span>{p.spec_name} <KindChip kind={p.spec_kind_type} /></span> },
          { id: "version_no", name: "当前版本", render: (p) => `v${p.version_no}` },
          { id: "task_qty", name: "任务数" },
          { id: "update_time", name: "更新时间" },
          { id: "_op", name: "操作", render: (p) => <Button size="sm" variant="secondary" onPress={() => open(p)}>编辑</Button> },
        ]}
      />
      <Drawer state={drawer}>
        <Drawer.Backdrop>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="h-full w-[95vw]! max-w-[1100px]! sm:w-[1100px]!">
              <Drawer.CloseTrigger />
              <Drawer.Header><Drawer.Heading>{cur?.isNew ? "新建提示词" : `${cur?.prompt_name} · v${cur?.version_no}`}</Drawer.Heading></Drawer.Header>
              {cur ? (
                <Drawer.Body className="grid gap-4 lg:grid-cols-[1fr_260px]">
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <TF label="名称" v={cur.prompt_name} on={(v) => setCur({ ...cur, prompt_name: v })} />
                      {cur.isNew ? (
                        <div>
                          <label className="mb-1 block text-sm">适用规格</label>
                          <select className={sel} value={cur.spec_code} onChange={(e) => setCur({ ...cur, spec_code: e.target.value })}>
                            {(specs ?? []).map((s) => <option key={s.spec_code} value={s.spec_code}>{s.spec_name}</option>)}
                          </select>
                        </div>
                      ) : (
                        <TF label="本次修改说明（写入版本记录）" v={cur.note_desc} on={(v) => setCur({ ...cur, note_desc: v })} />
                      )}
                    </div>
                    <div>
                      <label className="mb-1 block text-sm">系统提示词</label>
                      <textarea className={mono} rows={14} value={cur.system_prompt_text} onChange={(e) => setCur({ ...cur, system_prompt_text: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm">用户提示词（支持 {"{{变量}}"}、{"{{变量|json}}"}、{"{{#变量}}…{{/变量}}"}）</label>
                      <textarea className={mono} rows={18} value={cur.user_prompt_text} onChange={(e) => setCur({ ...cur, user_prompt_text: e.target.value })} />
                    </div>
                    {viewVer ? (
                      <div className="rounded-lg border border-accent p-3">
                        <div className="mb-2 flex items-center justify-between text-sm">
                          <span>历史版本 v{viewVer.version_no}（{viewVer.create_time}，{viewVer.note_desc}）</span>
                          <Button size="sm" variant="tertiary" onPress={() => setViewVer(null)}>收起</Button>
                        </div>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{viewVer.system_prompt_text}</pre>
                        <hr className="my-2 border-border" />
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{viewVer.user_prompt_text}</pre>
                      </div>
                    ) : null}
                  </div>
                  <aside className="space-y-4 text-xs">
                    <div>
                      <div className="mb-1 font-medium">可用变量</div>
                      <div className="space-y-1">
                        {vars.map((v) => (
                          <div key={v.name}>
                            <span className="font-mono text-accent">{v.name.startsWith("（") ? v.name : `{{${v.name}}}`}</span>
                            <span className="ml-1 text-muted">{v.desc}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {versions.length ? (
                      <div>
                        <div className="mb-1 font-medium">历史版本</div>
                        <div className="space-y-1">
                          {versions.map((v) => (
                            <div key={v.version_id} className="rounded border border-border p-2">
                              <div className="flex items-center justify-between">
                                <span className="font-mono">v{v.version_no}</span>
                                <span className="flex gap-2">
                                  <button type="button" className="text-accent" onClick={() => setViewVer(v)}>查看</button>
                                  {v.version_no !== cur.version_no ? <button type="button" className="text-accent" onClick={() => restore(v.version_no)}>恢复</button> : null}
                                </span>
                              </div>
                              <div className="text-muted">{v.create_time} {v.user_name ?? "系统"}</div>
                              <div className="text-muted">{v.note_desc}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </aside>
                </Drawer.Body>
              ) : null}
              <Drawer.Footer>
                {!cur?.isNew ? (
                  <Button variant="ghost" isDisabled={cur?.task_qty > 0} onPress={() => window.confirm("删除该提示词及全部版本？") && run(() => api(`/api/gen/prompts/${cur.prompt_id}`, { method: "DELETE" }), "已删除").then(() => { drawer.close(); load(); })}>删除</Button>
                ) : null}
                <Button variant="tertiary" onPress={drawer.close}>取消</Button>
                <Button variant="primary" onPress={save}>保存</Button>
              </Drawer.Footer>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </div>
  );
}

/* ---------------------------------------------------------------- 业务字典 */

function Dicts() {
  const [rows, load] = useList("/api/gen/dicts", "dicts");
  const drawer = useOverlayState();
  const [cur, setCur] = useState<any>(null);
  const [value, setValue] = useState<Json>([]);

  const open = (d?: any) => {
    setCur(d ? { ...d } : { dict_code: "", dict_name: "", isNew: true });
    setValue(d ? d.value : []);
    drawer.open();
  };
  const save = async () => {
    const body = { dict_code: cur.dict_code, dict_name: cur.dict_name, value_json: JSON.stringify(value) };
    const ok = await run(() => (cur.isNew ? api("/api/gen/dicts", { method: "POST", json: body }) : api(`/api/gen/dicts/${cur.dict_code}`, { method: "PATCH", json: body })), "已保存");
    if (ok) {
      drawer.close();
      load();
    }
  };
  const size = (v: any) => (Array.isArray(v) ? `${v.length} 项` : v && typeof v === "object" ? `${Object.keys(v).length} 组` : "—");

  return (
    <div>
      <div className="mb-3 flex justify-between gap-2">
        <p className="text-sm text-muted">字典是生成的“业务知识”：维度轮转从字典取值，提示词以 {"{{dict_编码}}"} 引用整张字典（列表会渲染为“- 值 | 值”多行文本）。</p>
        <Button variant="primary" onPress={() => open()}>新建字典</Button>
      </div>
      <ListTable
        rows={(rows ?? []).map((d: any, i: number) => ({ ...d, _i: i + 1 }))}
        idKey="_i"
        pageSize={12}
        onRowAction={open}
        emptyText={rows ? "暂无字典" : "加载中…"}
        columns={[
          { id: "dict_code", name: "编码", render: (d) => <span className="font-mono text-xs">{d.dict_code}</span> },
          { id: "dict_name", name: "名称" },
          { id: "size", name: "条目", render: (d) => size(d.value) },
          { id: "ref", name: "提示词引用", render: (d) => <span className="font-mono text-xs">{`{{dict_${d.dict_code}}}`}</span> },
          { id: "update_time", name: "更新时间" },
          { id: "_op", name: "操作", render: (d) => <Button size="sm" variant="secondary" onPress={() => open(d)}>编辑</Button> },
        ]}
      />
      <Drawer state={drawer}>
        <Drawer.Backdrop>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="h-full w-[95vw]! max-w-[900px]! sm:w-[900px]!">
              <Drawer.CloseTrigger />
              <Drawer.Header><Drawer.Heading>{cur?.isNew ? "新建字典" : `编辑字典 ${cur?.dict_code}`}</Drawer.Heading></Drawer.Header>
              {cur ? (
                <Drawer.Body className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    {cur.isNew ? <TF label="字典编码" v={cur.dict_code} on={(v) => setCur({ ...cur, dict_code: v })} /> : null}
                    <TF label="字典名称" v={cur.dict_name} on={(v) => setCur({ ...cur, dict_name: v })} />
                  </div>
                  <JsonEditor value={value} onChange={setValue} defaultDepth={2} />
                </Drawer.Body>
              ) : (
                <Drawer.Body><Spinner /></Drawer.Body>
              )}
              <Drawer.Footer>
                {!cur?.isNew ? (
                  <Button variant="ghost" onPress={() => window.confirm("删除该字典？") && run(() => api(`/api/gen/dicts/${cur.dict_code}`, { method: "DELETE" }), "已删除").then(() => { drawer.close(); load(); })}>删除</Button>
                ) : null}
                <Button variant="tertiary" onPress={drawer.close}>取消</Button>
                <Button variant="primary" onPress={save} isDisabled={!cur?.dict_name}>保存</Button>
              </Drawer.Footer>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </div>
  );
}

