# -*- coding: utf-8 -*-
"""本地模拟的 OpenAI 兼容大模型服务，用于 AI 生成板块的端到端测试（不消耗真实 token）。
支持 /v1/chat/completions 与 /v1/responses；模型编码为 resp-only 时对话接口返回 404（测试协议自动探测）。
按提示词内容返回对应规格的 JSON：客服会话明细 / 讲解评价明细 / 个性化讲解明细 / 三类预标注 / AI 再标。
用法：python web/scripts/mock_llm.py [端口，默认 18080]
"""
import itertools
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEQ = itertools.count(1)
FAIL_ONCE = {"done": False}


def kefu_conv(n):
    k = next(SEQ)
    turns = []
    for t in range(n):
        q = "第%d号游客问题%d：门票多少钱，小孩要不要票" % (k, t + 1) if t == 0 else "那个第%d轮呢" % (t + 1)
        turns.append({"question": q, "thought": {"意图1": {"名称": "票务政策", "槽位": {"ticket_type": "儿童票", "query_demand": "是否收费"}}},
                      "reply": "身高 1.2 米以下儿童免票，1.2~1.5 米购买半价票 60 元，入园需携带有效证件。", "emotion": "平和"})
    return {"category": "票务", "sub_scene": "优惠免票政策", "shape": "多轮·连续追问", "scene_desc": "带孩子周末来玩",
            "visitor_tag": "亲子", "difficulty": "easy", "turn_count": n, "turns": turns}


def answer(system, user, model):
    if "健康检查" in system:
        return "正常"
    if "严谨的数据标注专家" in system:
        data = user.split("【待标注数据】", 1)[1].strip()
        obj = json.loads(data)
        if "record" in obj and "field_comments" in obj:
            return json.dumps({"record": obj["record"], "reason": "模拟：字段检查无误"}, ensure_ascii=False)
        if "assistant" in obj:
            return json.dumps({"assistant": obj["assistant"], "reason": "模拟：样本正确"}, ensure_ascii=False)
        obj["turns"][0]["reply"] = "【AI再标】" + obj["turns"][0].get("reply", "")
        return json.dumps({"record": obj, "reason": "模拟：润色首轮回复"}, ensure_ascii=False)
    m = re.search(r"请生成 (\d+) ", user)
    n = int(m.group(1)) if m else 1
    if "景区客服多轮会话" in system:
        return json.dumps([kefu_conv(1 + (i % 3)) for i in range(n)], ensure_ascii=False)
    if "讲解评价模型提供" in system or "官方知识库片段 + 待评价讲解内容" in system:
        out = []
        for _ in range(n):
            k = next(SEQ)
            out.append({"scenic_name": "故宫博物院", "sub_spot": "子景点%d" % k, "topic": "历史沿革", "error_mode": "fact_error", "turn_count": 1,
                        "turns": [{"kb_facts": ["建于明永乐十八年", "面阔十一间"], "kb_text": "太和殿建于明永乐十八年，面阔十一间。",
                                   "guide_text": "太和殿建于清代%d年。" % k, "error_points": ["年代错误"]}]})
        return json.dumps(out, ensure_ascii=False)
    if "景点知识要点 + 游客画像" in system:
        out = []
        for _ in range(n):
            k = next(SEQ)
            out.append({"scenic_name": "黄山风景区", "sub_spot": "迎客松%d" % k, "topic": "自然地质", "turn_count": 1,
                        "turns": [{"profile": "广东，女性，30岁，亲子游，150字以内 #%d" % k, "kb_facts": ["树龄约1300年"], "highlights": ["伸出的枝干"], "risk_notes": "注意脚下台阶"}]})
        return json.dumps(out, ensure_ascii=False)
    if "训练样本预标注专家" in system:
        q = re.search(r"用户问题：(.*)", user)
        return "```json\n" + json.dumps({"thought": {"意图1": {"名称": "票务政策", "槽位": {"ticket_type": "儿童票", "query_demand": (q.group(1) if q else "")[:20]}}},
                                         "reply": "预标注回复：儿童 1.2 米以下免票。"}, ensure_ascii=False) + "\n```"
    if "讲解内容评价模型的预标注专家" in system:
        return json.dumps({"thought": {"评价维度": ["fact_accuracy"], "槽位": {"fact_check_result": "incorrect"}, "逻辑推导": "年代与知识库不符"},
                           "score": 2, "comment": "讲解中年代错误，太和殿建于明永乐十八年。建议核对知识库后再讲解。"}, ensure_ascii=False)
    if "个性化讲解模型的预标注专家" in system:
        return json.dumps({"persona": "你是【黄山-迎客松】专属AI金牌讲解员", "think": "1. 用户画像分析\n2. 知识点筛选\n3. 风格规划",
                           "content": "小朋友们看，这棵迎客松已经一千三百岁啦！"}, ensure_ascii=False)
    return "{}"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.headers.get("Authorization") != "Bearer test-key":
            return self._send(401, {"error": {"message": "invalid api key"}})
        model = req.get("model", "")
        if model == "flaky" and not FAIL_ONCE["done"]:
            FAIL_ONCE["done"] = True
            return self._send(429, {"error": {"message": "rate limited"}})
        if self.path.endswith("/chat/completions"):
            if model == "resp-only":
                return self._send(404, {"error": {"message": "model not found"}})
            msgs = req["messages"]
            text = answer(msgs[0]["content"], msgs[1]["content"], model)
            return self._send(200, {"choices": [{"message": {"role": "assistant", "content": text}}], "usage": {"prompt_tokens": 100, "completion_tokens": 50}})
        if self.path.endswith("/responses"):
            items = req["input"]
            sys_t = items[0]["content"][0]["text"] if len(items) > 1 else ""
            user_t = items[-1]["content"][0]["text"]
            text = answer(sys_t, user_t, model)
            return self._send(200, {"output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}], "usage": {"input_tokens": 80, "output_tokens": 40}})
        self._send(404, {"error": {"message": "not found"}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
    print("mock llm on", port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
