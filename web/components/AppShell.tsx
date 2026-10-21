"use client";

import { Button, Chip, Input, Label, Modal, Spinner, TextField, toast, useOverlayState } from "@heroui/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { AREAS, canAccess, ROLE_LABEL, type Area, type Role } from "@/lib/roles";

export type Me = { user_id: number; login_name: string; display_name: string; role_type: Role };

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;

export function AppShell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    api<{ user: Me }>("/api/auth/me").then((j) => setMe(j.user)).catch(() => {});
  }, []);

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const areas = AREAS.filter((a) => canAccess(me.role_type, a.id));
  const current = AREAS.find((a) => pathname.startsWith(a.href));
  const allowed = !current || canAccess(me.role_type, current.id);

  return (
    <MeContext value={me}>
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center gap-4 border-b border-border bg-surface px-4 py-2">
          <Link href="/" className="text-base font-semibold">
            文旅数据标注平台
          </Link>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {areas.map((a) => (
              <Link
                key={a.id}
                href={a.href}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  pathname.startsWith(a.href) ? "bg-accent text-accent-foreground" : "hover:bg-surface-secondary"
                }`}
              >
                {a.name}
              </Link>
            ))}
          </nav>
          <UserMenu me={me} />
        </header>
        <main className="min-w-0 flex-1">
          {allowed ? children : <div className="p-10 text-center text-muted">当前角色（{ROLE_LABEL[me.role_type]}）无权访问「{current?.name}」</div>}
        </main>
      </div>
    </MeContext>
  );
}

function UserMenu({ me }: { me: Me }) {
  const state = useOverlayState();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  };
  const change = async () => {
    try {
      await api("/api/auth/password", { method: "POST", json: { old_password: oldPw, new_password: newPw } });
      toast.success("密码已修改");
      state.close();
      setOldPw("");
      setNewPw("");
    } catch (e: any) {
      toast.danger(e.message);
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-sm">{me.display_name}</span>
      <Chip size="sm" color="accent">{ROLE_LABEL[me.role_type]}</Chip>
      <Modal state={state}>
        <Button size="sm" variant="tertiary">修改密码</Button>
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>修改密码</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <TextField value={oldPw} onChange={setOldPw} type="password">
                  <Label>原密码</Label>
                  <Input />
                </TextField>
                <TextField value={newPw} onChange={setNewPw} type="password">
                  <Label>新密码（至少 8 位）</Label>
                  <Input />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" onPress={state.close}>取消</Button>
                <Button variant="primary" onPress={change} isDisabled={!oldPw || newPw.length < 8}>确认修改</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Button size="sm" variant="secondary" onPress={logout}>退出</Button>
    </div>
  );
}

export function firstArea(role: Role): Area | undefined {
  return AREAS.find((a) => canAccess(role, a.id))?.id;
}
