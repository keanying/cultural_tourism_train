"use client";

import { Button, Chip, Input, Label, Modal, TextField, toast, useOverlayState } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { ListTable, PageHeader } from "@/components/ui";
import { api } from "@/lib/client";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/roles";

const selCls = "rounded-md border border-field-border bg-field px-2 py-1 text-sm";

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const modal = useOverlayState();
  const [f, setF] = useState({ login_name: "", display_name: "", role_type: "annotator", password: "" });
  const load = useCallback(() => {
    api("/api/users").then((j) => setUsers(j.users)).catch((e) => toast.danger(e.message));
  }, []);
  useEffect(load, [load]);

  const patch = async (user_id: number, data: Record<string, unknown>, msg = "已更新") => {
    try {
      await api("/api/users", { method: "PATCH", json: { user_id, ...data } });
      toast.success(msg);
      load();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };
  const create = async () => {
    try {
      await api("/api/users", { method: "POST", json: f });
      toast.success("账号已创建");
      modal.close();
      setF({ login_name: "", display_name: "", role_type: "annotator", password: "" });
      load();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="用户管理"
        desc="创建账号、分配角色、启停账号与重置密码（仅超级管理员）"
        actions={
          <Modal state={modal}>
            <Button variant="primary">新建账号</Button>
            <Modal.Backdrop>
              <Modal.Container>
                <Modal.Dialog>
                  <Modal.Header>
                    <Modal.Heading>新建账号</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body className="space-y-3">
                    <TextField value={f.login_name} onChange={(v) => setF({ ...f, login_name: v })}>
                      <Label>登录名（字母/数字/下划线）</Label>
                      <Input />
                    </TextField>
                    <TextField value={f.display_name} onChange={(v) => setF({ ...f, display_name: v })}>
                      <Label>显示名称</Label>
                      <Input />
                    </TextField>
                    <div>
                      <div className="mb-1 text-sm">角色</div>
                      <select className={`${selCls} w-full`} value={f.role_type} onChange={(e) => setF({ ...f, role_type: e.target.value })}>
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </div>
                    <TextField value={f.password} onChange={(v) => setF({ ...f, password: v })} type="password">
                      <Label>初始密码（至少 8 位）</Label>
                      <Input />
                    </TextField>
                  </Modal.Body>
                  <Modal.Footer>
                    <Button variant="tertiary" onPress={modal.close}>取消</Button>
                    <Button variant="primary" onPress={create} isDisabled={!f.login_name || f.password.length < 8}>创建</Button>
                  </Modal.Footer>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          </Modal>
        }
      />
      <ListTable
        rows={users}
        idKey="user_id"
        pageSize={20}
        columns={[
          { id: "user_id", name: "ID" },
          { id: "login_name", name: "登录名" },
          { id: "display_name", name: "显示名称" },
          {
            id: "role_type",
            name: "角色",
            render: (u) => (
              <select className={selCls} value={u.role_type} onChange={(e) => patch(u.user_id, { role_type: e.target.value as Role }, "角色已修改")}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            ),
          },
          { id: "is_active", name: "状态", render: (u) => <Chip size="sm" color={u.is_active ? "success" : "danger"}>{u.is_active ? "启用" : "停用"}</Chip> },
          { id: "last_login_time", name: "最近登录", render: (u) => u.last_login_time ?? "—" },
          {
            id: "_op",
            name: "操作",
            render: (u) => (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onPress={() => patch(u.user_id, { is_active: u.is_active ? 0 : 1 })}>{u.is_active ? "停用" : "启用"}</Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() => {
                    const pw = window.prompt(`为 ${u.login_name} 设置新密码（至少 8 位）`);
                    if (pw) patch(u.user_id, { password: pw }, "密码已重置，该用户需重新登录");
                  }}
                >
                  重置密码
                </Button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
