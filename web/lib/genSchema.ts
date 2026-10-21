import "server-only";
import type { DatabaseSync } from "node:sqlite";
import seed from "./gen_seed.json";

/**
 * 数据资产 · AI 生成（合并自 Lumos）的系统表，ads 应用层，命名遵循客户规范，字段带注释。
 * 业务语义全部在“数据规格”的 config_json 中定义，新增一类生成数据只需新增规格与提示词，不改代码。
 */
// 主键均为 AUTOINCREMENT：删除后不复用 ID（资产 ID 构成数据源编码 gen_asset_<ID>，任务 ID 被资产引用）
const DDL = [
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_model_f (  -- 生成模型配置全量表（OpenAI 兼容接口）
  model_id          INTEGER PRIMARY KEY AUTOINCREMENT, -- 模型配置ID
  model_name        TEXT NOT NULL,       -- 配置名称
  provider_name     TEXT,                -- 服务商名称（DeepSeek/OpenAI/火山方舟等）
  base_url          TEXT NOT NULL,       -- 接口地址（到 /v1 或 /api/v3 一级）
  api_key_value     TEXT,                -- API Key（页面只显示掩码）
  model_code        TEXT NOT NULL,       -- 模型编码或接入点ID
  api_style_type    TEXT NOT NULL DEFAULT 'auto', -- 接口协议：auto-自动探测 chat-对话接口 responses-Responses接口
  temperature_rate  REAL DEFAULT 0.8,    -- 采样温度
  top_p_rate        REAL DEFAULT 0.9,    -- 核采样 top_p
  max_token_qty     INTEGER DEFAULT 4096,-- 最大输出 token 数
  timeout_sec_qty   INTEGER DEFAULT 180, -- 单次调用超时秒数
  extra_body_json   TEXT DEFAULT '{}',   -- 额外请求参数（JSON，会合并进请求体）
  is_default        INTEGER DEFAULT 0,   -- 是否默认模型：0-否 1-是
  is_active         INTEGER DEFAULT 1,   -- 是否启用：0-否 1-是
  remark_desc       TEXT,                -- 备注
  create_time       TEXT,                -- 创建时间
  update_time       TEXT                 -- 更新时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_spec_f (  -- 数据规格全量表（一份产出的定义）
  spec_id          INTEGER PRIMARY KEY AUTOINCREMENT, -- 规格ID
  spec_code        TEXT UNIQUE NOT NULL,-- 规格编码
  spec_name        TEXT NOT NULL,       -- 规格名称
  spec_kind_type   TEXT NOT NULL,       -- 产出类型：detail-明细数据 sft-训练集
  task_type        TEXT NOT NULL,       -- 生产方式：detail_gen-明细生成 ai_label-AI预标注
  source_spec_code TEXT,                -- 来源规格编码（AI预标注时的明细规格）
  tag_json         TEXT DEFAULT '{}',   -- 资产标签（业务/任务/类型/领域）
  config_json      TEXT NOT NULL,       -- 规格配置（维度、校验、样本模板、展示字段等）
  remark_desc      TEXT,                -- 说明
  sort_no          INTEGER DEFAULT 100, -- 排序号
  is_active        INTEGER DEFAULT 1,   -- 是否启用：0-否 1-是
  create_time      TEXT,                -- 创建时间
  update_time      TEXT                 -- 更新时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_prompt_f (  -- 提示词全量表（当前版本）
  prompt_id          INTEGER PRIMARY KEY AUTOINCREMENT, -- 提示词ID
  prompt_code        TEXT UNIQUE NOT NULL,-- 提示词编码
  prompt_name        TEXT NOT NULL,       -- 提示词名称
  spec_code          TEXT NOT NULL,       -- 适用规格编码
  system_prompt_text TEXT NOT NULL,       -- 系统提示词
  user_prompt_text   TEXT NOT NULL,       -- 用户提示词（支持 {{变量}} 模板）
  version_no         INTEGER DEFAULT 1,   -- 当前版本号
  is_active          INTEGER DEFAULT 1,   -- 是否启用：0-否 1-是
  remark_desc        TEXT,                -- 说明
  update_time        TEXT                 -- 更新时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_prompt_version_f (  -- 提示词历史版本全量表（只读保留，任务固化版本号，数据可回溯到生成时的提示词）
  version_id         INTEGER PRIMARY KEY AUTOINCREMENT, -- 版本记录ID
  prompt_id          INTEGER NOT NULL,    -- 提示词ID
  version_no         INTEGER NOT NULL,    -- 版本号
  system_prompt_text TEXT NOT NULL,       -- 系统提示词
  user_prompt_text   TEXT NOT NULL,       -- 用户提示词
  note_desc          TEXT,                -- 修改说明
  user_id            INTEGER,             -- 修改人用户ID
  create_time        TEXT,                -- 创建时间
  UNIQUE (prompt_id, version_no)
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_dict_f (  -- 业务字典全量表（提示词以 {{dict_编码}} 引用，维度轮转取值来源）
  dict_code   TEXT PRIMARY KEY, -- 字典编码
  dict_name   TEXT NOT NULL,    -- 字典名称
  value_json  TEXT NOT NULL,    -- 字典内容（JSON）
  column_list TEXT,             -- 表格展示列（JSON 数组，可空）
  update_time TEXT              -- 更新时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_task_f (  -- 生成任务全量表
  task_id           INTEGER PRIMARY KEY AUTOINCREMENT, -- 任务ID
  task_no           TEXT UNIQUE NOT NULL,-- 任务编号
  task_name         TEXT NOT NULL,       -- 任务名称
  task_type         TEXT NOT NULL,       -- 生产方式：detail_gen-明细生成 ai_label-AI预标注
  spec_code         TEXT NOT NULL,       -- 数据规格编码
  source_asset_id   INTEGER DEFAULT 0,   -- 来源明细资产ID（AI预标注）
  model_id          INTEGER NOT NULL,    -- 模型配置ID
  prompt_id         INTEGER NOT NULL,    -- 提示词ID
  prompt_version_no INTEGER DEFAULT 1,   -- 执行时固化的提示词版本号
  target_qty        INTEGER NOT NULL,    -- 目标会话数
  batch_qty         INTEGER DEFAULT 5,   -- 每次调用生成的会话数（明细生成）
  concurrency_qty   INTEGER DEFAULT 3,   -- 并发调用数
  param_json        TEXT DEFAULT '{}',   -- 任务参数（variables 变量覆盖、filters 维度筛选、source_scope 来源范围）
  task_status       INTEGER NOT NULL DEFAULT 1, -- 任务状态：1-待执行 2-执行中 3-已完成 4-执行失败 5-已停止
  asset_id          INTEGER DEFAULT 0,   -- 产出资产ID
  done_unit_qty     INTEGER DEFAULT 0,   -- 已产出会话数
  done_pair_qty     INTEGER DEFAULT 0,   -- 已产出问答对/样本数
  dup_qty           INTEGER DEFAULT 0,   -- 去重丢弃数
  fail_qty          INTEGER DEFAULT 0,   -- 失败调用数
  call_qty          INTEGER DEFAULT 0,   -- 调用次数
  token_in_qty      INTEGER DEFAULT 0,   -- 输入 token 数
  token_out_qty     INTEGER DEFAULT 0,   -- 输出 token 数
  error_desc        TEXT,                -- 失败原因
  user_id           INTEGER,             -- 创建人用户ID
  start_time        TEXT,                -- 开始时间
  finish_time       TEXT,                -- 结束时间
  create_time       TEXT                 -- 创建时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_task_log_f (  -- 生成任务日志全量表
  log_id       INTEGER PRIMARY KEY AUTOINCREMENT, -- 日志ID
  task_id      INTEGER NOT NULL,    -- 任务ID
  level_type   TEXT,                -- 级别：info-信息 warn-警告 error-错误
  message_desc TEXT,                -- 日志内容
  create_time  TEXT                 -- 记录时间
)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_gen_task_log ON ads_llm_gen_task_log_f(task_id, log_id)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_asset_f (  -- 生成资产全量表（一次生成任务的产出，可作为标注需求的数据源）
  asset_id        INTEGER PRIMARY KEY AUTOINCREMENT, -- 资产ID
  asset_name      TEXT NOT NULL,       -- 资产名称
  asset_kind_type TEXT NOT NULL,       -- 资产类型：detail-明细数据 sft-训练集
  spec_code       TEXT NOT NULL,       -- 数据规格编码
  task_id         INTEGER DEFAULT 0,   -- 生成任务ID（0=历史导入）
  version_no      TEXT,                -- 版本号（同规格递增，如 v1.0）
  asset_status    INTEGER NOT NULL DEFAULT 1, -- 资产状态：1-生成中 2-已生成 3-生成失败
  tag_json        TEXT DEFAULT '{}',   -- 资产标签
  unit_qty        INTEGER DEFAULT 0,   -- 会话数
  pair_qty        INTEGER DEFAULT 0,   -- 问答对/样本数
  user_id         INTEGER,             -- 创建人用户ID
  create_time     TEXT,                -- 创建时间
  update_time     TEXT                 -- 更新时间
)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_conversation_f (  -- 生成会话全量表（统计、去重、标注的基本单位）
  conv_row_id            INTEGER PRIMARY KEY AUTOINCREMENT, -- 会话行ID（标注条目引用此ID）
  asset_id               INTEGER NOT NULL,    -- 资产ID
  conversation_id        TEXT NOT NULL,       -- 会话编号（资产内唯一，如 C00001）
  seq_no                 INTEGER NOT NULL,    -- 资产内序号
  turn_qty               INTEGER DEFAULT 1,   -- 轮次数
  payload_json           TEXT NOT NULL,       -- 会话内容（JSON，含 turns 轮次数组）
  dedup_key              TEXT,                -- 去重键（首轮内容归一化后的 MD5）
  source_conversation_id TEXT,                -- 来源会话编号（AI预标注时的明细会话）
  create_time            TEXT,                -- 创建时间
  UNIQUE (asset_id, conversation_id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ads.ux_gen_conv_dedup ON ads_llm_gen_conversation_f(asset_id, dedup_key)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_gen_conv_seq ON ads_llm_gen_conversation_f(asset_id, seq_no)`,
  `CREATE TABLE IF NOT EXISTS ads.ads_llm_gen_sample_f (  -- 生成样本全量表（训练集会话按轮次展开的样本，机器产出）
  sample_row_id       INTEGER PRIMARY KEY AUTOINCREMENT, -- 样本行ID
  asset_id            INTEGER NOT NULL,    -- 资产ID
  conversation_id     TEXT NOT NULL,       -- 会话编号
  turn_no             INTEGER NOT NULL,    -- 轮次（从 1 开始）
  sample_id           TEXT,                -- 样本编号
  content_json        TEXT NOT NULL,       -- 样本内容（JSON：sample_id/fields/messages）
  meta_json           TEXT DEFAULT '{}',   -- 样本元信息
  job_var_json        TEXT DEFAULT '{}',   -- 生成时的任务变量（重建样本时使用）
  is_valid            INTEGER DEFAULT 1,   -- 是否通过规格校验：0-否 1-是
  invalid_reason_desc TEXT,                -- 未通过原因
  create_time         TEXT                 -- 创建时间
)`,
  `CREATE INDEX IF NOT EXISTS ads.idx_gen_sample ON ads_llm_gen_sample_f(asset_id, conversation_id, turn_no)`,
];

type Seed = typeof seed;

/** 预置模型（API Key 为空，在“模型管理”中填写；设置了环境变量 LLM_API_KEY 时自动填入对应服务商） */
const MODELS = [
  { name: "DeepSeek（deepseek-chat）", provider: "deepseek", base: "https://api.deepseek.com", code: "deepseek-chat", style: "chat", temp: 0.85, max: 8192, def: 1, remark: "明细生成可用较高温度保证多样性，AI 预标注建议复制一份把温度调到 0.3~0.5" },
  { name: "OpenAI（gpt-4o-mini）", provider: "openai", base: "https://api.openai.com/v1", code: "gpt-4o-mini", style: "chat", temp: 0.8, max: 8192, def: 0, remark: "" },
  { name: "火山方舟（deepseek-v4-flash）", provider: "ark", base: "https://ark.cn-beijing.volces.com/api/v3", code: "deepseek-v4-flash-260425", style: "auto", temp: 0.85, max: 8192, def: 0, remark: "沿用 Lumos 配置。协议 auto 会自动探测 /chat/completions 与 /responses" },
];

export function ensureGenSchema(db: DatabaseSync, now: string) {
  for (const sql of DDL) db.exec(sql);
  // 服务重启时仍处于“执行中”的任务已被中断
  db.prepare(
    `UPDATE ads.ads_llm_gen_task_f SET task_status = 4, error_desc = '服务重启，任务被中断，可重新执行', finish_time = ? WHERE task_status = 2`,
  ).run(now);
  db.prepare(`UPDATE ads.ads_llm_gen_asset_f SET asset_status = CASE WHEN unit_qty > 0 THEN 2 ELSE 3 END WHERE asset_status = 1`).run();

  if (!(db.prepare("SELECT COUNT(*) AS n FROM ads.ads_llm_gen_model_f").get() as any).n) {
    const envProvider = process.env.LLM_PROVIDER ?? "deepseek";
    const ins = db.prepare(
      `INSERT INTO ads.ads_llm_gen_model_f (model_name, provider_name, base_url, api_key_value, model_code, api_style_type, temperature_rate, top_p_rate,
        max_token_qty, is_default, remark_desc, create_time, update_time) VALUES (?,?,?,?,?,?,?,0.9,?,?,?,?,?)`,
    );
    for (const m of MODELS) {
      const env = process.env.LLM_API_KEY && m.provider === envProvider;
      ins.run(
        m.name, m.provider, env ? process.env.LLM_BASE_URL ?? m.base : m.base, env ? process.env.LLM_API_KEY! : "", env ? process.env.LLM_MODEL ?? m.code : m.code,
        m.style, m.temp, m.max, m.def, m.remark, now, now,
      );
    }
  }
  if (!(db.prepare("SELECT COUNT(*) AS n FROM ads.ads_llm_gen_spec_f").get() as any).n) seedContent(db, seed, now);
}

function seedContent(db: DatabaseSync, s: Seed, now: string) {
  const insSpec = db.prepare(
    `INSERT INTO ads.ads_llm_gen_spec_f (spec_code, spec_name, spec_kind_type, task_type, source_spec_code, tag_json, config_json, remark_desc, sort_no, create_time, update_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const x of s.specs) {
    insSpec.run(x.code, x.name, x.kind, x.task_type, x.source_code, JSON.stringify(x.tags), JSON.stringify(x.config, null, 2), x.remark, x.sort, now, now);
  }
  const insPrompt = db.prepare(
    `INSERT INTO ads.ads_llm_gen_prompt_f (prompt_code, prompt_name, spec_code, system_prompt_text, user_prompt_text, version_no, remark_desc, update_time)
     VALUES (?,?,?,?,?,1,'系统预置，可直接修改（每次修改自动留存版本）',?)`,
  );
  const insVer = db.prepare(
    `INSERT INTO ads.ads_llm_gen_prompt_version_f (prompt_id, version_no, system_prompt_text, user_prompt_text, note_desc, create_time) VALUES (?,1,?,?,'初始版本',?)`,
  );
  for (const p of s.prompts) {
    const id = Number(insPrompt.run(p.code, p.name, p.spec_code, p.system_prompt, p.user_prompt, now).lastInsertRowid);
    insVer.run(id, p.system_prompt, p.user_prompt, now);
  }
  const insDict = db.prepare(`INSERT OR IGNORE INTO ads.ads_llm_gen_dict_f (dict_code, dict_name, value_json, column_list, update_time) VALUES (?,?,?,?,?)`);
  for (const d of s.dicts) insDict.run(d.code, d.name, JSON.stringify(d.value), d.columns ? JSON.stringify(d.columns) : null, now);
}
