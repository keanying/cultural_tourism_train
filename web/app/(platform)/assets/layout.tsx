"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/assets", name: "资产总览", exact: true },
  { href: "/assets/data", name: "蒸馏数据" },
  { href: "/assets/tasks", name: "AI 生成任务" },
  { href: "/assets/config", name: "生成配置" },
];

/** 数据资产：蒸馏数据（规则引擎蒸馏）+ AI 生成（原 Lumos）两类资产，均可作为标注需求的数据源 */
export default function AssetsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <div className="flex gap-1 overflow-x-auto border-b border-border bg-surface px-4">
        {TABS.map((t) => {
          const on = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${on ? "border-accent font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
            >
              {t.name}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
