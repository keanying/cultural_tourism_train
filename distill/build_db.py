"""把交付数据（output/ 下的 gzip 分片）导入 SQLite，供数据管理页面（web/）查看、在线修改与导出 JSONL。

按客户命名规范分库：每个分层一个 SQLite 文件，页面通过 ATTACH 以“库.表”方式访问，
如 SELECT * FROM dwd.dwd_ord_attraction_ticket_order_di。

  web/data/dim.db  dim.dim_prd_attraction_ticket_df
  web/data/dwd.db  dwd.dwd_ord_attraction_ticket_order_di、dwd.dwd_cus_traveler_trajectory_di
  web/data/dws.db  dws.dws_cus_traveler_profile_df、dws.dws_trf_attraction_channel_sales_mo、dws.dws_opr_attraction_operation_di
  web/data/ads.db  ads.ads_llm_sft_sample_f（训练样本）、ads.ads_llm_data_edit_log_f（修改记录）、ads.ads_llm_data_source_f（数据源目录）

业务表在规范字段之外追加两个管理字段：row_id（行号主键）、is_edited（是否被页面修改：0-否 1-是）。

用法：python -m distill.build_db [--out web/data]
"""
import argparse
import json
import os
import sqlite3
import time

from . import config, naming
from .build_datasets import DATASETS, dataset_dir
from .build_sft import TASKS, TITLES
from .io_utils import iter_jsonl_shards, read_csv_shards

# 页面表格默认展示列与关键词搜索列（规范字段名）
DS_VIEW = {
    "channel_distribution": (["stat_month", "attraction_name", "prd_name", "sales_channel_name", "channel_price_amt", "ticket_sold_qty", "gmv_amt", "marketing_spend_amt", "roas_rate", "main_segment_type"],
                             ["attraction_name", "prd_name", "sales_channel_name", "stat_month"]),
    "scenic_product_detail": (["prd_id", "attraction_name", "attraction_city_name", "attraction_category_name", "ticket_type_name", "prd_name", "list_price_amt", "sales_qty", "refund_policy_type", "target_segment_tags"],
                              ["prd_id", "attraction_name", "prd_name", "attraction_city_name"]),
    "visitor_consumption": (["order_no", "traveler_id", "attraction_name", "prd_name", "sales_channel_name", "visit_date", "ticket_qty", "paid_amt", "order_status_name", "total_spend_amt"],
                            ["order_no", "traveler_id", "attraction_name", "prd_name"]),
    "visitor_profile": (["traveler_id", "gender_type", "traveler_age", "home_city_name", "traveler_segment_name", "companion_desc", "income_level", "price_sensitivity_level", "preferred_channel_code", "total_spend_amt"],
                        ["traveler_id", "home_city_name", "traveler_segment_name"]),
    "visitor_trajectory": (["trajectory_no", "traveler_id", "trip_seq_no", "attraction_name", "attraction_city_name", "visit_date", "arrive_time", "stay_minute_qty", "transport_type", "order_no"],
                           ["trajectory_no", "traveler_id", "attraction_name", "attraction_city_name"]),
    "scenic_daily_ops": (["stat_date", "attraction_name", "attraction_city_name", "day_type_name", "holiday_name", "weather_name", "traveler_qty", "load_rate", "executed_price_amt", "total_revenue_amt"],
                         ["attraction_name", "stat_date", "attraction_city_name"]),
}

