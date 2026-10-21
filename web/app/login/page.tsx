"use client";

import { Alert, Button, Card, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";
import { api } from "@/lib/client";

export default function LoginPage() {
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      await api("/api/auth/login", { method: "POST", json: { login_name: loginName, password } });
      const next = new URLSearchParams(location.search).get("next");
      location.href = next && next.startsWith("/") && !next.startsWith("/login") ? next : "/";
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-secondary p-4">
      <Card className="w-full max-w-sm">
        <Card.Header>
          <Card.Title className="text-xl">文旅数据标注平台</Card.Title>
          <Card.Description>标注 · 审核 · 交付 · 数据管理</Card.Description>
        </Card.Header>
        <Card.Content>
          <form onSubmit={submit} className="space-y-4">
            {err ? (
              <Alert status="danger">
                <Alert.Content>
                  <Alert.Title>{err}</Alert.Title>
                </Alert.Content>
              </Alert>
            ) : null}
            <TextField value={loginName} onChange={setLoginName} autoFocus>
              <Label>账号</Label>
              <Input placeholder="登录名" autoComplete="username" />
            </TextField>
            <TextField value={password} onChange={setPassword} type="password">
              <Label>密码</Label>
              <Input placeholder="密码" autoComplete="current-password" />
            </TextField>
            <Button type="submit" variant="primary" fullWidth isDisabled={loading || !loginName || !password}>
              {loading ? "登录中…" : "登录"}
            </Button>
          </form>
        </Card.Content>
      </Card>
    </div>
  );
}
