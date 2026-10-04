"""输出工具：按大小切分的 gzip 分片（CSV / JSONL），满足 GitHub 单文件 100MB 限制。"""
import glob
import gzip
import io
import json
import os

import pandas as pd

from . import config


def _clear(prefix):
    for f in glob.glob(prefix + "-*.gz"):
        os.remove(f)


def write_csv_shards(df: pd.DataFrame, out_dir: str, name: str, rows_per_shard: int = None):
    """写 name-00000.csv.gz ...，每片都带表头，UTF-8 with BOM 便于 Excel 打开。"""
    os.makedirs(out_dir, exist_ok=True)
    prefix = os.path.join(out_dir, name)
    _clear(prefix)
    if rows_per_shard is None:
        # 先估算每行压缩后体积，再定分片行数
        probe = df.head(2000).to_csv(index=False).encode("utf-8")
        est = len(gzip.compress(probe)) / max(len(df.head(2000)), 1)
        rows_per_shard = max(1000, int(config.SHARD_MAX_BYTES * 0.8 / max(est, 1)))
    paths = []
    for i, start in enumerate(range(0, len(df), rows_per_shard)):
        part = df.iloc[start:start + rows_per_shard]
        path = f"{prefix}-{i:05d}.csv.gz"
        buf = io.StringIO()
        part.to_csv(buf, index=False)
        with gzip.open(path, "wb", compresslevel=6) as f:
            f.write(("﻿" + buf.getvalue()).encode("utf-8"))
        paths.append(path)
    return paths


class JsonlShardWriter:
    """流式写 JSONL.gz，超过体积上限自动切换分片。"""

    def __init__(self, out_dir, name):
        os.makedirs(out_dir, exist_ok=True)
        self.prefix = os.path.join(out_dir, name)
        _clear(self.prefix)
        self.idx = -1
        self.f = None
        self.raw_bytes = 0
        self.count = 0
        self.paths = []
        self._open()

    def _open(self):
        if self.f:
            self.f.close()
        self.idx += 1
        path = f"{self.prefix}-{self.idx:05d}.jsonl.gz"
        self.paths.append(path)
        self.f = gzip.open(path, "wt", encoding="utf-8", compresslevel=6)
        self.raw_bytes = 0

    def write(self, obj):
        line = json.dumps(obj, ensure_ascii=False) + "\n"
        # 原始体积约为压缩体积 5~7 倍，按 5 倍保守切分
        if self.raw_bytes > config.SHARD_MAX_BYTES * 5:
            self._open()
        self.f.write(line)
        self.raw_bytes += len(line.encode("utf-8"))
        self.count += 1

    def close(self):
        if self.f:
            self.f.close()
            self.f = None
        return self.paths


def read_csv_shards(out_dir, name) -> pd.DataFrame:
    paths = sorted(glob.glob(os.path.join(out_dir, f"{name}-*.csv.gz")))
    return pd.concat([pd.read_csv(p, encoding="utf-8-sig", keep_default_na=False, na_values=[""]) for p in paths],
                     ignore_index=True)


def iter_jsonl_shards(out_dir, name):
    for p in sorted(glob.glob(os.path.join(out_dir, f"{name}-*.jsonl.gz"))):
        with gzip.open(p, "rt", encoding="utf-8") as f:
            for line in f:
                yield json.loads(line)
