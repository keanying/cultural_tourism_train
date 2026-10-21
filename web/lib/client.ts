"use client";

/** 前端请求工具：统一错误处理；401 跳转登录页 */
export async function api<T = any>(url: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts;
  const r = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!r.ok) throw new Error(j.error ?? `请求失败（${r.status}）`);
  return j as T;
}

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString("zh-CN");
