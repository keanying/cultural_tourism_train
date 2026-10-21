"""数据资产 · AI 生成板块端到端测试：模型配置 → 明细生成 → AI 预标注 → 发布需求 → 标注（含 AI 再标）→ 审核 → 交付
→ 基于交付结果再预标注；以及去重、停止续跑、协议自动探测、限流重试、权限与删除保护。

用法：先启动页面（npm start）与模拟大模型（python web/scripts/mock_llm.py 18080），再运行 python web/scripts/e2e_gen.py。
注意：会修改模型配置并创建测试数据，请在测试环境运行。
"""
import json
import time

from e2e_api_client import Client, ok

MOCK = "http://127.0.0.1:18080/v1"
su = Client("superadmin")
req = Client("requester")
adm = Client("admin")
a1 = Client("annotator1")
rv = Client("reviewer")


def wait(tid, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = req.call("GET", f"/api/gen/tasks/{tid}")
        if not d["task"]["running"] and d["task"]["task_status"] != 2:
            return d
        time.sleep(0.5)
    raise AssertionError("任务超时")


print("权限")
a1.call("GET", "/api/gen/tasks", expect=403)
adm.call("GET", "/api/gen/specs", expect=403)
rv.call("GET", "/api/gen/assets", expect=403); ok("标注员/管理员/审核员不能访问数据资产")
specs = {s["spec_code"]: s for s in req.call("GET", "/api/gen/specs")["specs"]}
assert {"kefu_detail", "kefu_sft", "eval_detail", "eval_sft", "narr_detail", "narr_sft"} <= set(specs); ok("预置 6 个数据规格（来自 Lumos）")
prompts = {p["spec_code"]: p for p in req.call("GET", "/api/gen/prompts")["prompts"]}
dicts = {d["dict_code"] for d in req.call("GET", "/api/gen/dicts")["dicts"]}
assert {"intents", "slots", "categories", "dialog_shapes"} <= dicts; ok("预置提示词与业务字典")

print("模型")
models = req.call("GET", "/api/gen/models")["models"]
mid = next(m["model_id"] for m in models if m["is_default"])
req.call("PATCH", f"/api/gen/models/{mid}", {"base_url": MOCK, "model_code": "mock-chat", "api_key_value": "test-key", "api_style_type": "auto", "timeout_sec_qty": 30})
m = next(m for m in req.call("GET", "/api/gen/models")["models"] if m["model_id"] == mid)
assert m["has_key"] and "test-key" not in json.dumps(m) and m["api_key_mask"].startswith("tes"); ok("API Key 只返回掩码")
r = req.call("POST", f"/api/gen/models/{mid}/test", {})
assert r["reply"] == "正常" and r["style"] == "chat"; ok(f"连通性测试：{r}")
rid_resp = req.call("POST", "/api/gen/models", {"model_name": "仅 Responses 接口", "base_url": MOCK + "/chat/completions", "model_code": "resp-only", "api_key_value": "test-key"})["model_id"]
r = req.call("POST", f"/api/gen/models/{rid_resp}/test", {})
assert r["style"] == "responses"; ok("auto 协议：对话接口 404 自动切换 Responses 接口（并容错粘贴完整接口地址）")
bad = req.call("POST", "/api/gen/models", {"model_name": "错误Key", "base_url": MOCK, "model_code": "x", "api_key_value": "wrong"})["model_id"]
req.call("POST", f"/api/gen/models/{bad}/test", {}, expect=502); ok("错误 Key 给出明确报错")
flaky = req.call("POST", "/api/gen/models", {"model_name": "限流一次", "base_url": MOCK, "model_code": "flaky", "api_key_value": "test-key"})["model_id"]
print("明细生成")
tid = req.call("POST", "/api/gen/tasks", {"spec_code": "kefu_detail", "model_id": mid, "prompt_id": prompts["kefu_detail"]["prompt_id"],
                                         "target_qty": 12, "batch_qty": 5, "concurrency_qty": 3, "autostart": True,
                                         "params": {"filters": {"category": ["票务"]}}})["task_id"]
d = wait(tid)
t = d["task"]
assert t["task_status"] == 3 and t["done_unit_qty"] == 12, t
detail_asset = t["asset_id"]
a = req.call("GET", f"/api/gen/assets/{detail_asset}?pageSize=50")
assert a["asset"]["unit_qty"] == 12 and a["asset"]["asset_status"] == 2 and a["total"] == 12
assert a["asset"]["prompt_version_no"] == prompts["kefu_detail"]["version_no"]
assert all(c["payload"]["category"] == "票务" for c in a["convs"]); ok(f"生成 12 段会话（{a['asset']['pair_qty']} 对问答），不超目标、维度筛选生效、固化当前提示词版本")
assert a["convs"][0]["conversation_id"] == "C00001"; ok("会话编号 C00001 起顺序分配")
csv = req.call("GET", f"/api/gen/assets/{detail_asset}/export?format=csv", raw=True).decode("utf-8-sig").splitlines()
assert csv[0].startswith("会话ID,轮次") and csv[1].startswith("conversation_id,turn_no") and len(csv) == 2 + a["asset"]["pair_qty"]; ok("明细 CSV 导出（Lumos 格式）")

print("限流重试")
tid_f = req.call("POST", "/api/gen/tasks", {"spec_code": "eval_detail", "model_id": flaky, "prompt_id": prompts["eval_detail"]["prompt_id"],
                                           "target_qty": 3, "batch_qty": 3, "concurrency_qty": 1, "autostart": True})["task_id"]
d = wait(tid_f)
assert d["task"]["task_status"] == 3 and d["task"]["done_unit_qty"] == 3 and d["task"]["fail_qty"] == 0, d["task"]; ok("429 限流后自动退避重试成功")

print("停止与续跑")
tid2 = req.call("POST", "/api/gen/tasks", {"spec_code": "narr_detail", "model_id": mid, "prompt_id": prompts["narr_detail"]["prompt_id"],
                                          "target_qty": 400, "batch_qty": 1, "concurrency_qty": 1, "autostart": True})["task_id"]
time.sleep(0.3)
req.call("POST", f"/api/gen/tasks/{tid2}", {"action": "cancel"})
d = wait(tid2)
n1 = d["task"]["done_unit_qty"]
assert d["task"]["task_status"] == 5 and n1 < 400; ok(f"停止任务（已产出 {n1} 段）")
req.call("POST", f"/api/gen/tasks/{tid2}", {"action": "start"})
time.sleep(0.5)
req.call("POST", f"/api/gen/tasks/{tid2}", {"action": "cancel"})
d = wait(tid2)
a2 = req.call("GET", f"/api/gen/assets/{d['task']['asset_id']}")
assert d["task"]["done_unit_qty"] >= n1 and a2["asset"]["unit_qty"] == d["task"]["done_unit_qty"]; ok(f"继续执行在原资产上累计（{d['task']['done_unit_qty']} 段）")
req.call("DELETE", f"/api/gen/tasks/{tid2}"); ok("删除任务（资产保留）")
req.call("GET", f"/api/gen/assets/{d['task']['asset_id']}")

print("AI 预标注")
req.call("POST", "/api/gen/tasks", {"spec_code": "kefu_sft", "model_id": mid, "prompt_id": prompts["kefu_sft"]["prompt_id"], "source_asset_id": 0, "target_qty": 5}, expect=400); ok("预标注必须选择来源明细资产")
tid3 = req.call("POST", "/api/gen/tasks", {"spec_code": "kefu_sft", "model_id": mid, "prompt_id": prompts["kefu_sft"]["prompt_id"],
                                          "source_asset_id": detail_asset, "target_qty": 100, "concurrency_qty": 4, "autostart": True})["task_id"]
d = wait(tid3)
assert d["task"]["task_status"] == 3 and d["task"]["done_unit_qty"] == 12, d["task"]
sft_asset = d["task"]["asset_id"]
s = req.call("GET", f"/api/gen/assets/{sft_asset}?pageSize=50")
pairs = sum(c["turn_qty"] for c in s["convs"])
assert s["asset"]["pair_qty"] == pairs and s["invalid"] == 0
multi = next(c for c in s["convs"] if c["turn_qty"] > 1)
smp = multi["samples"][1]["content"]
assert smp["sample_id"] == f"scenic_slot_{multi['conversation_id']}_t2"
assert "历史对话：\n用户：" in smp["messages"][1]["content"] and smp["messages"][2]["content"].startswith("<thought>{")
ok(f"12 段会话 → {pairs} 条样本；多轮样本带历史对话，sample_id 按模板")
jl = req.call("GET", f"/api/gen/assets/{sft_asset}/export?format=jsonl", raw=True).decode().splitlines()
assert len(jl) == pairs and list(json.loads(jl[0])) == ["sample_id", "conversation_id", "messages"]; ok("训练集 JSONL 导出（Lumos 格式）")
req.call("GET", f"/api/gen/assets/{sft_asset}/export?format=csv", expect=400, raw=True)

print("发布需求 → 下发")
srcs = {x["name"]: x for x in req.call("GET", "/api/lbl/sources")["sources"]}
assert f"gen_asset_{sft_asset}" in srcs and srcs[f"gen_asset_{sft_asset}"]["group"] == "AI 生成资产"; ok("生成资产出现在需求区数据源（分组：AI 生成资产）")
pid = req.call("POST", "/api/lbl/projects", {"project_name": "AI 生成数据审核", "project_desc": "E2E"})["project_id"]
rid = req.call("POST", "/api/lbl/requirements", {
    "project_id": pid, "requirement_name": "客服会话与训练集人工审核",
    "source_config": [{"source_code": f"gen_asset_{detail_asset}"}, {"source_code": f"gen_asset_{sft_asset}"}, {"source_code": "dynamic_pricing", "split_type": "test", "max_qty": 3}],
    "standard_content": "检查意图与槽位是否正确、回复是否符合景区政策，必要时修正；无意义会话剔除。"})["requirement_id"]
adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "receive"})
d = adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "dispatch"})
assert d["item_qty"] == 12 + 12 + 3 and d["chunk_qty"] == 1, d; ok("混合下发：明细会话 12 + 训练集会话 12 + 蒸馏训练集 3")
req.call("DELETE", f"/api/gen/assets/{sft_asset}", expect=409); ok("被需求引用的资产不能删除")

