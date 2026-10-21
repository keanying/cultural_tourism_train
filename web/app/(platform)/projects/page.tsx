"use client";

import { Button, Input, Label, Modal, TextArea, TextField, toast, useOverlayState } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/AppShell";
import { ListTable, PageHeader, Progress } from "@/components/ui";
import { api, fmtNum } from "@/lib/client";
import { can } from "@/lib/roles";

export default function ProjectsPage() {
  const me = useMe();
  const [projects, setProjects] = useState<any[]>([]);
  const modal = useOverlayState();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const load = useCallback(() => {
    api("/api/lbl/projects").then((j) => setProjects(j.projects)).catch((e) => toast.danger(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    try {
      await api("/api/lbl/projects", { method: "POST", json: { project_name: name, project_desc: desc } });
      toast.success("项目已创建");
      modal.close();
      setName("");
      setDesc("");
      load();
    } catch (e: any) {
      toast.danger(e.message);
    }
  };

  return (
    <div className="p-4 lg:p-8">
      <PageHeader
        title="项目区"
        desc={me.role_type === "requester" ? "创建项目，在项目下发布标注需求并跟踪进度" : "全部项目与需求完成情况"}
        actions={
          can(me.role_type, "createProject") ? (
            <Modal state={modal}>
              <Button variant="primary">新建项目</Button>
              <Modal.Backdrop>
                <Modal.Container>
                  <Modal.Dialog>
                    <Modal.Header>
                      <Modal.Heading>新建项目</Modal.Heading>
                    </Modal.Header>
                    <Modal.Body className="space-y-3">
                      <TextField value={name} onChange={setName}>
                        <Label>项目名称</Label>
                        <Input placeholder="如：文旅大模型训练数据二期" />
                      </TextField>
                      <TextField value={desc} onChange={setDesc}>
                        <Label>项目说明</Label>
                        <TextArea rows={3} />
                      </TextField>
                    </Modal.Body>
                    <Modal.Footer>
                      <Button variant="tertiary" onPress={modal.close}>取消</Button>
                      <Button variant="primary" onPress={create} isDisabled={!name.trim()}>创建</Button>
                    </Modal.Footer>
                  </Modal.Dialog>
                </Modal.Container>
              </Modal.Backdrop>
            </Modal>
          ) : null
        }
      />
      <ListTable
        rows={projects}
        idKey="project_id"
        emptyText="暂无项目"
        columns={[
          { id: "project_id", name: "编号", render: (p) => `#${p.project_id}` },
          { id: "project_name", name: "项目名称" },
          { id: "project_desc", name: "说明", render: (p) => <span className="line-clamp-2 block max-w-[320px]">{p.project_desc || "—"}</span> },
          { id: "requester_name", name: "需求员" },
          { id: "requirement_qty", name: "需求数" },
          { id: "done_qty", name: "已完成需求", render: (p) => <Progress value={p.done_qty} total={p.requirement_qty} /> },
          { id: "item_qty", name: "标注条数", render: (p) => fmtNum(p.item_qty) },
          { id: "create_time", name: "创建时间" },
          { id: "_op", name: "操作", render: (p) => <Link className="text-sm text-accent" href={`/requirements?project_id=${p.project_id}`}>查看需求</Link> },
        ]}
      />
    </div>
  );
}
