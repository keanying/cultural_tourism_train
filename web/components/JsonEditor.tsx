"use client";

import { useEffect, useMemo, useState } from "react";
import { pyDumps } from "@/lib/sft";

/**
 * JSON 可视化编辑器：
 *  - 树形渲染对象/数组，可折叠、增删字段与元素
 *  - 基本类型就地编辑（字符串/数字/布尔/null），长文本自动多行
 *  - “JSON 字符串”字段（如训练样本的 user、answer）自动解析为嵌套树编辑，保存时按原风格序列化回字符串
 *  - 编码字段（enums）以下拉框显示“编码-含义”
 *  - 可切换“源码”模式直接编辑 JSON 文本（实时语法校验）
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type Props = {
  value: Json;
  onChange?: (v: Json) => void;
  readOnly?: boolean;
  labels?: Record<string, string>;
  enums?: Record<string, Record<string, string>>;
  /** 字符串内容为 JSON 时展开编辑（默认开启） */
  expandStringJson?: boolean;
  /** 顶层字段不允许增删（如明细数据的固定字段） */
  fixedKeys?: boolean;
  /** 默认展开层级 */
  defaultDepth?: number;
};

const fieldCls =
  "w-full rounded-md border border-field-border bg-field px-2 py-1 text-sm text-field-foreground outline-none focus:border-field-border-focus disabled:opacity-70";