print("标注")
cid = next(c["chunk_id"] for c in a1.call("GET", "/api/lbl/chunks?view=pool")["chunks"] if c["requirement_id"] == rid)
a1.call("POST", f"/api/lbl/chunks/{cid}", {"action": "claim"})
items = a1.call("GET", f"/api/lbl/chunks/{cid}/items?mode=label&pageSize=100")["items"]
det_items = [x for x in items if x["source_code"] == f"gen_asset_{detail_asset}"]
sft_items = [x for x in items if x["source_code"] == f"gen_asset_{sft_asset}"]
assert len(det_items) == 12 and len(sft_items) == 12 and det_items[0]["preview"].startswith("C00001"); ok("条目列表含会话预览")
# 明细会话：改问题；改会话编号被拦截
it = a1.call("GET", f"/api/lbl/items/{det_items[0]['item_id']}?mode=label")
assert it["gen"]["kind"] == "detail" and it["source"]["kind"] == "gen"
c = it["content"]
a1.call("PATCH", f"/api/lbl/items/{det_items[0]['item_id']}", {"mode": "label", "content": dict(c, conversation_id="X1"), "label_tag": 1}, expect=422); ok("会话编号不能修改")
a1.call("PATCH", f"/api/lbl/items/{det_items[0]['item_id']}", {"mode": "label", "content": dict(c, turns=[]), "label_tag": 1}, expect=422); ok("空会话被拦截")
c2 = json.loads(json.dumps(c)); c2["turns"][0]["question"] = "【人工修正】儿童票怎么买"
assert a1.call("PATCH", f"/api/lbl/items/{det_items[0]['item_id']}", {"mode": "label", "content": c2, "label_tag": 1})["label_tag"] == 2; ok("明细会话人工修正 → 已修正")
fixed_conv = c2["conversation_id"]
# 训练集会话：改 AI 字段；违反规格校验被拦截；改问题后历史对话重建
sid = next(x for x in sft_items if x["preview"].startswith(multi["conversation_id"]))["item_id"]
it = a1.call("GET", f"/api/lbl/items/{sid}?mode=label")
assert it["gen"]["kind"] == "sft" and len(it["content"]["labels"]) == multi["turn_qty"] and len(it["gen"]["jobVars"]) == multi["turn_qty"]
c = it["content"]
bad = json.loads(json.dumps(c)); bad["labels"][0]["thought"] = {}
a1.call("PATCH", f"/api/lbl/items/{sid}", {"mode": "label", "content": bad, "label_tag": 1}, expect=422); ok("思维链缺少意图1被规格校验拦截")
bad = json.loads(json.dumps(c)); bad["labels"].pop()
a1.call("PATCH", f"/api/lbl/items/{sid}", {"mode": "label", "content": bad, "label_tag": 1}, expect=422); ok("轮次数不能增减")
good = json.loads(json.dumps(c)); good["labels"][0]["reply"] = "【人工修正】1.2 米以下儿童免票。"; good["conversation"]["turns"][0]["question"] = "【人工改问】小孩要票吗"
assert a1.call("PATCH", f"/api/lbl/items/{sid}", {"mode": "label", "content": good, "label_tag": 1})["label_tag"] == 2; ok("训练集会话修正 AI 字段与问题 → 已修正")
# AI 再标：沿用生成时的模型与提示词版本
r = a1.call("POST", f"/api/lbl/items/{sft_items[0]['item_id']}/ai", {})
assert r["errors"] == [] and "v1" in r["reason"] and r["content"]["labels"][0]["reply"].startswith("预标注回复"); ok(f"训练集 AI 再标：{r['reason']}")
r = a1.call("POST", f"/api/lbl/items/{det_items[1]['item_id']}/ai", {})
assert r["errors"] == [] and r["content"]["turns"][0]["reply"].startswith("【AI再标】"); ok(f"明细 AI 再标：{r['reason']}")
a1.call("PATCH", f"/api/lbl/items/{det_items[1]['item_id']}", {"mode": "label", "content": r["content"], "label_tag": 1, "ai": True})
a1.call("PATCH", f"/api/lbl/items/{det_items[2]['item_id']}", {"mode": "label", "label_tag": 3}); ok("标为无效剔除")
dropped_conv = a1.call("GET", f"/api/lbl/items/{det_items[2]['item_id']}?mode=label")["content"]["conversation_id"]
r = a1.call("POST", f"/api/lbl/items/{[x for x in items if x['source_code'] == 'dynamic_pricing'][0]['item_id']}/ai", {})
assert r["errors"] == []; ok("蒸馏数据 AI 再标改用「模型管理」中的默认模型")
for x in a1.call("GET", f"/api/lbl/chunks/{cid}/items?mode=label&filter=unlabeled&pageSize=100")["items"]:
    a1.call("PATCH", f"/api/lbl/items/{x['item_id']}", {"mode": "label", "label_tag": 1})
