"""大模型蒸馏/润色（可选）：用 OpenAI 或 DeepSeek（OpenAI 兼容接口）改写训练样本中的“自然语言部分”，
提升话术与解读的语言多样性；数字、商品名称、ID、JSON 结构由“事实锁”校验，校验失败自动回退规则版。

改写范围（结构化决策与思维链中的计算一律不交给大模型，避免引入计算错误）：
  combo_recommend   : <answer> 全文（推荐话术）
  dynamic_pricing   : answer.reason、answer.channel_strategy
  business_insight  : answer.summary、answer.recommendations[*]
  visitor_forecast / channel_placement：纯数值输出，不改写

用法：
  export LLM_PROVIDER=deepseek            # 或 openai
  export LLM_API_KEY=sk-xxx
  export LLM_MODEL=deepseek-chat          # openai 可用 gpt-4o-mini / gpt-4.1-mini 等
  python -m distill.llm_refine --task combo_recommend --ratio 0.2 --workers 16
结果覆盖写回 output/sft/<task>/ 下的分片，meta 中 source 字段标记 llm_refined / rule_engine。
调用结果缓存在 llm_cache/，中断后重跑会跳过已完成样本。
"""
import argparse
import glob
import hashlib
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from . import config
from .io_utils import JsonlShardWriter, iter_jsonl_shards
from .sft.common import ANSWER_CLOSE, ANSWER_OPEN

PROVIDERS = {
    "openai": {"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini"},
    "deepseek": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat"},
}

REWRITE_PROMPT = {
    "combo_recommend": (
        "你是资深文旅营销文案。请改写下面这段景区加购推荐话术，使其更自然、更有感染力、更口语化，"
        "可以调整句式和顺序，但必须：1) 原样保留产品名称「{name}」；2) 原样保留所有数字（价格、温度、年龄等）；"
        "3) 不得新增原文没有的权益、价格、优惠或承诺；4) 长度在80~220字；5) 只输出改写后的话术本身。\n原文：{text}"
    ),
    "pricing_reason": (
        "请把下面这段票价调整理由改写得更专业、精炼（收益管理分析师口吻），必须原样保留所有数字，"
        "不得新增原文没有的信息，40~120字，只输出改写结果。\n原文：{text}"
    ),
    "pricing_channel": (
        "请把下面这段渠道执行建议改写得更具体易执行，不得新增数字和原文没有的渠道，30~100字，只输出改写结果。\n原文：{text}"
    ),
    "insight_summary": (
        "请把下面这段景区经营数据解读改写为管理层汇报口吻，必须原样保留所有数字和百分比，不得新增数字或结论，"
        "60~200字，只输出改写结果。\n原文：{text}"
    ),
    "insight_rec": (
        "请把下面这条经营建议改写得更具体、可执行，必须原样保留其中的数字与渠道名称，不得新增数字，20~90字，只输出改写结果。\n原文：{text}"
    ),
}

_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def numbers(s):
    return set(_NUM_RE.findall(s))


def fact_lock(orig: str, new: str, must_keep=(), min_len=10, max_len=400) -> bool:
    """改写后：原文数字全部保留、不新增数字、必须保留指定片段、长度合规、不含格式标记。"""
    if not new or not (min_len <= len(new) <= max_len):
        return False
    if any(t in new for t in ("<thought>", "<answer>", "```", "原文")):
        return False
    if numbers(orig) - numbers(new):
        return False
    if numbers(new) - numbers(orig):
        return False
    return all(k in new for k in must_keep)


class LLM:
    def __init__(self):
        from openai import OpenAI
        provider = os.environ.get("LLM_PROVIDER", "deepseek").lower()
        conf = PROVIDERS.get(provider, PROVIDERS["deepseek"])
        key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            raise SystemExit("未配置 LLM_API_KEY，无法进行大模型润色（规则版训练集已可直接使用）。")
        self.client = OpenAI(api_key=key, base_url=os.environ.get("LLM_BASE_URL", conf["base_url"]))
        self.model = os.environ.get("LLM_MODEL", conf["model"])
        self.cache_dir = os.path.join(config.ROOT, "llm_cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        self.lock = threading.Lock()
        self.cache_path = os.path.join(self.cache_dir, f"{provider}_{self.model.replace('/', '_')}.jsonl")
        self.cache = {}
        if os.path.exists(self.cache_path):
            with open(self.cache_path, encoding="utf-8") as f:
                for line in f:
                    o = json.loads(line)
                    self.cache[o["k"]] = o["v"]

    def chat(self, prompt: str, temperature=0.9) -> str:
        k = hashlib.md5(f"{self.model}|{temperature}|{prompt}".encode()).hexdigest()
        if k in self.cache:
            return self.cache[k]
        for attempt in range(4):
            try:
                r = self.client.chat.completions.create(
                    model=self.model, temperature=temperature, max_tokens=600,
                    messages=[{"role": "user", "content": prompt}])
                out = (r.choices[0].message.content or "").strip()
                break
            except Exception as e:  # 网络/限流重试
                if attempt == 3:
                    print(f"[llm] failed: {e}")
                    return ""
                import time
                time.sleep(2 ** attempt * 2)
        with self.lock:
            self.cache[k] = out
            with open(self.cache_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"k": k, "v": out}, ensure_ascii=False) + "\n")
        return out


