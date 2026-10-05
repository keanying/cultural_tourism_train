"""一键生成 5 个明细数据集 + 日度运营辅助表。

用法：python -m distill.build_datasets
      python -m distill.build_datasets --export-only   # 只按命名规范重新导出交付文件
输出：output/datasets/<库>/<表>/<表>-xxxxx.csv.gz（按客户命名规范，见 distill/naming.py），
      以及 work/cache/*.parquet（内部字段名，供训练集构造使用）
"""
import json
import os
import time

from . import catalog, config, naming, sim_channels, sim_daily_ops, sim_products, sim_profiles, sim_trips
from .io_utils import write_csv_shards

DATASETS = {
    "channel_distribution": "景区分销渠道数据集",
    "scenic_product_detail": "景区产品详情数据集",
    "visitor_consumption": "景区游客消费数据集",
    "visitor_profile": "景区游客画像数据集",
    "visitor_trajectory": "游客出行轨迹数据集",
    "scenic_daily_ops": "景区日度客流与运营数据（辅助表）",
}


def dataset_dir(name):
    """交付目录：output/datasets/<库>/<表>/"""
    t = naming.TABLES[name]
    return os.path.join(config.DATASET_DIR, t["db"], t["table"])


def export_standard(df, name, manifest):
    """按客户命名规范输出：字段改名、类型/状态编码、追加 travel_date 分区字段。"""
    t = naming.TABLES[name]
    std = naming.to_standard(df, name)
    paths = write_csv_shards(std, dataset_dir(name), t["table"])
    manifest[name] = {"title": DATASETS[name], "table": naming.full_name(name), "comment": t["comment"],
                      "rows": int(len(std)), "columns": list(std.columns),
                      "files": [os.path.relpath(p, config.OUTPUT_DIR) for p in paths]}
    print(f"[datasets] {naming.full_name(name)}: rows={len(std)} shards={len(paths)}")


def _save(df, name, manifest):
    # 内部字段名的缓存供训练集构造使用；交付文件按规范命名
    df.to_parquet(os.path.join(config.CACHE_DIR, f"{name}.parquet"), index=False)
    export_standard(df, name, manifest)


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

    write_manifest(manifest)
    print(f"[datasets] done in {time.time() - t0:.0f}s")


def write_manifest(manifest):
    with open(os.path.join(config.DATASET_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def export_from_cache():
    """不重新仿真，直接用缓存（内部字段）重新导出规范命名的交付文件。"""
    import pandas as pd
    manifest = {}
    for name in DATASETS:
        export_standard(pd.read_parquet(os.path.join(config.CACHE_DIR, f"{name}.parquet")), name, manifest)
    write_manifest(manifest)


if __name__ == "__main__":
    import sys
    export_from_cache() if "--export-only" in sys.argv else main()
