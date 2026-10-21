"""标注平台接口端到端测试：需求员→管理员→标注员→审核员→交付。

用法：先启动页面（npm start），再运行 python web/scripts/e2e_api.py。
注意：会在数据库中创建测试项目与需求，请在测试环境运行。
"""
import json
import time

from e2e_api_client import Client, ok

req = Client("requester")
adm = Client("admin")
a1 = Client("annotator1")
a2 = Client("annotator2")
rv = Client("reviewer")
su = Client("superadmin")

print("权限")
a1.call("GET", "/api/sources", expect=403); ok("标注员不能访问原数据管理")
a1.call("GET", "/api/gen/tasks", expect=403); adm.call("GET", "/api/gen/assets", expect=403); ok("标注员/管理员不能访问数据资产 · AI 生成")
rv.call("GET", "/api/lbl/requirements", expect=403); ok("审核员不能访问需求区")
adm.call("GET", "/api/sources", expect=403); ok("管理员不能访问原数据管理")
req.call("GET", "/api/sources"); su.call("GET", "/api/sources"); ok("需求员/超管可访问原数据管理")
a1.call("POST", "/api/lbl/projects", {"project_name": "x"}, expect=403); ok("标注员不能建项目")

print("项目与需求")
pid = req.call("POST", "/api/lbl/projects", {"project_name": "E2E 测试项目", "project_desc": "自动化测试"})["project_id"]
rid = req.call("POST", "/api/lbl/requirements", {
    "project_id": pid, "requirement_name": "定价测试集+订单明细校验",
    "source_config": [{"source_code": "dynamic_pricing", "split_type": "test", "max_qty": 7000},
                      {"source_code": "visitor_consumption", "max_qty": 40}],
    "standard_content": "逐条检查数值计算与约束，必要时修正；无效数据剔除。抽检合格率≥98%。"})["requirement_id"]
ok(f"需求员发布需求 #{rid}")
a1.call("POST", f"/api/lbl/requirements/{rid}", {"action": "receive"}, expect=403); ok("标注员不能接收需求")
adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "dispatch"}, expect=409); ok("未接收不能下发")
adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "receive"}); ok("管理员接收")
t = time.time()
d = adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "dispatch"})
assert d["item_qty"] == 2991 + 40 and d["chunk_qty"] == 1, d  # test 切分共 2991 条
ok(f"下发：{d['item_qty']} 条 → {d['chunk_qty']} 块（{time.time() - t:.1f}s）")

# 大需求：验证 5000 条/块切分
rid2 = req.call("POST", "/api/lbl/requirements", {
    "project_id": pid, "requirement_name": "组合推荐全量校验", "source_config": [{"source_code": "combo_recommend", "max_qty": 12000}],
    "standard_content": "检查推荐是否符合画像与约束，话术是否与库存一致。"})["requirement_id"]
adm.call("POST", f"/api/lbl/requirements/{rid2}", {"action": "receive"})
t = time.time()
d2 = adm.call("POST", f"/api/lbl/requirements/{rid2}", {"action": "dispatch"})
assert d2 == {"ok": True, "item_qty": 12000, "chunk_qty": 3}, d2
det = adm.call("GET", f"/api/lbl/requirements/{rid2}")
assert [c["item_qty"] for c in det["chunks"]] == [5000, 5000, 2000]
ok(f"12000 条切分为 5000/5000/2000（{time.time() - t:.1f}s）")

print("标注")
pool = a1.call("GET", "/api/lbl/chunks?view=pool")["chunks"]
cid = next(c["chunk_id"] for c in pool if c["requirement_id"] == rid)
a1.call("POST", f"/api/lbl/chunks/{cid}", {"action": "claim"}); ok("标注员1认领分块")
a2.call("POST", f"/api/lbl/chunks/{cid}", {"action": "claim"}, expect=409); ok("已认领分块不能被二次认领")
a2.call("GET", f"/api/lbl/chunks/{cid}?mode=label", expect=403); ok("标注员2无权进入他人分块")
a1.call("POST", f"/api/lbl/chunks/{cid}", {"action": "release"}); ok("标注员1退回分块")
a2.call("POST", f"/api/lbl/chunks/{cid}", {"action": "claim"}); ok("标注员2重新认领")
lab = a2
items = lab.call("GET", f"/api/lbl/chunks/{cid}/items?mode=label&pageSize=100")["items"]
assert len(items) == 100
lab.call("POST", f"/api/lbl/chunks/{cid}", {"action": "submit"}, expect=409); ok("未标完不能提交")

