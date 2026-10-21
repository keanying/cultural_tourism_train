"use client";

import { Alert, Button, Chip, Spinner, Tabs, TextArea, toast } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/client";
import { LABEL_TAG, REVIEW_RESULT } from "@/lib/roles";
import { joinAssistant, pyDumps, splitAssistant, validateSft } from "@/lib/sft";
import { JsonEditor, type Json } from "./JsonEditor";
import { ChunkStatusChip, Progress, StandardView } from "./ui";

type Mode = "label" | "review";

const FILTERS: Record<Mode, { id: string; name: string }[]> = {
  label: [
    { id: "all", name: "全部" },
    { id: "unlabeled", name: "未标注" },
    { id: "labeled", name: "已标注" },
    { id: "fixed", name: "已修正" },
    { id: "dropped", name: "无效剔除" },
    { id: "unqualified", name: "审核不合格" },
    { id: "commented", name: "有意见" },
  ],
  review: [
    { id: "sampled", name: "抽检样本" },
    { id: "unreviewed", name: "抽检未审" },
    { id: "unqualified", name: "不合格" },
    { id: "all", name: "全部" },
    { id: "commented", name: "有意见" },
  ],
};
const PAGE = 50;

export function ChunkWorkspace({ chunkId, mode }: { chunkId: number; mode: Mode }) {
  const [info, setInfo] = useState<any>(null);
  const [filter, setFilter] = useState(mode === "review" ? "sampled" : "all");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ items: any[]; total: number }>({ items: [], total: 0 });
  const [cur, setCur] = useState<number | null>(null);
  const [comment, setComment] = useState("");

  const loadInfo = useCallback(() => {
    api(`/api/lbl/chunks/${chunkId}?mode=${mode}`).then(setInfo).catch((e) => toast.danger(e.message));
  }, [chunkId, mode]);
  const loadList = useCallback(
    (selectFirst = false) => {
      api(`/api/lbl/chunks/${chunkId}/items?mode=${mode}&filter=${filter}&page=${page}&pageSize=${PAGE}`)
        .then((j) => {
          setList(j);
          if (selectFirst || cur === null) setCur(j.items[0]?.item_id ?? null);
        })
        .catch((e) => toast.danger(e.message));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chunkId, mode, filter, page],
  );
  useEffect(loadInfo, [loadInfo]);
  useEffect(() => loadList(true), [loadList]);

  const chunkAct = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      await api(`/api/lbl/chunks/${chunkId}`, { method: "POST", json: { action, ...extra } });
      toast.success({ submit: "已提交审核", release: "已退回分块", review_pass: "审核通过", review_return: "已退回标注员返修", review_release: "已放回待审核" }[action] ?? "完成");
      location.href = mode === "label" ? "/label" : "/review";
    } catch (e: any) {
      toast.danger(e.message);
    }
  };
  const postComment = async (itemId: number | null) => {
    try {
      await api("/api/lbl/comments", { method: "POST", json: { chunk_id: chunkId, item_id: itemId, content: comment } });
      toast.success("意见已发布");
      setComment("");
      loadInfo();
      loadList();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  const idx = list.items.findIndex((x) => x.item_id === cur);
  const next = () => {
    if (idx >= 0 && idx < list.items.length - 1) setCur(list.items[idx + 1].item_id);
    else if (page * PAGE < list.total) setPage(page + 1);
    else toast.info("已是最后一条");
  };
  const onSaved = () => {
    loadInfo();
    api(`/api/lbl/chunks/${chunkId}/items?mode=${mode}&filter=${filter}&page=${page}&pageSize=${PAGE}`).then((j) => setList(j));
  };

  if (!info) {
    return (
      <div className="flex justify-center py-32">
        <Spinner />
      </div>
    );
  }
  const c = info.chunk;
  const s = info.stats;
  const canEdit: boolean = info.canEdit;
  return (
    <div className="flex h-[calc(100vh-53px)] flex-col">
      {/* 顶部：分块信息与分块级操作 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-3">
        <Link href={mode === "label" ? "/label" : "/review"} className="text-sm text-accent">
          ← 返回{mode === "label" ? "标注区" : "审核区"}
        </Link>
        <div className="flex items-center gap-2">
          <span className="font-medium">{info.requirement.requirement_name}</span>
          <span className="text-sm text-muted">第 {c.chunk_seq_no} 块 · {fmtNum(c.item_qty)} 条</span>
          <ChunkStatusChip status={c.chunk_status} />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          标注 <Progress value={s.labeled ?? 0} total={s.total} />
        </div>
        {s.sampled ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            抽检 <Progress value={s.reviewed ?? 0} total={s.sampled} />
            <span>
              合格率 {s.reviewed ? (((s.reviewed - (s.unqualified ?? 0)) / s.reviewed) * 100).toFixed(1) : "—"}%
            </span>
          </div>
        ) : null}
        <span className="text-xs text-muted">
          标注员 {c.annotator_name ?? "—"} · 审核员 {c.reviewer_name ?? "—"} · 退回 {c.return_qty} 次
        </span>
        <div className="ml-auto flex gap-2">
          {mode === "label" && canEdit ? (
            <>
              <Button size="sm" variant="tertiary" onPress={() => window.confirm("确认退回该分块？") && chunkAct("release")}>退回分块</Button>
              <Button size="sm" variant="primary" isDisabled={(s.labeled ?? 0) < s.total} onPress={() => chunkAct("submit")}>
                提交审核
              </Button>
            </>
          ) : null}
          {mode === "review" && canEdit ? (
            <>
              <Button size="sm" variant="tertiary" onPress={() => chunkAct("review_release")}>放回待审核</Button>
              <Button
                size="sm"
                variant="danger-soft"
                onPress={() => {
                  const reason = window.prompt("退回返修的审核意见（必填）", comment);
                  if (reason?.trim()) chunkAct("review_return", { comment: reason });
                }}
              >
                退回返修
              </Button>
              <Button size="sm" variant="primary" isDisabled={(s.reviewed ?? 0) < (s.sampled ?? 0)} onPress={() => chunkAct("review_pass", { comment })}>
                审核通过
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧：条目列表 */}
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border">
          <div className="flex flex-wrap gap-1 border-b border-border p-2">
            {FILTERS[mode].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setFilter(f.id);
                  setPage(1);
                }}
                className={`rounded-md px-2 py-0.5 text-xs ${filter === f.id ? "bg-accent text-accent-foreground" : "bg-surface-secondary hover:bg-surface-tertiary"}`}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.items.map((it) => (
              <button
                key={it.item_id}
                type="button"
                onClick={() => setCur(it.item_id)}
                className={`block w-full border-b border-border px-3 py-2 text-left text-xs ${it.item_id === cur ? "bg-accent-soft" : "hover:bg-surface-secondary"}`}
              >
                <div className="mb-1 flex items-center gap-1">
                  <span className="font-mono">#{it.item_seq_no}</span>
                  <TagChip tag={it.label_tag} />
                  {it.is_sampled ? <Chip size="sm" color="warning">抽检</Chip> : null}
                  {it.review_result ? <Chip size="sm" color={it.review_result === 1 ? "success" : "danger"}>{REVIEW_RESULT[it.review_result]}</Chip> : null}
                  {it.comment_qty ? <span className="text-danger">💬{it.comment_qty}</span> : null}
                </div>
                <div className="line-clamp-2 text-muted">{it.preview}</div>
              </button>
            ))}
            {!list.items.length ? <p className="p-4 text-center text-sm text-muted">没有条目</p> : null}
          </div>
          <div className="flex items-center justify-between border-t border-border p-2 text-xs">
            <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)} className="rounded px-2 py-1 hover:bg-surface-secondary disabled:opacity-40">
              上一页
            </button>
            <span className="text-muted">
              {list.total ? (page - 1) * PAGE + 1 : 0}–{Math.min(page * PAGE, list.total)} / {fmtNum(list.total)}
            </span>
            <button type="button" disabled={page * PAGE >= list.total} onClick={() => setPage(page + 1)} className="rounded px-2 py-1 hover:bg-surface-secondary disabled:opacity-40">
              下一页
            </button>
          </div>
        </aside>

        {/* 右侧：条目编辑 / 标注标准 / 分块意见 */}
        <section className="min-w-0 flex-1 overflow-y-auto p-4">
          <Tabs defaultSelectedKey="item">
            <Tabs.ListContainer>
              <Tabs.List aria-label="作业区">
                <Tabs.Tab id="item" className="whitespace-nowrap">{mode === "label" ? "标注" : "审核"}<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="standard" className="whitespace-nowrap">标注标准<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="comments" className="whitespace-nowrap">分块意见（{info.comments.length}）<Tabs.Indicator /></Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="item" className="pt-4">
              {info.comments.some((m: any) => !m.item_id && m.comment_content.startsWith("【退回返修】")) && mode === "label" ? (
                <Alert status="danger" className="mb-4">
                  <Alert.Content>
                    <Alert.Title>审核退回：{info.comments.find((m: any) => !m.item_id && m.comment_content.startsWith("【退回返修】")).comment_content}</Alert.Title>
                    <Alert.Description>可在左侧筛选“审核不合格”“有意见”的条目逐一修改后重新提交。</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
              {cur ? (
                <ItemPanel key={cur} itemId={cur} mode={mode} canEdit={canEdit} onSaved={onSaved} onNext={next} />
              ) : (
                <p className="py-20 text-center text-muted">请选择左侧条目</p>
              )}
            </Tabs.Panel>
            <Tabs.Panel id="standard" className="pt-4">
              {info.requirement.requirement_desc ? <p className="mb-3 text-sm">{info.requirement.requirement_desc}</p> : null}
              <StandardView text={info.requirement.standard_content} />
            </Tabs.Panel>
            <Tabs.Panel id="comments" className="space-y-3 pt-4">
              <div className="flex gap-2">
                <TextArea className="flex-1" rows={2} placeholder="针对整个分块的意见" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button variant="secondary" isDisabled={!comment.trim()} onPress={() => postComment(null)}>发表</Button>
              </div>
              <Comments list={info.comments} />
            </Tabs.Panel>
          </Tabs>
        </section>
      </div>
    </div>
  );
}