SFT_DDL = """CREATE TABLE ads.ads_llm_sft_sample_f (  -- 大模型 SFT 训练样本全量表（5 个模型训练集，含页面在线修改）
  row_id            INTEGER PRIMARY KEY,  -- 行号主键
  sample_no         TEXT,     -- 样本编号（任务-序号）
  task_code         TEXT,     -- 任务编码：combo_recommend-票务产品组合推荐 visitor_forecast-游客人数预测 dynamic_pricing-票务产品动态定价 channel_placement-产品渠道投放 business_insight-经营洞察
  split_type        TEXT,     -- 数据切分：train-训练集 val-验证集 test-测试集
  split_seq_no      INTEGER,  -- 切分内序号（与交付分片文件中的行顺序一致）
  system_content    TEXT,     -- system 消息内容（决策规则与系数表）
  user_content      TEXT,     -- user 消息内容（JSON 字符串）
  assistant_content TEXT,     -- assistant 消息内容（<thought>…</thought><answer>…</answer>）
  meta_content      TEXT,     -- 评测真值与溯源信息（JSON，不进入训练文本）
  is_edited         INTEGER NOT NULL DEFAULT 0,  -- 是否被页面修改：0-否 1-是
  update_time       TEXT      -- 最近修改时间（YYYY-MM-DD HH:MM:SS）
)"""

LOG_DDL = """CREATE TABLE ads.ads_llm_data_edit_log_f (  -- 数据在线修改记录全量表
  row_id            INTEGER PRIMARY KEY,  -- 行号主键
  edit_time         TEXT,     -- 修改时间（YYYY-MM-DD HH:MM:SS）
  source_code       TEXT,     -- 数据源编码（见 ads.ads_llm_data_source_f）
  data_row_id       INTEGER,  -- 被修改数据的 row_id
  field_name        TEXT,     -- 被修改字段名
  old_value_content TEXT,     -- 修改前取值
  new_value_content TEXT      -- 修改后取值
)"""

SRC_DDL = """CREATE TABLE ads.ads_llm_data_source_f (  -- 数据管理页面数据源目录全量表
  source_code        TEXT PRIMARY KEY,  -- 数据源编码
  db_name            TEXT,     -- 库名
  table_name         TEXT,     -- 表名
  title_name         TEXT,     -- 中文名称
  source_type        TEXT,     -- 数据源类型：dataset-明细数据集 sft-训练集
  table_comment_desc TEXT,     -- 表注释
  row_qty            INTEGER,  -- 行数
  column_list        TEXT,     -- 全部字段（JSON 数组）
  view_column_list   TEXT,     -- 页面默认展示字段（JSON 数组）
  search_column_list TEXT,     -- 关键词搜索字段（JSON 数组）
  column_comment_map TEXT,     -- 字段注释（JSON 对象）
  column_enum_map    TEXT      -- 编码字段取值含义（JSON 对象：字段 -> {编码: 含义}）
)"""


def _ddl(name):
    t = naming.TABLES[name]
    lines = [f"  row_id INTEGER PRIMARY KEY,  -- 行号主键（交付文件中的行顺序，从 1 开始）"]
    for f in t["fields"]:
        lines.append(f"  {f['name']} {naming.sqlite_type(f['type'])},  -- {f['comment']}")
    lines.append(f"  {naming.PARTITION} TEXT,  -- 分区日期，YYYYMMDD（{t['partition'][0]}）")
    lines.append("  is_edited INTEGER NOT NULL DEFAULT 0  -- 是否被页面修改：0-否 1-是")
    return f"CREATE TABLE {naming.full_name(name)} (  -- {t['comment']}\n" + "\n".join(lines) + "\n)"