def _split_assistant(content: str):
    i = content.index(ANSWER_OPEN)
    j = content.rindex(ANSWER_CLOSE)
    return content[:i], content[i + len(ANSWER_OPEN):j].strip(), content[j:]


def refine_sample(llm: LLM, task: str, sample: dict, meta: dict):
    msg = sample["messages"][2]
    head, answer, tail = _split_assistant(msg["content"])
    changed = False
    if task == "combo_recommend":
        if not meta.get("gt_product_id"):
            return sample, False
        user = json.loads(sample["messages"][1]["content"])
        name = next(p["name"] for p in user["available_products"] if p["id"] == meta["gt_product_id"])
        new = llm.chat(REWRITE_PROMPT["combo_recommend"].format(name=name, text=answer))
        if fact_lock(answer, new, must_keep=[name], min_len=40, max_len=320):
            answer, changed = new, True
    elif task == "dynamic_pricing":
        obj = json.loads(answer)
        for field, key in (("reason", "pricing_reason"), ("channel_strategy", "pricing_channel")):
            new = llm.chat(REWRITE_PROMPT[key].format(text=obj[field]))
            if fact_lock(obj[field], new, min_len=15, max_len=200):
                obj[field], changed = new, True
        answer = json.dumps(obj, ensure_ascii=False)
    elif task == "business_insight":
        obj = json.loads(answer)
        new = llm.chat(REWRITE_PROMPT["insight_summary"].format(text=obj["summary"]))
        if fact_lock(obj["summary"], new, min_len=30, max_len=300):
            obj["summary"], changed = new, True
        recs = []
        for r in obj["recommendations"]:
            new = llm.chat(REWRITE_PROMPT["insight_rec"].format(text=r))
            chans = re.findall(r"携程|美团|飞猪|抖音团购|小红书|同程旅行|景区官网/小程序|线下窗口|旅行社分销", r)
            ok = fact_lock(r, new, must_keep=chans, min_len=10, max_len=150)
            recs.append(new if ok else r)
            changed |= ok
        obj["recommendations"] = recs
        answer = json.dumps(obj, ensure_ascii=False)
    else:
        return sample, False
    msg["content"] = f"{head}{ANSWER_OPEN}\n{answer}\n{tail}"
    return sample, changed


def run(task: str, ratio: float, workers: int):
    llm = LLM()
    d = os.path.join(config.SFT_DIR, task)
    metas = list(iter_jsonl_shards(d, f"{task}_meta"))
    pick = {m["id"] for m in metas if int(hashlib.md5(m["id"].encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < ratio}
    by_split = {}
    for m in metas:
        by_split.setdefault(m["split"], []).append(m)
    stats = {"selected": len(pick), "refined": 0}
    new_meta = []
    for split in ("train", "val", "test"):
        samples = list(iter_jsonl_shards(d, f"{task}_{split}"))
        ms = by_split.get(split, [])
        assert len(samples) == len(ms), f"{split}: samples/meta 数量不一致"

        def work(i):
            if ms[i]["id"] in pick:
                return refine_sample(llm, task, samples[i], ms[i])
            return samples[i], False
        with ThreadPoolExecutor(workers) as ex:
            results = list(ex.map(work, range(len(samples))))
        w = JsonlShardWriter(d, f"{task}_{split}")
        for (s, changed), m in zip(results, ms):
            if changed:
                m["source"] = f"llm_refined:{llm.model}"
                stats["refined"] += 1
            w.write(s)
            new_meta.append(m)
        w.close()
    w = JsonlShardWriter(d, f"{task}_meta")
    for m in sorted(new_meta, key=lambda x: x["id"]):
        w.write(m)
    w.close()
    print(f"[llm_refine] {task}: {stats}")
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, choices=["combo_recommend", "dynamic_pricing", "business_insight"])
    ap.add_argument("--ratio", type=float, default=0.2, help="参与改写的样本比例")
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args()
    run(a.task, a.ratio, a.workers)


if __name__ == "__main__":
    main()