export function JsonEditor({ value, onChange, readOnly, labels, enums, expandStringJson = true, fixedKeys, defaultDepth = 2 }: Props) {
  const [mode, setMode] = useState<"tree" | "source">("tree");
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "tree") setText(JSON.stringify(value, null, 2));
  }, [value, mode]);

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs">
        <span className="text-muted">{Array.isArray(value) ? `数组 · ${value.length} 项` : value && typeof value === "object" ? `对象 · ${Object.keys(value).length} 个字段` : typeof value}</span>
        <div className="flex gap-1">
          {(["tree", "source"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded px-2 py-0.5 ${mode === m ? "bg-accent text-accent-foreground" : "hover:bg-surface-secondary"}`}
            >
              {m === "tree" ? "可视化" : "源码"}
            </button>
          ))}
        </div>
      </div>
      {mode === "tree" ? (
        <div className="max-h-[60vh] overflow-auto p-2 font-mono text-xs">
          <Node
            k={null}
            value={value}
            depth={0}
            onChange={readOnly ? undefined : onChange}
            ctx={{ labels: labels ?? {}, enums: enums ?? {}, expandStringJson, fixedKeys: !!fixedKeys, defaultDepth }}
          />
        </div>
      ) : (
        <div className="p-2">
          <textarea
            className={`${fieldCls} min-h-[320px] font-mono text-xs`}
            value={text}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              try {
                const v = JSON.parse(e.target.value);
                setErr(null);
                onChange?.(v);
              } catch (x: any) {
                setErr(x.message);
              }
            }}
          />
          {err ? <p className="mt-1 text-xs text-danger">JSON 语法错误：{err}</p> : <p className="mt-1 text-xs text-success">JSON 语法正确</p>}
        </div>
      )}
    </div>
  );
}

type Ctx = {
  labels: Record<string, string>;
  enums: Record<string, Record<string, string>>;
  expandStringJson: boolean;
  fixedKeys: boolean;
  defaultDepth: number;
};

function parseJsonString(s: string): Json | undefined {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

function KeyLabel({ k, ctx }: { k: string | number | null; ctx: Ctx }) {
  if (k === null) return null;
  const label = typeof k === "string" ? ctx.labels[k] : undefined;
  return (
    <span className="mr-2 shrink-0 text-accent" title={label}>
      {typeof k === "number" ? `[${k}]` : k}
      {label ? <span className="ml-1 font-sans text-[11px] text-muted">{label.split("：")[0].replace(/（.*?）/g, "")}</span> : null}
    </span>
  );
}

function Node({ k, value, depth, onChange, ctx }: { k: string | number | null; value: Json; depth: number; onChange?: (v: Json) => void; ctx: Ctx }) {
  const [open, setOpen] = useState(depth < ctx.defaultDepth);
  const [asJson, setAsJson] = useState(true);
  const nested = useMemo(() => (typeof value === "string" && ctx.expandStringJson ? parseJsonString(value) : undefined), [value, ctx.expandStringJson]);

  // 对象 / 数组
  if (value && typeof value === "object") {
    const isArr = Array.isArray(value);
    const entries: [string | number, Json][] = isArr ? (value as Json[]).map((v, i) => [i, v]) : Object.entries(value);
    const set = (key: string | number, v: Json) => {
      if (!onChange) return;
      if (isArr) onChange((value as Json[]).map((x, i) => (i === key ? v : x)));
      else onChange({ ...(value as Record<string, Json>), [key]: v });
    };
    const remove = (key: string | number) => {
      if (!onChange) return;
      if (isArr) onChange((value as Json[]).filter((_, i) => i !== key));
      else {
        const { [key as string]: _, ...rest } = value as Record<string, Json>;
        onChange(rest);
      }
    };
    const canStructEdit = !!onChange && !(ctx.fixedKeys && depth === 0);
    const add = () => {
      if (!onChange) return;
      if (isArr) {
        const arr = value as Json[];
        const last = arr[arr.length - 1];
        onChange([...arr, last === undefined ? "" : structuredClone(last)]);
      } else {
        const name = window.prompt("新字段名");
        if (name && !(name in (value as object))) onChange({ ...(value as Record<string, Json>), [name]: "" });
      }
    };
    return (
      <div className={depth ? "ml-4 border-l border-border pl-2" : ""}>
        <div className="flex items-center gap-1 py-0.5">
          <button type="button" className="w-4 text-muted" onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"}
          </button>
          <KeyLabel k={k} ctx={ctx} />
          <span className="text-muted">
            {isArr ? `[ ${entries.length} 项 ]` : `{ ${entries.length} 个字段 }`}
          </span>
          {canStructEdit ? (
            <button type="button" className="ml-2 rounded px-1 text-accent hover:bg-accent-soft" onClick={add}>
              ＋{isArr ? "元素" : "字段"}
            </button>
          ) : null}
        </div>
        {open
          ? entries.map(([ck, cv]) => (
              <div key={String(ck)} className="group relative">
                <Node k={ck} value={cv} depth={depth + 1} onChange={onChange ? (v) => set(ck, v) : undefined} ctx={ctx} />
                {canStructEdit ? (
                  <button
                    type="button"
                    title="删除"
                    className="absolute right-0 top-0.5 hidden rounded px-1 text-danger hover:bg-danger-soft group-hover:block"
                    onClick={() => remove(ck)}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ))
          : null}
      </div>
    );
  }

  // JSON 字符串：展开为嵌套树，修改后按原数据风格序列化
  if (nested !== undefined && asJson) {
    return (
      <div className={depth ? "ml-4 pl-2" : ""}>
        <div className="flex items-center gap-1 py-0.5">
          <KeyLabel k={k} ctx={ctx} />
          <span className="rounded bg-warning-soft px-1 font-sans text-[11px] text-warning-soft-foreground">JSON 字符串</span>
          <button type="button" className="ml-1 font-sans text-[11px] text-muted underline" onClick={() => setAsJson(false)}>
            按文本编辑
          </button>
        </div>
        <Node k={null} value={nested} depth={depth + 1} onChange={onChange ? (v) => onChange(pyDumps(v)) : undefined} ctx={ctx} />
      </div>
    );
  }

  // 基本类型
  const enumMap = typeof k === "string" ? ctx.enums[k] : undefined;
  let editor;
  if (enumMap && (typeof value === "number" || value === null)) {
    editor = (
      <select
        className={fieldCls}
        disabled={!onChange}
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange?.(e.target.value === "" ? null : Number(e.target.value))}
      >
        <option value="">（空）</option>
        {Object.entries(enumMap).map(([code, name]) => (
          <option key={code} value={code}>
            {code}-{name}
          </option>
        ))}
      </select>
    );
  } else if (typeof value === "boolean") {
    editor = (
      <select className={fieldCls} disabled={!onChange} value={String(value)} onChange={(e) => onChange?.(e.target.value === "true")}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else if (typeof value === "number") {
    editor = <NumberInput value={value} onChange={onChange} />;
  } else if (value === null) {
    editor = (
      <span className="flex items-center gap-2">
        <span className="text-muted">null</span>
        {onChange ? (
          <>
            <button type="button" className="font-sans text-[11px] text-accent underline" onClick={() => onChange("")}>改为文本</button>
            <button type="button" className="font-sans text-[11px] text-accent underline" onClick={() => onChange(0)}>改为数字</button>
          </>
        ) : null}
      </span>
    );
  } else {
    const s = String(value);
    const long = s.length > 60 || s.includes("\n");
    editor = long ? (
      <textarea
        className={`${fieldCls} font-mono text-xs leading-relaxed`}
        rows={Math.min(18, Math.max(3, s.split("\n").length + Math.floor(s.length / 90)))}
        readOnly={!onChange}
        value={s}
        onChange={(e) => onChange?.(e.target.value)}
      />
    ) : (
      <input className={fieldCls} readOnly={!onChange} value={s} onChange={(e) => onChange?.(e.target.value)} />
    );
  }
  return (
    <div className={`flex items-start gap-1 py-0.5 ${depth ? "ml-4 pl-2" : ""}`}>
      <KeyLabel k={k} ctx={ctx} />
      <div className="min-w-0 flex-1">
        {editor}
        {nested !== undefined && !asJson ? (
          <button type="button" className="font-sans text-[11px] text-muted underline" onClick={() => setAsJson(true)}>
            按 JSON 展开
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NumberInput({ value, onChange }: { value: number; onChange?: (v: Json) => void }) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  return (
    <input
      className={fieldCls}
      inputMode="decimal"
      readOnly={!onChange}
      value={t}
      onChange={(e) => {
        setT(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange?.(n);
      }}
    />
  );
}
