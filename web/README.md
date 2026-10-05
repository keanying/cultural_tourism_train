# 文旅训练数据管理台（web/）

用于查看、在线修改并一键导出 5 个明细数据集与 5 个 SFT 训练集的页面。
基于 Next.js 16 + HeroUI v3，表格与分页沿用客户提供的 `Table` / `Pagination` 写法。数据存放在本地 SQLite 中，使用 Node 内置的 `node:sqlite`，不需要另外安装数据库。

## 启动

```bash
# 1) 在项目根目录把 output/ 下的交付数据导入 SQLite（约 3 分钟，生成 web/data/ct.db，约 4.4GB）
python -m distill.build_db

# 2) 启动页面（需要 Node.js ≥ 22.13）
cd web
npm install
npm run build
npm start            # 浏览器打开 http://localhost:3000
```

如果数据库不在默认位置，可以用环境变量 `CT_DB_PATH=/path/to/ct.db npm start` 指定。

## 功能

| 功能 | 说明 |
|---|---|
| 浏览 | 左侧切换 11 个数据源（5 个训练集 + 6 张明细表）；服务端分页，20 万行也能秒开 |
| 筛选 | 关键词搜索（训练集搜索样本内容和样本 ID，明细表搜索 ID 和名称类字段）；训练集可按训练/验证/测试集切换；可设置“只看已修改” |
| 在线修改·明细表 | 点击行或“查看/编辑”打开抽屉，逐字段编辑；数值字段会校验类型，只保存改动过的字段 |
| 在线修改·训练集 | 分为 user（JSON）、`<thought>`、`<answer>` 三段编辑，**实时校验**：messages 结构、JSON 格式和业务约束（如定价不超限、投放合计等于预算、归因加和闭合、推荐商品必须在库存内），不通过的不能保存；System Prompt 与评测真值只读 |
| 修改记录 | 每次保存都写入 `edit_log` 表，抽屉里以差异高亮方式展示修改前后的片段 |
| 一键导出 JSONL | 导出当前数据源、当前筛选条件下的数据（包含所有在线修改），采用流式下载。训练集每行为 `{"messages":[...]}`，可直接用于训练；“导出含评测真值”会额外附带 `id` 和 `meta` |

未经修改的样本导出后与 `output/` 中的原始训练文件**逐字节一致**；修改后的样本仍保持原有 JSON 格式（中文不转义，逗号、冒号后带空格）。

## API

| 接口 | 说明 |
|---|---|
| `GET /api/sources` | 数据源列表（行数、列、字段中文名、已修改数） |
| `GET /api/rows?source=&page=&pageSize=&q=&split=&edited=` | 分页列表 |
| `GET /api/row?source=&id=` | 单行详情与修改记录 |
| `PATCH /api/row` | 保存修改：明细表传 `{source,id,values}`，训练集传 `{source,id,user,assistant}`（服务端会再次校验） |
| `GET /api/export?source=&split=&q=&edited=&meta=` | 流式导出 JSONL |

表名和列名只来自 `sources` 白名单，所有取值都通过参数绑定传入，可以防止 SQL 注入。