def build(out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    dbs = sorted({t["db"] for t in naming.TABLES.values()} | {"ads"})
    tmp = {db: os.path.join(out_dir, f"{db}.db.tmp") for db in dbs}
    for p in tmp.values():
        if os.path.exists(p):
            os.remove(p)
    con = sqlite3.connect(":memory:")
    for db, p in tmp.items():
        con.execute(f"ATTACH DATABASE ? AS {db}", (p,))
        con.execute(f"PRAGMA {db}.journal_mode=OFF")
        con.execute(f"PRAGMA {db}.synchronous=OFF")
    con.execute(SRC_DDL)
    src_sql = "INSERT INTO ads.ads_llm_data_source_f VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"

    for name in DATASETS:
        t0 = time.time()
        t = naming.TABLES[name]
        df = read_csv_shards(dataset_dir(name), t["table"])
        cols = [f["name"] for f in t["fields"]] + [naming.PARTITION]
        assert list(df.columns) == cols, f"{name} 字段与规范不一致"
        con.execute(_ddl(name))
        ph = ", ".join("?" * (len(cols) + 1))
        rows = ((i + 1, *[None if v != v else (v.item() if hasattr(v, "item") else v) for v in r])
                for i, r in enumerate(df.itertuples(index=False, name=None)))
        con.executemany(f"INSERT INTO {naming.full_name(name)} (row_id, {', '.join(cols)}) VALUES ({ph})", rows)
        view, search = DS_VIEW[name]
        comments = {f["name"]: f["comment"] for f in t["fields"]}
        comments[naming.PARTITION] = f"分区日期 YYYYMMDD（{t['partition'][0]}）"
        enums = {f["name"]: {str(k): v for k, v in naming.ENUMS[f["enum"]].items()} for f in t["fields"] if f["enum"]}
        con.execute(src_sql, (name, t["db"], t["table"], t["title"], "dataset", t["comment"], len(df),
                              json.dumps(cols), json.dumps(view), json.dumps(search),
                              json.dumps(comments, ensure_ascii=False), json.dumps(enums, ensure_ascii=False)))
        con.commit()
        print(f"[db] {naming.full_name(name)}: {len(df)} rows {time.time() - t0:.0f}s")

    con.execute(SFT_DDL)
    ins = ("INSERT INTO ads.ads_llm_sft_sample_f (task_code, split_type, split_seq_no, sample_no, system_content, "
           "user_content, assistant_content, meta_content) VALUES (?,?,?,?,?,?,?,?)")
    for task in TASKS:
        t0 = time.time()
        d = os.path.join(config.SFT_DIR, task)
        metas = {(m["split"], m["index_in_split"]): m for m in iter_jsonl_shards(d, f"{task}_meta")}
        n = 0
        for split in ("train", "val", "test"):
            batch = []
            for i, s in enumerate(iter_jsonl_shards(d, f"{task}_{split}")):
                m = metas[(split, i)]
                msgs = s["messages"]
                batch.append((task, split, i, m["id"], msgs[0]["content"], msgs[1]["content"], msgs[2]["content"],
                              json.dumps(m, ensure_ascii=False)))
                if len(batch) >= 5000:
                    con.executemany(ins, batch)
                    n += len(batch)
                    batch = []
            con.executemany(ins, batch)
            n += len(batch)
        con.execute(src_sql, (task, "ads", "ads_llm_sft_sample_f", TITLES[task], "sft",
                              f"{TITLES[task]} SFT 训练样本（task_code={task}）", n,
                              json.dumps(["sample_no", "split_type", "user_content", "assistant_content"]), "[]",
                              json.dumps(["user_content", "assistant_content", "sample_no"]),
                              json.dumps({"sample_no": "样本编号", "split_type": "数据切分", "user_content": "用户输入",
                                          "assistant_content": "回答"}, ensure_ascii=False), "{}"))
        con.commit()
        print(f"[db] ads.ads_llm_sft_sample_f/{task}: {n} rows {time.time() - t0:.0f}s")
    con.execute("CREATE INDEX ads.idx_sft_task ON ads_llm_sft_sample_f(task_code, split_type, split_seq_no)")
    con.execute("CREATE INDEX ads.idx_sft_sample ON ads_llm_sft_sample_f(sample_no)")
    con.execute(LOG_DDL)
    con.execute("CREATE INDEX ads.idx_log_row ON ads_llm_data_edit_log_f(source_code, data_row_id)")
    con.commit()
    con.close()
    for db, p in tmp.items():
        os.replace(p, os.path.join(out_dir, f"{db}.db"))
    print(f"[db] done -> {out_dir}/{{{','.join(dbs)}}}.db")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(config.ROOT, "web", "data"))
    a = ap.parse_args()
    build(a.out)


if __name__ == "__main__":
    main()
