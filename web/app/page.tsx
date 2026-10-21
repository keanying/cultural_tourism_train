"use client";

import { Spinner } from "@heroui/react";
import { useEffect } from "react";
import { api } from "@/lib/client";
import { AREAS, canAccess, type Role } from "@/lib/roles";

/** 首页：按角色跳转到第一个可用功能区 */
export default function Home() {
  useEffect(() => {
    api<{ user: { role_type: Role } }>("/api/auth/me")
      .then(({ user }) => {
        const a = AREAS.find((x) => canAccess(user.role_type, x.id));
        location.replace(a?.href ?? "/login");
      })
      .catch(() => {});
  }, []);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}
