"""一键生成 5 个模型的 SFT 训练集（需先运行 build_datasets）。

用法：python -m distill.build_sft [--tasks combo_recommend,visitor_forecast,...] [--n 100000]
"""
import argparse
import json
import os
import time

import pandas as pd

from . import config
from .sft import forecast, insight, placement, pricing, recommend

TASKS = ["combo_recommend", "visitor_forecast", "dynamic_pricing", "channel_placement", "business_insight"]
TITLES = {
    "combo_recommend": "票务产品组合推荐模型",
    "visitor_forecast": "游客人数预测模型",
    "dynamic_pricing": "票务产品动态定价模型",
    "channel_placement": "产品渠道投放模型",
    "business_insight": "经营洞察模型",
}


def _load(name):
    return pd.read_parquet(os.path.join(config.CACHE_DIR, f"{name}.parquet"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default=",".join(TASKS))
    ap.add_argument("--n", type=int, default=config.SFT_SAMPLES)
    a = ap.parse_args()
    tasks = a.tasks.split(",")
    man_path = os.path.join(config.SFT_DIR, "manifest.json")
    manifest = json.load(open(man_path, encoding="utf-8")) if os.path.exists(man_path) else {}
    cache = {}

    def get(n):
        if n not in cache:
            cache[n] = _load(n)
        return cache[n]

    for t in tasks:
        t0 = time.time()
        if t == "combo_recommend":
            info = recommend.build(get("scenic_product_detail"), get("visitor_profile"), a.n)
        elif t == "visitor_forecast":
            info = forecast.build(get("scenic_daily_ops"), a.n)
        elif t == "dynamic_pricing":
            info = pricing.build(get("scenic_daily_ops"), get("core_pois"), get("scenic_product_detail"), a.n)
        elif t == "channel_placement":
            info = placement.build(get("channel_distribution"), a.n)
        elif t == "business_insight":
            info = insight.build(get("scenic_daily_ops"), get("channel_distribution"), a.n)
        else:
            raise SystemExit(f"unknown task {t}")
        info["title"] = TITLES[t]
        info["seconds"] = round(time.time() - t0)
        print(f"[sft] {t}: {info['counts']} {info.get('stats', '')} {info['seconds']}s")
        with open(os.path.join(config.SFT_DIR, t, "info.json"), "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=2)
    # 汇总各任务 info.json 为 manifest（支持多进程分别生成不同任务）
    for t in TASKS:
        ip = os.path.join(config.SFT_DIR, t, "info.json")
        if os.path.exists(ip):
            manifest[t] = json.load(open(ip, encoding="utf-8"))
    with open(man_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