function TagChip({ tag }: { tag: number }) {
  const color = (["default", "success", "accent", "danger"] as const)[tag] ?? "default";
  return <Chip size="sm" color={color}>{LABEL_TAG[tag]}</Chip>;
}

function Comments({ list }: { list: any[] }) {
  if (!list.length) return <p className="text-sm text-muted">暂无意见</p>;
  return (
    <div className="space-y-2">
      {list.map((m) => (
        <div key={m.comment_id} className="rounded-lg border border-border p-3 text-sm">
          <div className="mb-1 text-xs text-muted">
            {m.user_name} · {m.create_time}
            {m.item_seq_no ? ` · 条目 #${m.item_seq_no}` : m.item_id === null ? " · 分块" : ""}
          </div>
          <div className="whitespace-pre-wrap">{m.comment_content}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- 单条编辑 */

function ItemPanel({ itemId, mode, canEdit, onSaved, onNext }: { itemId: number; mode: Mode; canEdit: boolean; onSaved: () => void; onNext: () => void }) {
  const [d, setD] = useState<any>(null);
  const [content, setContent] = useState<any>(null);
  const [showOrig, setShowOrig] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [usedAi, setUsedAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    api(`/api/lbl/items/${itemId}?mode=${mode}`)
      .then((j) => {
        setD(j);
        setContent(j.content);
      })
      .catch((e) => toast.danger(e.message));
  }, [itemId, mode]);
  useEffect(load, [load]);

  const isSft = d?.source.kind === "sft";
  const changed = useMemo(() => d && JSON.stringify(content) !== JSON.stringify(d.content), [content, d]);
  const diffOrig = useMemo(() => d && JSON.stringify(content) !== JSON.stringify(d.original), [content, d]);
  const errors = useMemo(() => (d && isSft && content ? validateSft(d.source.name, content.user, content.assistant) : []), [d, isSft, content]);

  const save = async (payload: Record<string, unknown>, goNext = true) => {
    setBusy(true);
    try {
      const j = await api(`/api/lbl/items/${itemId}`, { method: "PATCH", json: { mode, content, ai: usedAi, ...payload } });
      toast.success(mode === "label" ? `已保存：${LABEL_TAG[j.label_tag]}` : `审核：${REVIEW_RESULT[j.review_result]}`);
      onSaved();
      if (goNext) onNext();
      else load();
    } catch (e: any) {
      toast.danger(e.message);
    } finally {
      setBusy(false);
    }
  };
  const ai = async () => {
    setBusy(true);
    setAiNote(null);
    try {
      const j = await api(`/api/lbl/items/${itemId}/ai`, { method: "POST" });
      setContent(j.content);
      setUsedAi(true);
      setAiNote(`AI 再标完成：${j.reason || "无说明"}${j.errors.length ? `（注意：校验未通过 ${j.errors.join("；")}）` : ""}`);
    } catch (e: any) {
      toast.danger(e.message);
    } finally {
      setBusy(false);
    }
  };
  const comment = async () => {
    try {
      await api("/api/lbl/comments", { method: "POST", json: { chunk_id: d.item.chunk_id, item_id: itemId, content: note } });
      toast.success("意见已发布");
      setNote("");
      load();
      onSaved();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  if (!d || content === null) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  const it = d.item;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">条目 #{it.item_seq_no}</span>
        <span className="text-muted">
          {d.source.title} · row_id={it.source_row_id}
        </span>
        <TagChip tag={it.label_tag} />
        {it.label_source_type === 2 ? <Chip size="sm">AI 再标</Chip> : null}
        {it.is_sampled ? <Chip size="sm" color="warning">抽检</Chip> : null}
        {it.review_result ? <Chip size="sm" color={it.review_result === 1 ? "success" : "danger"}>{REVIEW_RESULT[it.review_result]}</Chip> : null}
        {diffOrig ? <Chip size="sm" color="accent">与原始内容不同</Chip> : null}
        <button type="button" className="ml-auto text-xs text-accent underline" onClick={() => setShowOrig(!showOrig)}>
          {showOrig ? "隐藏原始内容" : "对照原始内容"}
        </button>
      </div>

      {aiNote ? (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Title>{aiNote}</Alert.Title>
            <Alert.Description>AI 结果仅填入编辑区，确认无误后点击保存才会生效。</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {isSft ? (
        errors.length ? (
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
              <Alert.Title>校验通过</Alert.Title>
            </Alert.Content>
          </Alert>
        )
      ) : null}

      <div className={showOrig ? "grid grid-cols-1 gap-4 xl:grid-cols-2" : ""}>
        {showOrig ? (
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted">原始内容（规则引擎/AI 初标，只读）</h4>
            {isSft ? <SftView content={d.original} readOnly /> : <JsonEditor value={d.original} readOnly labels={d.source.labels} enums={d.source.enums} />}
          </div>
        ) : null}
        <div>
          {showOrig ? <h4 className="mb-2 text-sm font-medium">当前内容</h4> : null}
          {isSft ? (
            <SftView content={content} readOnly={!canEdit} onChange={setContent} />
          ) : (
            <JsonEditor value={content} onChange={canEdit ? setContent : undefined} readOnly={!canEdit} labels={d.source.labels} enums={d.source.enums} fixedKeys />
          )}
        </div>
      </div>

      {canEdit ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-background py-3">
          {mode === "label" ? (
            <>
              <Button variant="primary" isDisabled={busy || errors.length > 0} onPress={() => save({ label_tag: 1 })}>
                {diffOrig ? "保存修正并下一条" : "确认正确并下一条"}
              </Button>
              <Button variant="danger-soft" isDisabled={busy} onPress={() => save({ label_tag: 3 })}>标为无效剔除</Button>
            </>
          ) : (
            <>
              <Button variant="primary" isDisabled={busy || changed} onPress={() => save({ review_result: 1, content: undefined })}>合格</Button>
              <Button variant="danger-soft" isDisabled={busy || !changed || errors.length > 0} onPress={() => save({ review_result: 2 })}>
                不合格·保存修改
              </Button>
              <Button variant="secondary" isDisabled={busy} onPress={() => save({ review_result: 2, label_tag: 3, content: undefined })}>不合格·剔除</Button>
            </>
          )}
          <Button variant="secondary" isDisabled={busy} onPress={ai}>{busy ? "处理中…" : "AI 再标"}</Button>
          <Button variant="tertiary" isDisabled={busy || !diffOrig} onPress={() => { setContent(d.original); setUsedAi(false); }}>
            恢复原始内容
          </Button>
          <Button variant="tertiary" isDisabled={busy || !changed} onPress={() => { setContent(d.content); setUsedAi(false); }}>撤销本次修改</Button>
          <Button variant="tertiary" onPress={onNext}>跳过</Button>
        </div>
      ) : (
        <p className="text-sm text-muted">当前为只读查看（分块不在你的可编辑状态）。</p>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">条目意见</h4>
        <div className="flex gap-2">
          <TextArea className="flex-1" rows={2} placeholder={mode === "review" ? "针对这条数据的审核意见" : "回复或备注"} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="secondary" isDisabled={!note.trim()} onPress={comment}>发表</Button>
        </div>
        <Comments list={d.comments} />
      </div>
    </div>
  );
}

/** 训练样本：user（JSON 可视化）+ thought（文本）+ answer（JSON 可视化或文本）；system 只读折叠 */
function SftView({ content, readOnly, onChange }: { content: any; readOnly?: boolean; onChange?: (c: any) => void }) {
  const parts = splitAssistant(content.assistant) ?? { thought: "", answer: content.assistant };
  const userObj = useMemo(() => {
    try {
      return JSON.parse(content.user) as Json;
    } catch {
      return null;
    }
  }, [content.user]);
  const answerObj = useMemo(() => {
    try {
      const v = JSON.parse(parts.answer);
      return v && typeof v === "object" ? (v as Json) : null;
    } catch {
      return null;
    }
  }, [parts.answer]);
  const setAssistant = (thought: string, answer: string) => onChange?.({ ...content, assistant: joinAssistant(thought, answer) });
  return (
    <div className="space-y-4">
      <details className="rounded-lg border border-border p-2 text-xs">
        <summary className="cursor-pointer text-muted">System Prompt（决策规则，只读）</summary>
        <pre className="mt-2 whitespace-pre-wrap leading-relaxed">{content.system}</pre>
      </details>
      <div>
        <h5 className="mb-1 text-sm font-medium">用户输入 user</h5>
        {userObj !== null ? (
          <JsonEditor value={userObj} readOnly={readOnly} onChange={readOnly ? undefined : (v) => onChange?.({ ...content, user: pyDumps(v) })} defaultDepth={2} />
        ) : (
          <textarea className="w-full rounded-md border border-danger p-2 font-mono text-xs" rows={6} readOnly={readOnly} value={content.user} onChange={(e) => onChange?.({ ...content, user: e.target.value })} />
        )}
      </div>
      <div>
        <h5 className="mb-1 text-sm font-medium">思维链 &lt;thought&gt;</h5>
        <textarea
          className="w-full rounded-md border border-field-border bg-field p-2 font-mono text-xs leading-relaxed"
          rows={Math.min(24, parts.thought.split("\n").length + 2)}
          readOnly={readOnly}
          value={parts.thought}
          onChange={(e) => setAssistant(e.target.value, parts.answer)}
        />
      </div>
      <div>
        <h5 className="mb-1 text-sm font-medium">最终回答 &lt;answer&gt;</h5>
        {answerObj !== null ? (
          <JsonEditor value={answerObj} readOnly={readOnly} onChange={readOnly ? undefined : (v) => setAssistant(parts.thought, pyDumps(v))} />
        ) : (
          <textarea
            className="w-full rounded-md border border-field-border bg-field p-2 text-sm leading-relaxed"
            rows={5}
            readOnly={readOnly}
            value={parts.answer}
            onChange={(e) => setAssistant(parts.thought, e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
