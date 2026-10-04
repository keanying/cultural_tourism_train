"""SFT 训练集公共工具：严格格式组装、确定性切分、分片写出、元数据（评测真值）分离。

训练文件只包含 {"messages": [...]}（OpenAI / LLaMA-Factory / Swift / Axolotl 通用格式），
评测所需真值与溯源信息写入同名 *_meta 文件（按 id 对齐），不混入训练文本。
"""
import hashlib
import json
import os

from .. import config
from ..io_utils import JsonlShardWriter

THOUGHT_OPEN, THOUGHT_CLOSE = "<thought>", "</thought>"
ANSWER_OPEN, ANSWER_CLOSE = "<answer>", "</answer>"


def dumps(obj) -> str:
    """与客户样例一致的 JSON 风格（中文不转义，逗号/冒号后带空格）。"""
    return json.dumps(obj, ensure_ascii=False)


def assistant_content(thought_lines, answer: str) -> str:
    thought = "\n".join(thought_lines)
    return f"{THOUGHT_OPEN}\n{thought}\n{THOUGHT_CLOSE}\n{ANSWER_OPEN}\n{answer}\n{ANSWER_CLOSE}"


def make_sample(system: str, user_obj, thought_lines, answer: str):
    return {"messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": dumps(user_obj) if not isinstance(user_obj, str) else user_obj},
        {"role": "assistant", "content": assistant_content(thought_lines, answer)},
    ]}


def split_of(sample_id: str) -> str:
    h = int(hashlib.md5(sample_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    tr, va, _ = config.SPLIT
    return "train" if h < tr else ("val" if h < tr + va else "test")


class SftWriter:
    def __init__(self, task: str):
        self.task = task
        out = os.path.join(config.SFT_DIR, task)
        self.w = {s: JsonlShardWriter(out, f"{task}_{s}") for s in ("train", "val", "test")}
        self.meta = JsonlShardWriter(out, f"{task}_meta")
        self.counts = {"train": 0, "val": 0, "test": 0}
        self.n = 0

    def add(self, sample_id: str, sample: dict, meta: dict):
        sp = split_of(sample_id)
        self.w[sp].write(sample)
        self.meta.write({"id": sample_id, "split": sp, "index_in_split": self.counts[sp], **meta})
        self.counts[sp] += 1
        self.n += 1

    def close(self):
        files = {}
        for s, w in self.w.items():
            files[s] = [os.path.relpath(p, config.OUTPUT_DIR) for p in w.close()]
        files["meta"] = [os.path.relpath(p, config.OUTPUT_DIR) for p in self.meta.close()]
        return {"task": self.task, "counts": self.counts, "total": self.n, "files": files}


def fmt_money(x) -> str:
    """金额格式：整数不带小数，非整数保留 2 位。"""
    x = round(float(x), 2)
    return str(int(x)) if x == int(x) else f"{x:.2f}"


def num(x):
    """JSON 数值：整数输出 int，否则保留 2 位小数。"""
    x = round(float(x), 2)
    return int(x) if x == int(x) else x


def pct(x, digits=1) -> str:
    return f"{x * 100:.{digits}f}%"


def signed_pct(x, digits=1) -> str:
    return f"{'+' if x >= 0 else ''}{x * 100:.{digits}f}%"
