"""一键生成 5 个明细数据集 + 日度运营辅助表。

用法：python -m distill.build_datasets
输出：output/datasets/<name>/<name>-xxxxx.csv.gz，以及 work/cache/*.parquet（供训练集构造使用）
"""
import json
import os
import time

from . import catalog, config, sim_channels, sim_daily_ops, sim_products, sim_profiles, sim_trips
from .io_utils import write_csv_shards

DATASETS = {
    "channel_distribution": "景区分销渠道数据集",
    "scenic_product_detail": "景区产品详情数据集",
    "visitor_consumption": "景区游客消费数据集",
    "visitor_profile": "景区游客画像数据集",
    "visitor_trajectory": "游客出行轨迹数据集",
    "scenic_daily_ops": "景区日度客流与运营数据（辅助表）",
}


def _save(df, name, manifest):
    df.to_parquet(os.path.join(config.CACHE_DIR, f"{name}.parquet"), index=False)
    paths = write_csv_shards(df, os.path.join(config.DATASET_DIR, name), name)
    manifest[name] = {"title": DATASETS[name], "rows": int(len(df)), "columns": list(df.columns),
                      "files": [os.path.relpath(p, config.OUTPUT_DIR) for p in paths]}
    print(f"[datasets] {name}: rows={len(df)} shards={len(paths)}")


def main():
    t0 = time.time()
    manifest = {}
    pois, products = catalog.build()
    product_detail = sim_products.build(pois, products)
    _save(product_detail, "scenic_product_detail", manifest)
    pois.to_parquet(os.path.join(config.CACHE_DIR, "pois_final.parquet"), index=False)

    profiles = sim_profiles.build()
    core, ops = sim_daily_ops.build(pois, product_detail)
    core.to_parquet(os.path.join(config.CACHE_DIR, "core_pois.parquet"), index=False)
    _save(ops, "scenic_daily_ops", manifest)

    channels = sim_channels.build(core, ops, product_detail)
    _save(channels, "channel_distribution", manifest)

    orders, traj = sim_trips.build(profiles, pois, product_detail)
    profiles = sim_profiles.backfill_from_orders(profiles, orders)
    _save(orders, "visitor_consumption", manifest)
    _save(traj, "visitor_trajectory", manifest)
    _save(profiles, "visitor_profile", manifest)

    with open(os.path.join(config.DATASET_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[datasets] done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
