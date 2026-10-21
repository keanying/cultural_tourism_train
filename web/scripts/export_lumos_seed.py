# -*- coding: utf-8 -*-
"""从 Lumos（labelumos）的 seeds.py 导出 AI 生成板块的预置内容：数据规格、提示词、业务字典。
用法：python web/scripts/export_lumos_seed.py /path/to/labelumos  -> web/lib/gen_seed.json
"""
import importlib.util
import json
import os
import sys
import types

src = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "../labelumos")
# seeds.py 依赖 auth/db，只读取常量，用空模块占位
for name in ("auth", "db"):
    sys.modules[name] = types.ModuleType(name)
spec = importlib.util.spec_from_file_location("lumos_seeds", os.path.join(src, "seeds.py"))
seeds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seeds)

out = {
    "specs": [
        {"code": s["code"], "name": s["name"], "kind": s["kind"], "task_type": s["task_type"],
         "source_code": s["source_code"], "tags": s["tags"], "config": s["config"],
         "remark": s["remark"], "sort": s["sort"]}
        for s in seeds.SPECS
    ],
    "prompts": [
        {"code": code + "_v1", "name": v[0], "spec_code": code, "system_prompt": v[1], "user_prompt": v[2]}
        for code, v in seeds.P.items()
    ],
    "dicts": [
        {"code": k, "name": v[1], "value": v[0], "columns": v[2]}
        for k, v in seeds.DICTS.items() if k != "plan"
    ],
}
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "gen_seed.json")
with open(dst, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("written", os.path.normpath(dst), {k: len(v) for k, v in out.items()})
