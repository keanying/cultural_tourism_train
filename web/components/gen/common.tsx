"use client";

import { Chip } from "@heroui/react";
import { GEN_ASSET_STATUS, GEN_KIND, GEN_TASK_STATUS } from "@/lib/roles";

type Tone = "default" | "accent" | "success" | "warning" | "danger";

export function GenTaskChip({ status }: { status: number }) {
  const s = GEN_TASK_STATUS[status] ?? { name: String(status), color: "default" as Tone };
  return <Chip size="sm" color={s.color} className="whitespace-nowrap">{s.name}</Chip>;
}

export function GenAssetChip({ status }: { status: number }) {
  const s = GEN_ASSET_STATUS[status] ?? { name: String(status), color: "default" as Tone };
  return <Chip size="sm" color={s.color} className="whitespace-nowrap">{s.name}</Chip>;
}

export function KindChip({ kind }: { kind: string }) {
  return (
    <Chip size="sm" color={kind === "sft" ? "accent" : "default"} className="whitespace-nowrap">
      {GEN_KIND[kind] ?? kind}
    </Chip>
  );
}

const ROLE: Record<string, string> = { system: "system", user: "user", assistant: "assistant" };

/** 训练样本 messages 渲染（system 折叠） */
export function MessagesView({ messages }: { messages: { role: string; content: string }[] }) {
  return (
    <div className="space-y-2">
      {messages.map((m, i) =>
        m.role === "system" ? (
          <details key={i} className="rounded-md border border-border px-2 py-1 text-xs">
            <summary className="cursor-pointer text-muted">system（{m.content.length} 字）</summary>
            <pre className="mt-1 whitespace-pre-wrap leading-relaxed">{m.content}</pre>
          </details>
        ) : (
          <div key={i} className={`rounded-md px-3 py-2 text-xs ${m.role === "user" ? "bg-surface-secondary" : "border border-accent/40 bg-accent-soft/40"}`}>
            <div className="mb-1 font-mono text-[11px] text-muted">{ROLE[m.role] ?? m.role}</div>
            <pre className="whitespace-pre-wrap break-all font-sans leading-relaxed">{m.content}</pre>
          </div>
        ),
      )}
    </div>
  );
}

/** 会话轮次（明细）：按规格的 turn_view 字段渲染为气泡，未配置时显示全部文本字段 */
export function TurnsView({ payload, cfg }: { payload: any; cfg: any }) {
  type F = { key: string; label?: string; role?: string };
  const view: F[] = cfg?.turn_view ?? [];
  return (
    <div className="space-y-2">
      {(payload?.turns ?? []).map((t: any, i: number) => {
        const fields: F[] = view.length ? view : Object.keys(t).filter((k) => typeof t[k] === "string").map((k) => ({ key: k }));
        return (
          <div key={i} className="rounded-md border border-border p-2 text-xs">
            <div className="mb-1 text-[11px] text-muted">第 {i + 1} 轮</div>
            {fields.map((f) => {
              const v = t[f.key];
              const s = Array.isArray(v) ? v.join("\n") : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? "");
              return (
                <div key={f.key} className={`mb-1 rounded px-2 py-1 ${f.role === "user" ? "bg-surface-secondary" : f.role === "assistant" ? "bg-accent-soft/40" : ""}`}>
                  <span className="mr-1 text-muted">{f.label ?? f.key}：</span>
                  <span className="whitespace-pre-wrap">{s}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
