"""e2e 测试公共：登录客户端与输出工具。"""
import http.cookiejar
import json
import time
import urllib.error
import urllib.request

BASE = "http://localhost:3000"
PW = "Ct@123456"


class Client:
    def __init__(self, login):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.call("POST", "/api/auth/login", {"login_name": login, "password": PW})
        self.name = login

    def call(self, method, path, data=None, expect=200, raw=False):
        req = urllib.request.Request(BASE + path, method=method,
                                     data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json"} if data is not None else {})
        try:
            r = self.op.open(req, timeout=600)
            code, body = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, body = e.code, e.read()
        if code != expect:
            raise AssertionError(f"{self.name} {method} {path} -> {code} {body[:300]!r} (expect {expect})")
        return body if raw else json.loads(body)


def ok(msg):
    print("  ✓", msg)


