# -*- coding: utf-8 -*-
"""对拍：lib/tpl.ts 与 Lumos engine.py 在同一批输入上的渲染/维度/校验/组装结果必须完全一致。
用法：python web/scripts/check_tpl_parity.py /path/to/labelumos
"""
import json
import os
import subprocess
import sys
import types

LUMOS = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../labelumos")
HERE = os.path.dirname(os.path.abspath(__file__))
SEED = json.load(open(os.path.join(HERE, "..", "lib", "gen_seed.json"), encoding="utf-8"))
DICTS = {d["code"]: d["value"] for d in SEED["dicts"]}

sys.modules["requests"] = types.ModuleType("requests")
sys.path.insert(0, LUMOS)
import db  # noqa: E402
import engine  # noqa: E402

db.get_kv = lambda key, default=None: DICTS.get(key, default)
DV = {}
for k, v in DICTS.items():  # 与 engine.dict_vars 相同逻辑，但数据来自种子
    if isinstance(v, list):
        DV["dict_" + k] = "\n".join(
            "- " + " | ".join(str(x) for x in it.values() if not isinstance(x, (list, dict))) if isinstance(it, dict) else "- " + str(it)
            for it in v)
    else:
        DV["dict_" + k] = engine._text(v)
engine.dict_vars = lambda: dict(DV)
SPECS = {s["code"]: s["config"] for s in SEED["specs"]}

renders = [
    ("a{{x}}b{{y|json}}c", {"x": 1, "y": {"k": [1, "二", None, True]}}),
    ("{{#h}}历史：{{h}}\n{{/h}}{{^h}}无历史{{/h}}当前{{q}}", {"h": "", "q": "门票多少钱"}),
    ("{{#h}}历史：{{h}}\n{{/h}}{{^h}}无历史{{/h}}当前{{q}}", {"h": "用户：你好", "q": "x"}),
    ("{{#a}}{{#b}}AB{{/b}}{{/a}}|{{missing}}|{{t}}|{{f}}|{{n}}", {"a": [1], "b": {"k": 1}, "t": True, "f": False, "n": 2.5}),
    ("{{#z}}zero{{/z}}{{^e}}empty{{/e}}{{lst}}", {"z": 0, "e": [], "lst": ["a", 1]}),
]
dims = []
for code in ("kefu_detail", "eval_detail"):
    for i in range(30):
        dims.append((SPECS[code]["dimensions"], i, {}))
dims.append((SPECS["kefu_detail"]["dimensions"], 7, {"category": ["交通", "设施"], "shape": ["单轮会话"]}))

thought = {"意图1": {"名称": "门票预订", "槽位": {"ticket_type": "成人票", "query_demand": "价格"}}}
kefu_payload = {"conversation_id": "C00012", "category": "票务", "shape": "多轮·连续追问", "turn_count": 3, "turns": [
    {"question": "门票多少钱", "thought": thought, "reply": "成人票 120 元", "emotion": "平和"},
    {"question": "小孩呢", "thought": thought, "reply": "1.2 米以下免票", "emotion": "平和"},
    {"question": "那个能退吗", "thought": {}, "reply": "", "emotion": "着急"}]}
kefu_labels = [{"thought": thought, "reply": "成人票 120 元，学生半价。"}, {"thought": thought, "reply": "1.2 米以下免票"}, {"thought": {}, "reply": ""}]
eval_payload = {"conversation_id": "C00003", "scenic_name": "故宫博物院", "turns": [{"kb_text": "太和殿建于明永乐十八年", "guide_text": "太和殿建于清代"}]}
narr_payload = {"conversation_id": "C00007", "scenic_name": "黄山风景区", "sub_spot": "迎客松", "turns": [{"profile": "广东，女性，30岁，亲子游，150字以内", "kb_facts": ["a", "b"]}]}
convs = [
    ("kefu_sft", kefu_payload, kefu_labels, [{"turn_index": i + 1, "turn_total": 3} for i in range(3)]),
    ("eval_sft", eval_payload, [{"thought": {"槽位": {"fact_check_result": "incorrect"}}, "score": "2", "comment": "年代错误"}], [{"turn_index": 1, "turn_total": 1}]),
    ("eval_sft", eval_payload, [{"thought": {"槽位": {}}, "score": 7, "comment": "x"}], [{"turn_index": 1, "turn_total": 1}]),
    ("narr_sft", narr_payload, [{"persona": "你是讲解员", "think": "1. 分析", "content": "迎客松" * 60}], [{"turn_index": 1, "turn_total": 1}]),
    ("narr_sft", narr_payload, [{"persona": "你是讲解员", "think": "", "content": "短"}], [{"turn_index": 1, "turn_total": 1}]),
]


def py_conv(code, payload, labels, jvars):
    cfg = SPECS[code]
    exp = cfg.get("expand") or {}
    hist, out = [], []
    for i, f in enumerate(labels):
        turn = payload["turns"][i]
        jv = dict(jvars[i])
        jv[exp.get("history_var") or "history"] = (exp.get("history_join") or "\n").join(hist)
        s, ok, reason = engine.assemble(cfg, f, payload, turn, jv, payload["conversation_id"])
        out.append(dict(s, valid=ok, reason=reason))
        if exp.get("history_template"):
            hist.append(engine.render(exp["history_template"], dict(turn, **f)))
    return out


fixture = {"renders": renders, "dims": dims, "convs": convs, "dicts": DICTS, "specs": SPECS}
expect = {
    "renders": [engine.render(t, c) for t, c in renders],
    "dims": [engine.resolve_dimensions(d, i, f) for d, i, f in dims],
    "convs": [py_conv(*c) for c in convs],
    "dictvars": DV,
}
runner = r"""
import * as t from "%s";
import fs from "node:fs";
const fx = JSON.parse(fs.readFileSync(0, "utf8"));
const dv = t.dictVars(fx.dicts);
process.stdout.write(JSON.stringify({
  renders: fx.renders.map(([s, c]) => t.render(s, c)),
  dims: fx.dims.map(([d, i, f]) => t.resolveDimensions(d, i, fx.dicts, f)),
  convs: fx.convs.map(([code, p, l, j]) => t.assembleConversation(fx.specs[code], p, l, j, dv)),
  dictvars: dv,
}));
""" % os.path.join(HERE, "..", "lib", "tpl.ts").replace("\\", "/")
mjs = os.path.join(HERE, ".parity_runner.mts")
open(mjs, "w").write(runner)
try:
    res = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", mjs], input=json.dumps(fixture, ensure_ascii=False),
                         capture_output=True, text=True, encoding="utf-8")
finally:
    os.remove(mjs)
if res.returncode:
    print(res.stderr)
    sys.exit(1)
got = json.loads(res.stdout)
bad = 0
for k in expect:
    e = json.loads(json.dumps(expect[k], ensure_ascii=False))
    for i, (a, b) in enumerate(zip(e, got[k]) if isinstance(e, list) else [(e, got[k])]):
        if a != b:
            bad += 1
            print("MISMATCH", k, i, "\n  py:", json.dumps(a, ensure_ascii=False)[:600], "\n  ts:", json.dumps(b, ensure_ascii=False)[:600])
    if isinstance(e, list) and len(e) != len(got[k]):
        bad += 1
        print("LEN MISMATCH", k)
n = sum(len(v) if isinstance(v, list) else 1 for v in expect.values())
for c in expect["convs"]: print([(s["sample_id"], s["valid"], s["reason"]) for s in c])
print("parity: %d checks, %d mismatches" % (n, bad))
sys.exit(1 if bad else 0)
