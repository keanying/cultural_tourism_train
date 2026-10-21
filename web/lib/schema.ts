import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { ensureGenSchema } from "./genSchema";
import { hashPassword } from "./password";

/**
 * 标注平台系统表（ads 应用层，命名遵循客户规范，字段带注释）。页面启动时 CREATE IF NOT EXISTS，
 * distill.build_db 重建数据时不会删除这些表。
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_sys_user_f (  -- 平台用户全量表
  user_id         INTEGER PRIMARY KEY,  -- 用户ID
  login_name      TEXT UNIQUE NOT NULL, -- 登录名
  display_name    TEXT NOT NULL,        -- 显示名称
  role_type       TEXT NOT NULL,        -- 角色：superadmin-超级管理员 admin-管理员 requester-需求员 annotator-标注员 reviewer-审核员
  password_hash   TEXT NOT NULL,        -- 密码哈希（scrypt）
  is_active       INTEGER NOT NULL DEFAULT 1, -- 是否启用：0-否 1-是
  create_time     TEXT,                 -- 创建时间
  last_login_time TEXT                  -- 最近登录时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_sys_session_f (  -- 登录会话全量表
  session_no  TEXT PRIMARY KEY, -- 会话编号（随机令牌）
  user_id     INTEGER NOT NULL, -- 用户ID
  create_time TEXT,             -- 创建时间
  expire_time TEXT              -- 过期时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_project_f (  -- 标注项目全量表
  project_id     INTEGER PRIMARY KEY, -- 项目ID
  project_name   TEXT NOT NULL,       -- 项目名称
  project_desc   TEXT,                -- 项目说明
  requester_id   INTEGER NOT NULL,    -- 创建人（需求员）用户ID
  project_status INTEGER NOT NULL DEFAULT 1, -- 项目状态：1-进行中 2-已归档
  create_time    TEXT                 -- 创建时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_requirement_f (  -- 标注需求全量表
  requirement_id     INTEGER PRIMARY KEY, -- 需求ID
  project_id         INTEGER NOT NULL,    -- 所属项目ID
  requirement_name   TEXT NOT NULL,       -- 需求名称
  requirement_desc   TEXT,                -- 需求说明
  source_config      TEXT NOT NULL,       -- 指定数据（JSON 数组：[{source_code 数据源编码, split_type 切分(训练集可选), max_qty 条数上限}]）
  standard_content   TEXT NOT NULL,       -- 标注标准（Markdown 文本）
  requester_id       INTEGER NOT NULL,    -- 发布人（需求员）用户ID
  admin_id           INTEGER,             -- 接收人（管理员）用户ID
  requirement_status INTEGER NOT NULL,    -- 需求状态：1-已发布待接收 2-已接收待下发 3-标注审核中 5-已交付待确认 6-已确认完成 9-已驳回
  item_qty           INTEGER DEFAULT 0,   -- 标注条数（下发后）
  chunk_qty          INTEGER DEFAULT 0,   -- 分块数（下发后，5000 条/块）
  reject_reason_desc TEXT,                -- 驳回原因
  create_time        TEXT,                -- 发布时间
  receive_time       TEXT,                -- 接收时间
  dispatch_time      TEXT,                -- 下发时间
  deliver_time       TEXT,                -- 交付时间
  confirm_time       TEXT                 -- 需求员确认时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_chunk_f (  -- 标注分块全量表
  chunk_id          INTEGER PRIMARY KEY, -- 分块ID
  requirement_id    INTEGER NOT NULL,    -- 需求ID
  chunk_seq_no      INTEGER NOT NULL,    -- 需求内分块序号
  item_qty          INTEGER NOT NULL,    -- 分块条数
  chunk_status      INTEGER NOT NULL,    -- 分块状态：1-待认领 2-标注中 3-待审核 4-审核中 5-审核通过 6-审核退回待返修
  annotator_id      INTEGER,             -- 认领的标注员用户ID
  reviewer_id       INTEGER,             -- 审核员用户ID
  claim_time        TEXT,                -- 认领时间
  submit_time       TEXT,                -- 提交审核时间
  review_start_time TEXT,                -- 开始审核时间
  review_end_time   TEXT,                -- 审核完成时间
  return_qty        INTEGER DEFAULT 0,   -- 被审核退回次数
  sample_qty        INTEGER DEFAULT 0    -- 本轮抽检条数
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_item_f (  -- 标注条目全量表（引用源数据行，修改后的内容存 label_content）
  item_id           INTEGER PRIMARY KEY, -- 条目ID
  requirement_id    INTEGER NOT NULL,    -- 需求ID
  chunk_id          INTEGER NOT NULL,    -- 分块ID
  item_seq_no       INTEGER NOT NULL,    -- 分块内序号（从 1 开始）
  source_code       TEXT NOT NULL,       -- 数据源编码
  source_row_id     INTEGER NOT NULL,    -- 源数据行号 row_id
  label_content     TEXT,                -- 标注后内容（JSON；空=未修改，沿用源数据）
  label_tag         INTEGER NOT NULL DEFAULT 0, -- 标注结论：0-未标注 1-正确 2-已修正 3-无效剔除
  label_source_type INTEGER NOT NULL DEFAULT 0, -- 标注来源：0-无 1-人工 2-AI再标后人工确认
  annotator_id      INTEGER,             -- 标注员用户ID
  label_time        TEXT,                -- 标注时间
  is_sampled        INTEGER NOT NULL DEFAULT 0, -- 是否被本轮抽检：0-否 1-是
  review_result     INTEGER NOT NULL DEFAULT 0, -- 审核结论：0-未审 1-合格 2-不合格已修改
  reviewer_id       INTEGER,             -- 审核员用户ID
  review_time       TEXT                 -- 审核时间
)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_lbl_item_chunk ON ads_llm_lbl_item_f(chunk_id, item_seq_no)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_lbl_item_req ON ads_llm_lbl_item_f(requirement_id)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_lbl_chunk_req ON ads_llm_lbl_chunk_f(requirement_id, chunk_seq_no)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_comment_f (  -- 审核意见全量表（分块级或条目级）
  comment_id      INTEGER PRIMARY KEY, -- 意见ID
  chunk_id        INTEGER NOT NULL,    -- 分块ID
  item_id         INTEGER,             -- 条目ID（空=针对整个分块）
  user_id         INTEGER NOT NULL,    -- 提出人用户ID
  comment_content TEXT NOT NULL,       -- 意见内容
  create_time     TEXT                 -- 创建时间
)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_lbl_comment ON ads_llm_lbl_comment_f(chunk_id, item_id)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_delivery_f (  -- 交付记录全量表
  delivery_id     INTEGER PRIMARY KEY, -- 交付ID
  requirement_id  INTEGER NOT NULL,    -- 需求ID
  deliver_user_id INTEGER NOT NULL,    -- 交付人用户ID
  deliver_time    TEXT,                -- 交付时间
  item_qty        INTEGER,             -- 交付条数（含剔除）
  valid_item_qty  INTEGER,             -- 有效条数（不含无效剔除）
  delivery_note   TEXT,                -- 交付说明
  confirm_user_id INTEGER,             -- 确认人用户ID
  confirm_time    TEXT                 -- 确认时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_lbl_action_log_f (  -- 标注平台操作日志全量表
  log_id      INTEGER PRIMARY KEY, -- 日志ID
  user_id     INTEGER,             -- 操作人用户ID
  action_code TEXT,                -- 操作编码（如 chunk.claim、item.label、requirement.dispatch）
  target_type TEXT,                -- 对象类型：project/requirement/chunk/item/delivery/user
  target_id   INTEGER,             -- 对象ID
  detail_desc TEXT,                -- 操作说明
  create_time TEXT                 -- 操作时间
)`,
];

export const DEFAULT_PASSWORD = process.env.CT_DEFAULT_PASSWORD ?? "Ct@123456";

const SEED_USERS: [string, string, string][] = [
  ["superadmin", "超级管理员", "superadmin"],
  ["admin", "管理员", "admin"],
  ["requester", "需求员", "requester"],
  ["annotator1", "标注员1", "annotator"],
  ["annotator2", "标注员2", "annotator"],
  ["reviewer", "审核员", "reviewer"],
];

export function ensurePlatformSchema(db: DatabaseSync, now: string) {
  for (const sql of DDL) db.exec(sql);
  ensureGenSchema(db, now);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM ads.ads_llm_sys_user_f").get() as any).n;
  if (n === 0) {
    const ins = db.prepare(
      "INSERT INTO ads.ads_llm_sys_user_f (login_name, display_name, role_type, password_hash, create_time) VALUES (?,?,?,?,?)",
    );
    for (const [login, name, role] of SEED_USERS) ins.run(login, name, role, hashPassword(DEFAULT_PASSWORD), now);
  }
}