# 第 1 条：改价格（违反限价）→ 校验失败；再合法修改 reason → 已修正
it = lab.call("GET", f"/api/lbl/items/{items[0]['item_id']}?mode=label")
c = it["content"]
a = c["assistant"]
ans = json.loads(a.split("<answer>\n")[1].split("\n</answer>")[0])
bad = dict(ans, suggested_price=999999)
bad_c = dict(c, assistant=a.replace(json.dumps(ans, ensure_ascii=False), json.dumps(bad, ensure_ascii=False)))
lab.call("PATCH", f"/api/lbl/items/{items[0]['item_id']}", {"mode": "label", "content": bad_c, "label_tag": 1}, expect=422); ok("违反限价的修改被拦截")
good = dict(ans, reason=ans["reason"] + "（人工复核）")
good_c = dict(c, assistant=a.replace(json.dumps(ans, ensure_ascii=False), json.dumps(good, ensure_ascii=False)))
r = lab.call("PATCH", f"/api/lbl/items/{items[0]['item_id']}", {"mode": "label", "content": good_c, "label_tag": 1})
assert r["label_tag"] == 2; ok("内容有改动自动记为“已修正”")
r = lab.call("PATCH", f"/api/lbl/items/{items[1]['item_id']}", {"mode": "label", "label_tag": 3}); assert r["label_tag"] == 3; ok("标为无效剔除")
# 明细数据条目：编码字段非法
dsi = lab.call("GET", f"/api/lbl/chunks/{cid}/items?mode=label&page=30&pageSize=100")["items"]
ds_item = next(x for x in dsi if x["source_code"] == "visitor_consumption")
it = lab.call("GET", f"/api/lbl/items/{ds_item['item_id']}?mode=label")
bad = dict(it["content"], order_status=9)
lab.call("PATCH", f"/api/lbl/items/{ds_item['item_id']}", {"mode": "label", "content": bad, "label_tag": 1}, expect=422); ok("明细数据非法编码被拦截")
mism = dict(it["content"], order_status=2)
lab.call("PATCH", f"/api/lbl/items/{ds_item['item_id']}", {"mode": "label", "content": mism, "label_tag": 1}, expect=422); ok("编码与名称不一致被拦截")
fix = dict(it["content"], order_status=2, order_status_name="已退款")
assert lab.call("PATCH", f"/api/lbl/items/{ds_item['item_id']}", {"mode": "label", "content": fix, "label_tag": 1})["label_tag"] == 2; ok("明细数据合法修正")
if not any(m["has_key"] for m in su.call("GET", "/api/gen/models")["models"]):
    lab.call("POST", f"/api/lbl/items/{items[2]['item_id']}/ai", expect=503); ok("未配置大模型时 AI 再标给出明确提示")

# 其余全部确认正确（直接调用接口批量）
t = time.time()
page = 1
while True:
    lst = lab.call("GET", f"/api/lbl/chunks/{cid}/items?mode=label&filter=unlabeled&pageSize=100")["items"]
    if not lst:
        break
    for x in lst:
        lab.call("PATCH", f"/api/lbl/items/{x['item_id']}", {"mode": "label", "label_tag": 1})
ok(f"批量标注完成（{time.time() - t:.1f}s）")
lab.call("POST", f"/api/lbl/chunks/{cid}", {"action": "submit"}); ok("提交审核")
lab.call("PATCH", f"/api/lbl/items/{items[3]['item_id']}", {"mode": "label", "label_tag": 1}, expect=403); ok("提交后标注员不能再改")

