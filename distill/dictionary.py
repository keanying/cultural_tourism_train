"""根据客户命名规范（distill/naming.py）生成交付文档：
  docs/数据字典.md        表/字段/编码说明
  docs/ddl/<库>.<表>.sql   每张表的建表语句（Hive，表与字段均带 COMMENT，按 travel_date 分区）
  docs/ddl/all_tables.sql  全部建表语句

用法：python -m distill.dictionary
"""
import json
import os

from . import config, naming

LAYER = {"dim": "DIM 维度层", "dwd": "DWD 明细层", "dws": "DWS 汇总层", "ads": "ADS 应用层"}


def main():
    man_path = os.path.join(config.DATASET_DIR, "manifest.json")
    man = json.load(open(man_path, encoding="utf-8")) if os.path.exists(man_path) else {}
    ddl_dir = os.path.join(config.ROOT, "docs", "ddl")
    os.makedirs(ddl_dir, exist_ok=True)
    all_ddl = ["-- 文旅大模型训练数据：建表语句（按客户数仓命名规范）\n"
               + "".join(f"CREATE DATABASE IF NOT EXISTS {db};\n" for db in sorted({t['db'] for t in naming.TABLES.values()}))]
    out = ["# 数据字典", "",
           "命名遵循客户数仓规范：表名为“分层_业务域_实体名_粒度”，代码中使用“库.表”；字段为 snake_case 的“实体_属性”，"
           "后缀关键字 `_code/_no/_name/_type/_status/_date/_time/_amt/_qty/_rate`；类型/状态/等级字段统一编码，并在注释中写明每个取值的含义；"
           "所有表按 `travel_date`（YYYYMMDD）分区。建表语句见 `docs/ddl/`。", "",
           "来源标记：**真实**=携程采集原值；**解析**=由真实文本规则解析；**推断**=由真实数据推断；"
           "**派生**=基于真实值按业务规则计算；**仿真**=按业务逻辑统计仿真生成（非真实交易）。", "",
           "## 表清单", "", "| 库.表 | 中文名 | 分层 | 粒度 | 分区 travel_date 含义 | 行数 |", "|---|---|---|---|---|---|"]
    for name, t in naming.TABLES.items():
        gran = {"di": "天级增量", "df": "天级全量快照", "mo": "月级增量"}[t["table"].rsplit("_", 1)[1]]
        out.append(f"| `{naming.full_name(name)}` | {t['title']} | {LAYER[t['db']]} | {gran} | {t['partition'][0]} | "
                   f"{man.get(name, {}).get('rows', '-')} |")
    out.append("")
    for name, t in naming.TABLES.items():
        ddl = naming.ddl_hive(name)
        with open(os.path.join(ddl_dir, f"{naming.full_name(name)}.sql"), "w", encoding="utf-8") as f:
            f.write(ddl)
        all_ddl.append(ddl)
        info = man.get(name, {})
        out += [f"## {t['title']}：`{naming.full_name(name)}`", "", f"**表注释**：{t['comment']}", "",
                f"- 行数：{info.get('rows', '-')}",
                f"- 文件：{', '.join('`' + x + '`' for x in info.get('files', []))}",
                f"- 建表语句：`docs/ddl/{naming.full_name(name)}.sql`", "",
                "| 字段 | 类型 | 注释 | 来源 |", "|---|---|---|---|"]
        out += [f"| `{f['name']}` | {f['type']} | {f['comment']} | {naming.origin_of(name, f)} |" for f in t["fields"]]
        out += [f"| `{naming.PARTITION}` | STRING | 分区字段，YYYYMMDD（{t['partition'][0]}） | 派生 |", ""]
    with open(os.path.join(ddl_dir, "all_tables.sql"), "w", encoding="utf-8") as f:
        f.write("\n".join(all_ddl))
    with open(os.path.join(config.ROOT, "docs", "数据字典.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("docs/数据字典.md 与 docs/ddl/*.sql 已生成")


if __name__ == "__main__":
    main()