a1.call("POST", f"/api/lbl/chunks/{cid}", {"action": "submit"}); ok("提交审核")

print("审核 → 交付")
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_claim"})
for x in rv.call("GET", f"/api/lbl/chunks/{cid}/items?mode=review&filter=unreviewed&pageSize=100")["items"]:
    rv.call("PATCH", f"/api/lbl/items/{x['item_id']}", {"mode": "review", "review_result": 1})
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_pass"})
adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "deliver"})
jl = [json.loads(l) for l in req.call("GET", f"/api/lbl/requirements/{rid}/download?format=jsonl", raw=True).decode().splitlines()]
det_lines = [x for x in jl if "turns" in x]
sft_lines = [x for x in jl if "sample_id" in x]
assert len(det_lines) == 11 and dropped_conv not in [x["conversation_id"] for x in det_lines]; ok("明细会话 11 段（剔除 1 段）")
assert any(x["turns"][0]["question"] == "【人工修正】儿童票怎么买" for x in det_lines); ok("明细人工修正进入交付")
assert len(sft_lines) == pairs
mine = [x for x in sft_lines if x["conversation_id"] == multi["conversation_id"]]
assert mine[0]["messages"][2]["content"].endswith("【人工修正】1.2 米以下儿童免票。") and "【人工改问】小孩要票吗" in mine[0]["messages"][1]["content"]
assert "用户：【人工改问】小孩要票吗\n客服：【人工修正】1.2 米以下儿童免票。" in mine[1]["messages"][1]["content"]; ok("训练集按规格模板重新组装：修正进入样本，后续轮次的历史对话同步更新")
assert sum(1 for x in jl if list(x) == ["messages"]) == 3; ok(f"交付 JSONL 共 {len(jl)} 行（明细/生成训练集/蒸馏训练集混合）")
req.call("POST", f"/api/lbl/requirements/{rid}", {"action": "confirm"})