print("审核")
assert any(c["chunk_id"] == cid for c in rv.call("GET", "/api/lbl/chunks?view=review_pool")["chunks"])
s = rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_claim"})
assert s["sample_qty"] == max(50, -(-3031 * 5 // 100)); ok(f"领取审核，自动抽检 {s['sample_qty']} 条")
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_pass"}, expect=409); ok("抽检未审完不能通过")
samp = rv.call("GET", f"/api/lbl/chunks/{cid}/items?mode=review&filter=sampled&pageSize=100")["items"]
first = next(x for x in samp if x["item_id"] != items[0]["item_id"])  # 避开带人工修正的第 1 条，后面要校验它进入交付
it = rv.call("GET", f"/api/lbl/items/{first['item_id']}?mode=review")
rv.call("POST", "/api/lbl/comments", {"chunk_id": cid, "item_id": first["item_id"], "content": "这条理由描述不够具体"}); ok("条目级审核意见")
rv.call("PATCH", f"/api/lbl/items/{first['item_id']}", {"mode": "review", "review_result": 2, "label_tag": 3}); ok("不合格·剔除")
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_return", "comment": ""}, expect=400); ok("退回必须填写意见")
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_return", "comment": "第1条理由需补充，请返修"}); ok("退回返修")
mine = lab.call("GET", "/api/lbl/chunks?view=mine")["chunks"]
assert next(c for c in mine if c["chunk_id"] == cid)["chunk_status"] == 6; ok("标注员看到“审核退回·待返修”")
cm = lab.call("GET", f"/api/lbl/chunks/{cid}?mode=label")["comments"]
assert any("返修" in m["comment_content"] for m in cm); ok("标注员可见退回意见")
lab.call("POST", f"/api/lbl/chunks/{cid}", {"action": "submit"}); ok("返修后重新提交")
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_claim"})
while True:
    samp = rv.call("GET", f"/api/lbl/chunks/{cid}/items?mode=review&filter=unreviewed&pageSize=100")["items"]
    if not samp:
        break
    for x in samp:
        rv.call("PATCH", f"/api/lbl/items/{x['item_id']}", {"mode": "review", "review_result": 1})
rv.call("POST", f"/api/lbl/chunks/{cid}", {"action": "review_pass", "comment": "抽检合格"}); ok("抽检全部合格，审核通过")

print("交付")
req.call("GET", f"/api/lbl/requirements/{rid}/download?format=jsonl", expect=409, raw=True); ok("交付前不能下载")
adm.call("POST", f"/api/lbl/requirements/{rid2}", {"action": "deliver"}, expect=409); ok("有分块未通过的需求不能交付")
adm.call("POST", f"/api/lbl/requirements/{rid}", {"action": "deliver", "note": "E2E"}); ok("管理员交付")
dl = req.call("GET", "/api/lbl/requirements?area=delivery")["requirements"]
assert next(x for x in dl if x["requirement_id"] == rid)["requirement_status"] == 5; ok("需求员在交付区看到已交付")
jl = req.call("GET", f"/api/lbl/requirements/{rid}/download?format=jsonl", raw=True).decode().splitlines()
csv = req.call("GET", f"/api/lbl/requirements/{rid}/download?format=detail", raw=True).decode("utf-8-sig").splitlines()
dropped = 2  # items[1] 与审核剔除的一条（若恰为同一条则为 1）
assert len(csv) == 3031 + 1, len(csv)
assert 3031 - 2 <= len(jl) <= 3031 - 1, len(jl)
sft_lines = [json.loads(l) for l in jl if l.startswith('{"messages"')]
assert any("（人工复核）" in s["messages"][2]["content"] for s in sft_lines); ok(f"JSONL {len(jl)} 行（已剔除无效）含人工修正；明细 CSV {len(csv) - 1} 行")
assert any('"order_status": 2' in l and "已退款" in l for l in jl); ok("明细数据修正已进入交付文件")
req.call("POST", f"/api/lbl/requirements/{rid}", {"action": "confirm"}); ok("需求员确认交付")
assert req.call("GET", f"/api/lbl/requirements/{rid}")["requirement"]["requirement_status"] == 6
print("\n全部通过")
