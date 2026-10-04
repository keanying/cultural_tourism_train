"""把 output/ 下的 gzip 分片合并解压为训练框架可直接读取的文件。

用法：python unpack.py [--out dist]
结果：
  dist/sft/<task>/train.jsonl | val.jsonl | test.jsonl | meta.jsonl
  dist/datasets/<name>.csv（UTF-8 with BOM）
"""
import argparse
import glob
import gzip
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))


def merge(pattern, dst, skip_header=False):
    files = sorted(glob.glob(pattern))
    if not files:
        return 0
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as out:
        for i, f in enumerate(files):
            with gzip.open(f, "rb") as g:
                if skip_header and i > 0:
                    g.readline()
                shutil.copyfileobj(g, out)
    return len(files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args()
    src = os.path.join(ROOT, "output")
    for task_dir in sorted(glob.glob(os.path.join(src, "sft", "*/"))):
        task = os.path.basename(task_dir.rstrip("/"))
        for split in ("train", "val", "test", "meta"):
            n = merge(os.path.join(task_dir, f"{task}_{split}-*.jsonl.gz"), os.path.join(a.out, "sft", task, f"{split}.jsonl"))
            if n:
                print(f"sft/{task}/{split}.jsonl <- {n} shards")
    for ds_dir in sorted(glob.glob(os.path.join(src, "datasets", "*/"))):
        name = os.path.basename(ds_dir.rstrip("/"))
        n = merge(os.path.join(ds_dir, f"{name}-*.csv.gz"), os.path.join(a.out, "datasets", f"{name}.csv"), skip_header=True)
        if n:
            print(f"datasets/{name}.csv <- {n} shards")


if __name__ == "__main__":
    main()
