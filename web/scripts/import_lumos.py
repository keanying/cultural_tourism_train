# -*- coding: utf-8 -*-
"""把 Lumos（labelumos）历史库 lumos.db 导入「数据资产 · AI 生成」板块。

导入内容：模型配置、数据规格、提示词（含全部历史版本）、业务字典、生成任务（含日志）、资产、会话、样本。
导入后资产出现在「数据资产」与需求区数据源中，可直接发布标注需求进入标注审核流程。

规则：
  - 规格 / 提示词 / 字典按编码匹配：平台已存在的默认跳过（--overwrite 覆盖；已被任务使用的提示词与规格始终不覆盖）。
  - 样本内容取 Lumos 人工审核修改后的版本（edited），没有则取机器产出（content）。
  - Lumos 中审核为“驳回”的会话默认不导入（--keep-rejected 保留）。
  - API Key 默认一并导入（--no-keys 不导入，之后在“模型管理”中填写）。
  - 同一份 lumos.db 重复导入时，已导入过的资产会跳过（按 Lumos 资产ID 记录在资产标签 _lumos_asset_id 中）。

用法：先启动一次页面（建好平台表），再执行
  python web/scripts/import_lumos.py --lumos /path/to/labelumos/data/lumos.db [--ads web/data/ads.db] [--overwrite] [--keep-rejected] [--no-keys]
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TASK_STATUS = {"pending": 1, "running": 4, "paused": 5, "done": 3, "failed": 4, "canceled": 5}
SKIP_KV = {"system_settings", "dict_schema"}


def now():
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lumos", required=True, help="Lumos 的 lumos.db 路径")
    ap.add_argument("--ads", default=os.path.join(HERE, "..", "data", "ads.db"), help="平台 ads.db 路径（默认 web/data/ads.db）")
    ap.add_argument("--overwrite", action="store_true", help="覆盖平台已存在的同编码规格/提示词/字典")
    ap.add_argument("--keep-rejected", action="store_true", help="导入 Lumos 中审核驳回的会话")
    ap.add_argument("--no-keys", action="store_true", help="不导入模型 API Key")
    a = ap.parse_args()

    src = sqlite3.connect("file:%s?mode=ro" % os.path.abspath(a.lumos), uri=True)
    src.row_factory = sqlite3.Row
    dst = sqlite3.connect(os.path.abspath(a.ads), timeout=30)
    dst.row_factory = sqlite3.Row
    have = {r[0] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "ads_llm_gen_asset_f" not in have:
        sys.exit("ads.db 中还没有 AI 生成板块的表：请先启动一次页面（npm start）再导入")
    q = lambda sql, args=(): [dict(r) for r in src.execute(sql, args)]  # noqa: E731
    t = now()
    stat = {}
    used_prompts = {r[0] for r in dst.execute("SELECT DISTINCT prompt_id FROM ads_llm_gen_task_f")}
    used_specs = {r[0] for r in dst.execute("SELECT spec_code FROM ads_llm_gen_task_f UNION SELECT spec_code FROM ads_llm_gen_asset_f")}
    skipped = []

    dst.execute("BEGIN")
    try:
        # ---------------------------------------------------------- 模型
        model_map = {}
        new_models = 0
        for m in q("SELECT * FROM model_config"):
            row = dst.execute("SELECT model_id FROM ads_llm_gen_model_f WHERE base_url = ? AND model_code = ? AND model_name = ?",
                              (m["base_url"], m["model_id"], m["name"])).fetchone()
            if row:
                model_map[m["id"]] = row[0]
                if m["api_key"] and not a.no_keys:
                    dst.execute("UPDATE ads_llm_gen_model_f SET api_key_value = ? WHERE model_id = ? AND COALESCE(api_key_value, '') = ''", (m["api_key"], row[0]))
                continue
            cur = dst.execute(
                """INSERT INTO ads_llm_gen_model_f (model_name, provider_name, base_url, api_key_value, model_code, api_style_type, temperature_rate, top_p_rate,
                   max_token_qty, timeout_sec_qty, extra_body_json, is_default, is_active, remark_desc, create_time, update_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)""",
                (m["name"], m["provider"], m["base_url"], "" if a.no_keys else m["api_key"], m["model_id"], m["api_style"] or "auto", m["temperature"], m["top_p"],
                 m["max_tokens"], m["timeout"], m["extra_body"] or "{}", m["is_active"], (m["remark"] or "") + "（导入自 Lumos）", t, t))
            model_map[m["id"]] = cur.lastrowid
            new_models += 1
        stat["模型"] = new_models

        # ---------------------------------------------------------- 规格
        n = 0
        for s in q("SELECT * FROM spec"):
            exists = dst.execute("SELECT config_json FROM ads_llm_gen_spec_f WHERE spec_code = ?", (s["code"],)).fetchone()
            cfg = json.dumps(json.loads(s["config"] or "{}"), ensure_ascii=False, indent=2)
            if exists and json.loads(exists[0]) == json.loads(cfg):
                continue  # 平台中已是同一份规格
            if exists:
                if not a.overwrite or s["code"] in used_specs:
                    skipped.append("规格 " + s["code"])
                    continue
                dst.execute("""UPDATE ads_llm_gen_spec_f SET spec_name=?, spec_kind_type=?, task_type=?, source_spec_code=?, tag_json=?, config_json=?, remark_desc=?,
                               sort_no=?, is_active=?, update_time=? WHERE spec_code=?""",
                            (s["name"], s["kind"], s["task_type"], s["source_code"], s["tags"], cfg, s["remark"], s["sort"], s["is_active"], t, s["code"]))
            else:
                dst.execute("""INSERT INTO ads_llm_gen_spec_f (spec_code, spec_name, spec_kind_type, task_type, source_spec_code, tag_json, config_json, remark_desc,
                               sort_no, is_active, create_time, update_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (s["code"], s["name"], s["kind"], s["task_type"], s["source_code"], s["tags"], cfg, s["remark"], s["sort"], s["is_active"], t, t))
            n += 1
        stat["规格"] = n

        # ---------------------------------------------------------- 提示词与版本
        prompt_map = {}
        n = 0
        for p in q("SELECT * FROM prompt_template"):
            versions = q("SELECT * FROM prompt_version WHERE prompt_id = ? ORDER BY version", (p["id"],))
            if not versions:
                versions = [{"version": p["version"], "system_prompt": p["system_prompt"], "user_prompt": p["user_prompt"], "note": "导入", "created_at": t}]
            row = dst.execute("SELECT prompt_id, version_no, system_prompt_text, user_prompt_text FROM ads_llm_gen_prompt_f WHERE prompt_code = ?", (p["code"],)).fetchone()
            if row:
                if (row[1], row[2], row[3]) == (p["version"], p["system_prompt"], p["user_prompt"]):
                    prompt_map[p["id"]] = row[0]  # 平台中已是同一份提示词（同版本同内容）
                    continue
                if a.overwrite and row[0] not in used_prompts:
                    dst.execute("DELETE FROM ads_llm_gen_prompt_version_f WHERE prompt_id = ?", (row[0],))
                    dst.execute("DELETE FROM ads_llm_gen_prompt_f WHERE prompt_id = ?", (row[0],))
                else:
                    # 平台的同编码提示词保留，Lumos 的以新编码导入（版本号原样保留，历史资产可回溯到生成时的提示词）
                    p = dict(p, code=p["code"] + "_lumos")
                    old = dst.execute("SELECT prompt_id FROM ads_llm_gen_prompt_f WHERE prompt_code = ?", (p["code"],)).fetchone()
                    if old:
                        prompt_map[p["id"]] = old[0]
                        continue
                    skipped.append("提示词 %s（平台已有同编码，以 %s 导入）" % (p["code"][:-6], p["code"]))
            cur = dst.execute(
                """INSERT INTO ads_llm_gen_prompt_f (prompt_code, prompt_name, spec_code, system_prompt_text, user_prompt_text, version_no, is_active, remark_desc, update_time)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (p["code"], p["name"], p["spec_code"], p["system_prompt"], p["user_prompt"], p["version"], p["is_active"], (p["remark"] or "") + "（导入自 Lumos）", t))
            pid = cur.lastrowid
            for v in versions:
                dst.execute("""INSERT INTO ads_llm_gen_prompt_version_f (prompt_id, version_no, system_prompt_text, user_prompt_text, note_desc, create_time)
                               VALUES (?,?,?,?,?,?)""", (pid, v["version"], v["system_prompt"], v["user_prompt"], v["note"] or "", v["created_at"] or t))
            prompt_map[p["id"]] = pid
            n += 1
        stat["提示词"] = n

        # ---------------------------------------------------------- 字典
        n = 0
        for kv in q("SELECT * FROM config_kv"):
            if kv["key"].startswith("_") or kv["key"] in SKIP_KV:
                continue
            exists = dst.execute("SELECT value_json FROM ads_llm_gen_dict_f WHERE dict_code = ?", (kv["key"],)).fetchone()
            value = json.dumps(json.loads(kv["value"]), ensure_ascii=False)
            if exists:
                if json.loads(exists[0]) == json.loads(value):
                    continue
                if not a.overwrite:
                    skipped.append("字典 " + kv["key"])
                    continue
                dst.execute("UPDATE ads_llm_gen_dict_f SET value_json = ?, update_time = ? WHERE dict_code = ?", (value, t, kv["key"]))
            else:
                dst.execute("INSERT INTO ads_llm_gen_dict_f (dict_code, dict_name, value_json, update_time) VALUES (?,?,?,?)", (kv["key"], kv["remark"] or kv["key"], value, t))
            n += 1
        stat["字典"] = n

        # ---------------------------------------------------------- 任务
        done_assets = {}
        for r in dst.execute("SELECT asset_id, tag_json FROM ads_llm_gen_asset_f"):
            try:
                lid = json.loads(r[1] or "{}").get("_lumos_asset_id")
            except Exception:
                lid = None
            if lid:
                done_assets[int(lid)] = r[0]
        task_map = {}
        users = {u["id"]: u["display_name"] for u in q("SELECT id, display_name FROM user")}
        for tk in q("SELECT * FROM task ORDER BY id"):
            if tk["asset_id"] in done_assets:
                continue
            no = tk["task_no"]
            while dst.execute("SELECT 1 FROM ads_llm_gen_task_f WHERE task_no = ?", (no,)).fetchone():
                no += "L"
            cur = dst.execute(
                """INSERT INTO ads_llm_gen_task_f (task_no, task_name, task_type, spec_code, source_asset_id, model_id, prompt_id, prompt_version_no, target_qty, batch_qty,
                   concurrency_qty, param_json, task_status, asset_id, done_unit_qty, done_pair_qty, dup_qty, fail_qty, call_qty, token_in_qty, token_out_qty, error_desc,
                   start_time, finish_time, create_time) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?)""",
                (no, tk["name"], tk["task_type"], tk["spec_code"], model_map.get(tk["model_config_id"], 0), prompt_map.get(tk["prompt_id"]) or 0, tk["prompt_version"],
                 tk["target"], tk["batch_size"], tk["concurrency"], tk["params"] or "{}", TASK_STATUS.get(tk["status"], 4), tk["done_units"], tk["done_pairs"],
                 tk["dup_count"], tk["fail_count"], tk["call_count"], tk["token_in"], tk["token_out"],
                 (tk["error"] or "") + ("（Lumos 中任务被中断）" if tk["status"] == "running" else ""), tk["started_at"], tk["finished_at"], tk["created_at"] or t))
            task_map[tk["id"]] = cur.lastrowid
            for lg in q("SELECT * FROM task_log WHERE task_id = ? ORDER BY id", (tk["id"],)):
                dst.execute("INSERT INTO ads_llm_gen_task_log_f (task_id, level_type, message_desc, create_time) VALUES (?,?,?,?)",
                            (cur.lastrowid, lg["level"], lg["message"], lg["ts"]))
            dst.execute("INSERT INTO ads_llm_gen_task_log_f (task_id, level_type, message_desc, create_time) VALUES (?,?,?,?)",
                        (cur.lastrowid, "info", "导入自 Lumos（创建人：%s）" % users.get(tk["created_by"], "未知"), t))
        stat["任务"] = len(task_map)

        # ---------------------------------------------------------- 资产、会话、样本
        asset_map = dict(done_assets)
        convs = samples = rejected = 0
        for at in q("SELECT * FROM asset ORDER BY id"):
            if at["id"] in done_assets:
                skipped.append("资产 %s（已导入过）" % at["name"])
                continue
            tags = json.loads(at["tags"] or "{}")
            tags["_lumos_asset_id"] = at["id"]
            cur = dst.execute(
                """INSERT INTO ads_llm_gen_asset_f (asset_name, asset_kind_type, spec_code, task_id, version_no, asset_status, tag_json, unit_qty, pair_qty, create_time, update_time)
                   VALUES (?,?,?,?,?,2,?,0,0,?,?)""",
                (at["name"], at["kind"], at["spec_code"], task_map.get(at["task_id"], 0), at["version"], json.dumps(tags, ensure_ascii=False), at["created_at"] or t, t))
            aid = cur.lastrowid
            asset_map[at["id"]] = aid
            keep = set()
            seq = 0
            for c in q("SELECT * FROM conversation WHERE asset_id = ? ORDER BY seq, id", (at["id"],)):
                if c["review_status"] == "rejected" and not a.keep_rejected:
                    rejected += 1
                    continue
                seq += 1
                payload = json.loads(c["payload"] or "{}")
                dst.execute(
                    """INSERT OR IGNORE INTO ads_llm_gen_conversation_f (asset_id, conversation_id, seq_no, turn_qty, payload_json, dedup_key, source_conversation_id, create_time)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (aid, c["conv_id"], seq, c["turn_count"], json.dumps(payload, ensure_ascii=False), c["dedup_key"] or "%s#%d" % (c["conv_id"], c["id"]),
                     c["source_conv_id"], c["created_at"] or t))
                keep.add(c["conv_id"])
                convs += 1
            for s in q("SELECT * FROM sample WHERE asset_id = ? ORDER BY conv_id, turn_no", (at["id"],)):
                if s["conv_id"] not in keep:
                    continue
                dst.execute(
                    """INSERT INTO ads_llm_gen_sample_f (asset_id, conversation_id, turn_no, sample_id, content_json, meta_json, job_var_json, is_valid, invalid_reason_desc, create_time)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (aid, s["conv_id"], s["turn_no"], s["sample_id"], s["edited"] or s["content"], s["meta"] or "{}", s["job_vars"] or "{}", s["valid"], s["invalid_reason"],
                     s["created_at"] or t))
                samples += 1
            units = dst.execute("SELECT COUNT(*) FROM ads_llm_gen_conversation_f WHERE asset_id = ?", (aid,)).fetchone()[0]
            pairs = (dst.execute("SELECT COUNT(*) FROM ads_llm_gen_sample_f WHERE asset_id = ?", (aid,)).fetchone()[0] if at["kind"] == "sft"
                     else dst.execute("SELECT COALESCE(SUM(turn_qty), 0) FROM ads_llm_gen_conversation_f WHERE asset_id = ?", (aid,)).fetchone()[0])
            dst.execute("UPDATE ads_llm_gen_asset_f SET unit_qty = ?, pair_qty = ?, asset_status = ? WHERE asset_id = ?", (units, pairs, 2 if units else 3, aid))
        for old, new in task_map.items():
            tk = src.execute("SELECT asset_id, source_asset_id FROM task WHERE id = ?", (old,)).fetchone()
            dst.execute("UPDATE ads_llm_gen_task_f SET asset_id = ?, source_asset_id = ? WHERE task_id = ?",
                        (asset_map.get(tk["asset_id"], 0), asset_map.get(tk["source_asset_id"], 0), new))
        stat["资产"] = len(asset_map) - len(done_assets)
        stat["会话"] = convs
        stat["样本"] = samples
        stat["跳过驳回会话"] = rejected
        dst.execute("COMMIT")
    except Exception:
        dst.execute("ROLLBACK")
        raise
    print("导入完成：" + "，".join("%s %d" % kv for kv in stat.items()))
    if skipped:
        print("说明（同编码配置默认保留平台版本，如需覆盖加 --overwrite）：" + "、".join(skipped))


if __name__ == "__main__":
    main()
