// 角色与功能区权限（前后端共用）

export const ROLES = ["superadmin", "admin", "requester", "annotator", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  superadmin: "超级管理员",
  admin: "管理员",
  requester: "需求员",
  annotator: "标注员",
  reviewer: "审核员",
};

export type Area = "requirement" | "project" | "label" | "review" | "delivery" | "data" | "users";

export const AREAS: { id: Area; name: string; href: string; desc: string }[] = [
  { id: "project", name: "项目区", href: "/projects", desc: "创建项目，查看项目与需求进度" },
  { id: "requirement", name: "需求区", href: "/requirements", desc: "发布标注需求与标注标准，管理员接收并下发" },
  { id: "label", name: "标注区", href: "/label", desc: "认领分块并逐条标注" },
  { id: "review", name: "审核区", href: "/review", desc: "抽检标注完成的分块，通过或退回" },
  { id: "delivery", name: "交付区", href: "/delivery", desc: "交付、确认并下载标注结果" },
  { id: "data", name: "数据管理", href: "/data", desc: "原始数据查看、在线修改与导出" },
  { id: "users", name: "用户管理", href: "/users", desc: "账号与角色管理" },
];

export const AREA_ROLES: Record<Area, Role[]> = {
  project: ["superadmin", "admin", "requester"],
  requirement: ["superadmin", "admin", "requester"],
  label: ["superadmin", "admin", "annotator"],
  review: ["superadmin", "admin", "reviewer"],
  delivery: ["superadmin", "admin", "requester"],
  data: ["superadmin", "requester"], // 原数据管理功能仅需求员和超级管理员可见
  users: ["superadmin"],
};

export function canAccess(role: Role | undefined, area: Area) {
  return !!role && AREA_ROLES[area].includes(role);
}

/** 业务动作权限 */
export const ACTION_ROLES = {
  createProject: ["superadmin", "requester"],
  publishRequirement: ["superadmin", "requester"],
  receiveRequirement: ["superadmin", "admin"],
  dispatchRequirement: ["superadmin", "admin"],
  deliver: ["superadmin", "admin"],
  confirmDelivery: ["superadmin", "requester"],
  claimChunk: ["superadmin", "annotator"],
  reviewChunk: ["superadmin", "reviewer"],
} satisfies Record<string, Role[]>;

export type Action = keyof typeof ACTION_ROLES;
export const can = (role: Role | undefined, a: Action) => !!role && (ACTION_ROLES[a] as Role[]).includes(role);

// ---------------------------------------------------------------- 状态编码
export const REQ_STATUS: Record<number, { name: string; color: "default" | "accent" | "success" | "warning" | "danger" }> = {
  1: { name: "已发布·待接收", color: "warning" },
  2: { name: "已接收·待下发", color: "accent" },
  3: { name: "标注审核中", color: "accent" },
  5: { name: "已交付·待确认", color: "success" },
  6: { name: "已确认完成", color: "success" },
  9: { name: "已驳回", color: "danger" },
};

export const CHUNK_STATUS: Record<number, { name: string; color: "default" | "accent" | "success" | "warning" | "danger" }> = {
  1: { name: "待认领", color: "default" },
  2: { name: "标注中", color: "accent" },
  3: { name: "待审核", color: "warning" },
  4: { name: "审核中", color: "accent" },
  5: { name: "审核通过", color: "success" },
  6: { name: "审核退回·待返修", color: "danger" },
};

export const LABEL_TAG: Record<number, string> = { 0: "未标注", 1: "正确", 2: "已修正", 3: "无效剔除" };
export const REVIEW_RESULT: Record<number, string> = { 0: "未审", 1: "合格", 2: "不合格·已修改" };