print("基于交付结果再预标注")
tid4 = req.call("POST", "/api/gen/tasks", {"spec_code": "kefu_sft", "model_id": mid, "prompt_id": prompts["kefu_sft"]["prompt_id"], "source_asset_id": detail_asset,
                                          "target_qty": 100, "autostart": True, "params": {"source_scope": "delivered"}})["task_id"]
d = wait(tid4)
assert d["task"]["done_unit_qty"] == 11, d["task"]
s4 = req.call("GET", f"/api/gen/assets/{d['task']['asset_id']}?pageSize=50&q={fixed_conv}")
assert s4["convs"][0]["payload"]["turns"][0]["question"] == "【人工修正】儿童票怎么买"; ok("来源范围=已交付：使用人工审核后的会话、跳过剔除的会话")

print("提示词版本")
pk = prompts["kefu_detail"]["prompt_id"]
v = req.call("PATCH", f"/api/gen/prompts/{pk}", {"user_prompt_text": prompts["kefu_detail"]["user_prompt_text"] + "\n（测试修改）", "note_desc": "E2E"})
assert v["changed"] and v["version_no"] == prompts["kefu_detail"]["version_no"] + 1
vers = req.call("GET", f"/api/gen/prompts/{pk}")["versions"]
assert vers[0]["version_no"] == v["version_no"]
req.call("PATCH", f"/api/gen/prompts/{pk}", {"restore_version": v["version_no"] - 1})
assert req.call("GET", f"/api/gen/prompts/{pk}")["prompt"]["user_prompt_text"] == prompts["kefu_detail"]["user_prompt_text"]; ok("修改提示词自动留版本，可恢复历史版本")
req.call("DELETE", f"/api/gen/prompts/{pk}", expect=409); ok("已被任务使用的提示词不能删除")
print("\n全部通过")
