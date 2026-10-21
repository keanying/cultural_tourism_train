"use client";

import { Chip } from "@heroui/react";
import { useMemo } from "react";
import { JsonEditor, type Json } from "@/components/JsonEditor";
import { assembleConversation, truthy, type Dict } from "@/lib/tpl";
import { MessagesView, TurnsView } from "./common";

export type GenCtx = { kind: "detail" | "sft"; spec_name: string; cfg: Dict; dv: Dict; jobVars: Dict[]; convId: string };

/** 前端实时校验（与服务端 validateGenContent 规则一致，保存时服务端会再校验一次） */
export function genErrors(g: GenCtx, content: any, original: any): string[] {
  const conv = g.kind === "detail" ? content : content?.conversation;
  const orig = g.kind === "detail" ? original : original?.conversation;
  const errs: string[] = [];
  if (!conv || typeof conv !== "object" || Array.isArray(conv)) return ["会话内容必须是 JSON 对象"];
  if (conv.conversation_id !== orig?.conversation_id) errs.push(`conversation_id 不能修改（应为 ${orig?.conversation_id}）`);
  const turns = conv.turns;
  if (!Array.isArray(turns) || !turns.length || turns.some((t: unknown) => !t || typeof t !== "object" || Array.isArray(t))) return [...errs, "turns 必须是非空的对象数组"];
  if (g.kind === "detail") {
    for (const f of g.cfg.required ?? []) if (!truthy(conv[f])) errs.push(`${f} 不能为空`);
    return errs;
  }
  if (turns.length !== orig.turns.length) errs.push(`训练集会话的轮次数不能增减（应为 ${orig.turns.length} 轮）`);
  const labels = content.labels;
  if (!Array.isArray(labels) || labels.length !== original.labels.length) return [...errs, `labels 必须是 ${original.labels.length} 个对象（每轮一个）`];
  assembleConversation(g.cfg, conv, labels, g.jobVars, g.dv).forEach((s, i) => {
    if (!s.valid) errs.push(`第 ${i + 1} 轮：${s.reason}`);
  });
  return errs;
}

/**
 * AI 生成资产的条目编辑：
 *   明细：会话预览 + JSON 可视化编辑；
 *   训练集：逐轮编辑 AI 字段，实时按规格模板组装并预览最终训练样本（messages），会话问答也可修改，历史对话自动跟着更新。
 */
export function GenItemView({ g, content, readOnly, onChange, labels }: { g: GenCtx; content: any; readOnly?: boolean; onChange?: (c: any) => void; labels: Record<string, string> }) {
  const samples = useMemo(() => {
    if (g.kind !== "sft") return [];
    try {
      return assembleConversation(g.cfg, content.conversation, content.labels ?? [], g.jobVars, g.dv);
    } catch {
      return [];
    }
  }, [g, content]);

  if (g.kind === "detail") {
    return (
      <div className="space-y-4">
        <div>
          <h5 className="mb-1 text-sm font-medium">会话预览</h5>
          <TurnsView payload={content} cfg={g.cfg} />
        </div>
        <div>
          <h5 className="mb-1 text-sm font-medium">会话内容（{g.spec_name}）</h5>
          <JsonEditor value={content} readOnly={readOnly} onChange={readOnly ? undefined : onChange} labels={labels} defaultDepth={3} />
        </div>
      </div>
    );
  }
  const aiLabels: Record<string, string> = Object.fromEntries((g.cfg.ai_fields ?? []).map((f: Dict) => [f.key, f.label]));
  return (
    <div className="space-y-4">
      {(content.labels ?? []).map((fields: Json, i: number) => (
        <div key={i} className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-medium">第 {i + 1} 轮</span>
            <span className="font-mono text-xs text-muted">{samples[i]?.sample_id}</span>
            {samples[i] ? (samples[i].valid ? <Chip size="sm" color="success">样本校验通过</Chip> : <Chip size="sm" color="danger">{samples[i].reason}</Chip>) : null}
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <div>
              <h6 className="mb-1 text-xs text-muted">AI 字段（标注修改这里）</h6>
              <JsonEditor
                value={fields}
                readOnly={readOnly}
                labels={aiLabels}
                defaultDepth={3}
                onChange={readOnly ? undefined : (v) => onChange?.({ ...content, labels: content.labels.map((x: Json, j: number) => (j === i ? v : x)) })}
              />
            </div>
            <div>
              <h6 className="mb-1 text-xs text-muted">组装后的训练样本（实时预览）</h6>
              {samples[i] ? <MessagesView messages={samples[i].messages} /> : null}
            </div>
          </div>
        </div>
      ))}
      <details className="rounded-lg border border-border p-3" open={false}>
        <summary className="cursor-pointer text-sm font-medium">会话内容（可修改问答，样本与历史对话自动重建）</summary>
        <div className="mt-2">
          <JsonEditor
            value={content.conversation}
            readOnly={readOnly}
            labels={labels}
            defaultDepth={3}
            onChange={readOnly ? undefined : (v) => onChange?.({ ...content, conversation: v })}
          />
        </div>
      </details>
    </div>
  );
}
