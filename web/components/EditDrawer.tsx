"use client";

import { Alert, Button, Chip, Drawer, Label, Spinner, Tabs, TextArea, TextField, Input, toast, useOverlayState } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { joinAssistant, prettyJson, pyDumps, splitAssistant, validateSft } from "@/lib/sft";
import { SPLIT_LABEL, type SourceInfo } from "@/lib/types";

type Log = { ts: string; field: string; old_value: string | null; new_value: string | null };

type Props = {
  source: SourceInfo;
  rowId: number | null;
  onClose: () => void;
  onSaved: () => void;
};

export function EditDrawer({ source, rowId, onClose, onSaved }: Props) {
  const state = useOverlayState({ isOpen: rowId !== null, onOpenChange: (o) => !o && onClose() });
  const [row, setRow] = useState<Record<string, any> | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (rowId === null) return;
    setRow(null);
    setError(null);
    fetch(`/api/row?source=${source.name}&id=${rowId}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setRow(j.row);
        setLogs(j.logs);
      })
      .catch((e) => setError(e.message));
  }, [rowId, source.name, reloadKey]);

  const title = source.kind === "sft" ? `训练样本 ${row?.sid ?? ""}` : `${source.title} · 第 ${rowId} 行`;

  return (
    <Drawer state={state}>
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="h-full w-[95vw]! max-w-[960px]! sm:w-[960px]!">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="flex items-center gap-2">
                {title}
                {row?._edited ? <Chip size="sm" color="accent">已修改</Chip> : null}
                {row?.split ? <Chip size="sm">{SPLIT_LABEL[row.split] ?? row.split}</Chip> : null}
              </Drawer.Heading>
            </Drawer.Header>
            {error ? (
              <Drawer.Body>
                <Alert status="danger">
                  <Alert.Content>
                    <Alert.Title>加载失败</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              </Drawer.Body>
            ) : !row ? (
              <Drawer.Body className="flex justify-center py-20">
                <Spinner />
              </Drawer.Body>
            ) : source.kind === "sft" ? (
              <SftForm key={`${row._id}-${reloadKey}`} source={source} row={row} logs={logs} onSaved={() => { setReloadKey((k) => k + 1); onSaved(); }} onCancel={() => state.close()} />
            ) : (
              <DatasetForm key={`${row._id}-${reloadKey}`} source={source} row={row} logs={logs} onSaved={() => { setReloadKey((k) => k + 1); onSaved(); }} onCancel={() => state.close()} />
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

async function save(body: unknown): Promise<number> {
  const r = await fetch("/api/row", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.changed as number;
}

/* ------------------------------ 明细数据集：逐字段表单 ------------------------------ */

function DatasetForm({ source, row, logs, onSaved, onCancel }: { source: SourceInfo; row: Record<string, any>; logs: Log[]; onSaved: () => void; onCancel: () => void }) {
  const initial = useMemo(() => Object.fromEntries(source.columns.map((c) => [c, row[c] === null || row[c] === undefined ? "" : String(row[c])])), [row, source.columns]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = source.columns.filter((c) => values[c] !== initial[c]);

  const onSave = async () => {
    setSaving(true);
    try {
      const changed = await save({ source: source.name, id: row._id, values: Object.fromEntries(dirty.map((c) => [c, values[c]])) });
      toast.success(changed ? `已保存 ${changed} 个字段` : "没有需要保存的修改");
      onSaved();
    } catch (e: any) {
      toast.danger(`保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Drawer.Body className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {source.columns.map((c) => {
            const long = (values[c]?.length ?? 0) > 60 || ["purchase_notes", "cost_inclusion"].includes(c);
            return (
              <TextField key={c} value={values[c]} onChange={(v) => setValues((s) => ({ ...s, [c]: v }))} className={long ? "md:col-span-2" : ""}>
                <Label>
                  {source.labels[c] ?? c} <span className="font-mono text-xs text-muted">{c}</span>
                  {values[c] !== initial[c] ? <span className="ml-1 text-xs text-accent">●已改</span> : null}
                </Label>
                {long ? <TextArea rows={c === "purchase_notes" ? 8 : 3} /> : <Input />}
              </TextField>
            );
          })}
        </div>
        <EditLogs logs={logs} labels={source.labels} />
      </Drawer.Body>
      <Drawer.Footer>
        <span className="mr-auto text-sm text-muted">{dirty.length ? `${dirty.length} 个字段待保存` : "未修改"}</span>
        <Button variant="secondary" onPress={() => setValues(initial)} isDisabled={!dirty.length || saving}>
          撤销修改
        </Button>
        <Button variant="tertiary" onPress={onCancel}>
          关闭
        </Button>
        <Button variant="primary" onPress={onSave} isDisabled={!dirty.length || saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </Drawer.Footer>
    </>
  );
}

/* ------------------------------ 训练样本：分段编辑 + 实时校验 ------------------------------ */

function SftForm({ source, row, logs, onSaved, onCancel }: { source: SourceInfo; row: Record<string, any>; logs: Log[]; onSaved: () => void; onCancel: () => void }) {
  const jsonAnswer = source.name !== "combo_recommend";
  const init = useMemo(() => {
    const p = splitAssistant(row.assistant) ?? { thought: "", answer: row.assistant };
    return { user: prettyJson(row.user), thought: p.thought, answer: jsonAnswer ? prettyJson(p.answer) : p.answer };
  }, [row, jsonAnswer]);
  const [user, setUser] = useState(init.user);
  const [thought, setThought] = useState(init.thought);
  const [answer, setAnswer] = useState(init.answer);
  const [saving, setSaving] = useState(false);

  // answer 为 JSON 的任务：编辑时允许格式化显示，保存前压缩为单行（与原训练数据格式一致）
  const compactAnswer = useMemo(() => {
    if (!jsonAnswer) return answer.trim();
    try {
      return pyDumps(JSON.parse(answer));
    } catch {
      return answer.trim();
    }
  }, [answer, jsonAnswer]);
  const assistant = joinAssistant(thought, compactAnswer);
  const errors = useMemo(() => validateSft(source.name, user, assistant), [source.name, user, assistant]);
  const dirty = user !== init.user || thought !== init.thought || answer !== init.answer;
  const meta = useMemo(() => prettyJson(row.meta), [row.meta]);

  const onSave = async () => {
    setSaving(true);
    try {
      const changed = await save({ source: source.name, id: row._id, user, assistant });
      toast.success(changed ? "已保存，导出 JSONL 时将使用修改后的内容" : "内容与原样本一致，无需保存");
      onSaved();
    } catch (e: any) {
      toast.danger(`保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Drawer.Body>
        <Tabs defaultSelectedKey="edit">
          <Tabs.ListContainer>
            <Tabs.List aria-label="样本视图">
              <Tabs.Tab id="edit" className="whitespace-nowrap">编辑样本<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="system" className="whitespace-nowrap">System Prompt<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="meta" className="whitespace-nowrap">评测真值<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="logs" className="whitespace-nowrap">修改记录（{logs.length}）<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="edit" className="space-y-4 pt-4">
            {errors.length ? (
              <Alert status="danger">
                <Alert.Content>
                  <Alert.Title>格式/业务校验未通过（{errors.length} 项），修正后才能保存</Alert.Title>
                  <Alert.Description>
                    <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : (
              <Alert status="success">
                <Alert.Content>
                  <Alert.Title>校验通过：messages 结构、JSON 格式与业务约束均符合训练集规范</Alert.Title>
                </Alert.Content>
              </Alert>
            )}
            <TextField value={user} onChange={setUser}>
              <Label>用户输入 user（JSON，保存时自动压缩为单行）</Label>
              <TextArea rows={12} className="font-mono text-xs" />
            </TextField>
            <TextField value={thought} onChange={setThought}>
              <Label>思维链 &lt;thought&gt;</Label>
              <TextArea rows={14} className="font-mono text-xs" />
            </TextField>
            <TextField value={answer} onChange={setAnswer}>
              <Label>最终回答 &lt;answer&gt;{jsonAnswer ? "（JSON，保存时自动压缩为单行）" : "（推荐话术）"}</Label>
              <TextArea rows={jsonAnswer ? 14 : 5} className={jsonAnswer ? "font-mono text-xs" : ""} />
            </TextField>
          </Tabs.Panel>
          <Tabs.Panel id="system" className="pt-4">
            <p className="mb-2 text-sm text-muted">System Prompt 写有决策规则与系数表，同一任务所有样本共用，训练与推理时必须保持一致，因此此处只读。</p>
            <pre className="whitespace-pre-wrap rounded-lg bg-surface-secondary p-4 text-xs leading-relaxed">{row.system}</pre>
          </Tabs.Panel>
          <Tabs.Panel id="meta" className="pt-4">
            <p className="mb-2 text-sm text-muted">评测真值与溯源信息（只读），不进入训练文本，导出时可选择附带。</p>
            <pre className="whitespace-pre-wrap rounded-lg bg-surface-secondary p-4 font-mono text-xs">{meta}</pre>
          </Tabs.Panel>
          <Tabs.Panel id="logs" className="pt-4">
            <EditLogs logs={logs} labels={{ user: "用户输入", assistant: "回答" }} />
          </Tabs.Panel>
        </Tabs>
      </Drawer.Body>
      <Drawer.Footer>
        <span className="mr-auto text-sm text-muted">{dirty ? "有未保存的修改" : "未修改"}</span>
        <Button variant="secondary" isDisabled={!dirty || saving} onPress={() => { setUser(init.user); setThought(init.thought); setAnswer(init.answer); }}>
          撤销修改
        </Button>
        <Button variant="tertiary" onPress={onCancel}>
          关闭
        </Button>
        <Button variant="primary" isDisabled={!dirty || errors.length > 0 || saving} onPress={onSave}>
          {saving ? "保存中…" : "校验并保存"}
        </Button>
      </Drawer.Footer>
    </>
  );
}

function EditLogs({ logs, labels }: { logs: Log[]; labels: Record<string, string> }) {
  if (!logs.length) return <p className="text-sm text-muted">暂无修改记录</p>;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">修改记录</h4>
      {logs.map((l, i) => (
        <div key={i} className="rounded-lg border border-border p-3 text-xs">
          <div className="mb-1 text-muted">
            {l.ts} · {labels[l.field] ?? l.field}
          </div>
          <DiffLine oldValue={l.old_value} newValue={l.new_value} />
        </div>
      ))}
    </div>
  );
}

/** 只展示变化片段：公共前后缀之外的部分，前后各保留 30 字上下文 */
function DiffLine({ oldValue, newValue }: { oldValue: string | null; newValue: string | null }) {
  const o = oldValue ?? "";
  const n = newValue ?? "";
  let pre = 0;
  while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
  let suf = 0;
  while (suf < o.length - pre && suf < n.length - pre && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++;
  const ctx = 30;
  const head = (pre > ctx ? "…" : "") + o.slice(Math.max(0, pre - ctx), pre);
  const tailO = o.slice(o.length - suf, o.length - suf + ctx);
  const tail = tailO + (suf > ctx ? "…" : "");
  return (
    <div className="space-y-1 break-all font-mono">
      <div>
        <span className="text-muted">{head}</span>
        <span className="bg-danger/15 text-danger line-through">{oldValue === null ? "（空）" : o.slice(pre, o.length - suf)}</span>
        <span className="text-muted">{tail}</span>
      </div>
      <div>
        <span className="text-muted">{head}</span>
        <span className="bg-success/15 text-success">{newValue === null ? "（空）" : n.slice(pre, n.length - suf)}</span>
        <span className="text-muted">{tail}</span>
      </div>
    </div>
  );
}
