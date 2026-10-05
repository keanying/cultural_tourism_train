"""把交付数据（output/ 下的 gzip 分片）导入 SQLite，供数据管理页面（web/）查看、在线修改与导出 JSONL。

用法：python -m distill.build_db [--db web/data/ct.db]
表结构：
  ds_<数据集名>   明细数据集，_id 为原始行号（从 1 开始），_edited 标记是否被页面修改过
  sft             训练样本：task/split/idx/sid/system/user/assistant/meta/_edited/updated_at
  edit_log        页面修改记录：时间、数据源、行、字段、修改前、修改后
  sources         数据源目录（名称、标题、类型、行数、列、搜索列）
"""
import argparse
import json
import os
import sqlite3
import time

from . import config
from .build_datasets import DATASETS
from .build_sft import TASKS, TITLES
from .dictionary import DICT
from .io_utils import iter_jsonl_shards, read_csv_shards

# 每个数据集在表格中默认展示的列与关键词搜索列
DS_VIEW = {
    "channel_distribution": (["stat_month", "poi_name", "product_name", "channel", "channel_price", "tickets_sold", "gmv", "marketing_spend", "roas", "main_segment"],
                             ["poi_name", "product_name", "channel", "stat_month"]),
    "scenic_product_detail": (["product_id", "poi_name", "city", "scenic_category", "ticket_type_name", "product_name", "list_price", "sales_volume", "refund_policy", "target_segments"],
                              ["product_id", "poi_name", "product_name", "city"]),
    "visitor_consumption": (["order_id", "visitor_id", "poi_name", "product_name", "channel", "visit_date", "quantity", "paid_amount", "order_status", "total_spend"],
                            ["order_id", "visitor_id", "poi_name", "product_name"]),
    "visitor_profile": (["visitor_id", "gender", "age", "source_city", "travel_type", "party_structure", "income_level", "price_sensitivity", "preferred_channel", "total_spend"],
                        ["visitor_id", "source_city", "travel_type"]),
    "visitor_trajectory": (["trajectory_id", "visitor_id", "seq_no", "poi_name", "city", "visit_date", "arrive_time", "stay_minutes", "transport_from_prev", "order_id"],
                           ["trajectory_id", "visitor_id", "poi_name", "city"]),
    "scenic_daily_ops": (["date", "poi_name", "city", "day_type", "holiday_name", "weather", "visitors", "load_rate", "executed_price", "total_revenue"],
                         ["poi_name", "date", "city"]),
}


def labels_of(name):
    """字段中文名（来自数据字典），seg_share_<客群> 等展开列单独处理。"""
    lab = {c: d for c, d, _ in DICT[name][2]}
    from .segments import SEGMENTS
    for sg in SEGMENTS:
        lab[f"seg_share_{sg}"] = f"{sg}占比"
    return lab


def _sqltype(dtype) -> str:
    k = dtype.kind
    return "INTEGER" if k in "iub" else ("REAL" if k == "f" else "TEXT")


def build(db_path: str):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    tmp = db_path + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    con.execute("CREATE TABLE sources (name TEXT PRIMARY KEY, title TEXT, kind TEXT, rows INTEGER, columns TEXT, "
                "view_columns TEXT, search_columns TEXT, labels TEXT)")
    for name, title in DATASETS.items():
        t0 = time.time()
        df = read_csv_shards(os.path.join(config.DATASET_DIR, name), name)
        cols = list(df.columns)
        decl = ", ".join(f'"{c}" {_sqltype(df[c].dtype)}' for c in cols)
        con.execute(f'CREATE TABLE "ds_{name}" (_id INTEGER PRIMARY KEY, {decl}, _edited INTEGER NOT NULL DEFAULT 0)')
        ph = ", ".join("?" * (len(cols) + 1))
        rows = ((i + 1, *[None if v != v else (v.item() if hasattr(v, "item") else v) for v in r])
                for i, r in enumerate(df.itertuples(index=False, name=None)))
        con.executemany(f'INSERT INTO "ds_{name}" (_id, {", ".join(chr(34) + c + chr(34) for c in cols)}) VALUES ({ph})', rows)
        view, search = DS_VIEW[name]
        con.execute("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)",
                    (name, title, "dataset", len(df), json.dumps(cols, ensure_ascii=False),
                     json.dumps(view), json.dumps(search), json.dumps(labels_of(name), ensure_ascii=False)))
        con.commit()
        print(f"[db] {name}: {len(df)} rows {time.time() - t0:.0f}s")

    con.execute("""CREATE TABLE sft (_id INTEGER PRIMARY KEY, task TEXT, split TEXT, idx INTEGER, sid TEXT,
                   system TEXT, user TEXT, assistant TEXT, meta TEXT, _edited INTEGER NOT NULL DEFAULT 0, updated_at TEXT)""")
    for task in TASKS:
        t0 = time.time()
        d = os.path.join(config.SFT_DIR, task)
        metas = {}
        for m in iter_jsonl_shards(d, f"{task}_meta"):
            metas[(m["split"], m["index_in_split"])] = m
        n = 0
        for split in ("train", "val", "test"):
            batch = []
            for i, s in enumerate(iter_jsonl_shards(d, f"{task}_{split}")):
                m = metas[(split, i)]
                msgs = s["messages"]
                batch.append((task, split, i, m["id"], msgs[0]["content"], msgs[1]["content"], msgs[2]["content"],
                              json.dumps(m, ensure_ascii=False)))
                if len(batch) >= 5000:
                    con.executemany("INSERT INTO sft (task, split, idx, sid, system, user, assistant, meta) VALUES (?,?,?,?,?,?,?,?)", batch)
                    n += len(batch)
                    batch = []
            con.executemany("INSERT INTO sft (task, split, idx, sid, system, user, assistant, meta) VALUES (?,?,?,?,?,?,?,?)", batch)
            n += len(batch)
        con.execute("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)",
                    (task, TITLES[task], "sft", n, json.dumps(["sid", "split", "user", "assistant"]), "[]",
                     '["user","assistant","sid"]', "{}"))
        con.commit()
        print(f"[db] sft/{task}: {n} rows {time.time() - t0:.0f}s")
    con.execute("CREATE INDEX idx_sft_task ON sft(task, split, idx)")
    con.execute("CREATE INDEX idx_sft_sid ON sft(sid)")
    con.execute("""CREATE TABLE edit_log (id INTEGER PRIMARY KEY, ts TEXT, source TEXT, row_id INTEGER, field TEXT,
                   old_value TEXT, new_value TEXT)""")
    con.commit()
    con.close()
    os.replace(tmp, db_path)
    print(f"[db] done -> {db_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(config.ROOT, "web", "data", "ct.db"))
    a = ap.parse_args()
    build(a.db)


if __name__ == "__main__":
    main()
