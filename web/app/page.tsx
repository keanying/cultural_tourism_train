"use client";

import { Alert, Button, Chip, SearchField, Spinner, Switch, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/DataTable";
import { EditDrawer } from "@/components/EditDrawer";
import { decodeEnum, shortLabel, SPLIT_LABEL, type ListResult, type Row, type SourceInfo } from "@/lib/types";

const PAGE_SIZE = 20;

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Home() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [active, setActive] = useState<string>("");
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const q = useDebounced(keyword);
  const [split, setSplit] = useState("all");
  const [editedOnly, setEditedOnly] = useState(false);
  const [data, setData] = useState<ListResult>({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const loadSources = useCallback(() => {
    fetch("/api/sources")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setSources(j.sources);
        setActive((a) => a || j.sources.find((s: SourceInfo) => s.kind === "sft")?.name || j.sources[0]?.name);
      })
      .catch((e) => setLoadErr(e.message));
  }, []);
  useEffect(loadSources, [loadSources]);

  const source = sources.find((s) => s.name === active);

  const params = useMemo(() => {
    const p = new URLSearchParams({ source: active });
    if (q) p.set("q", q);
    if (source?.kind === "sft" && split !== "all") p.set("split", split);
    if (editedOnly) p.set("edited", "1");
    return p;
  }, [active, q, split, editedOnly, source?.kind]);

  useEffect(() => setPage(1), [params]);
  // 切换数据源时清空旧行，避免新旧列结构混用
  useEffect(() => setData({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE }), [active]);

  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    setLoading(true);
    const p = new URLSearchParams(params);
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    fetch(`/api/rows?${p}`, { signal: ctrl.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setData(j);
        setLoadErr(null);
      })
      .catch((e) => e.name !== "AbortError" && setLoadErr(e.message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [params, page, active, tick]);

  const columns: Column[] = useMemo(() => {
    if (!source) return [];
    const editCol: Column = {
      id: "_action",
      name: "操作",
      render: (r) => (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" className="whitespace-nowrap" onPress={() => setOpenId(r._id)}>
            查看/编辑
          </Button>
          {r._edited ? <Chip size="sm" color="accent" className="whitespace-nowrap">已修改</Chip> : null}
        </div>
      ),
    };
    if (source.kind === "sft") {
      const cols: Column[] = [
        { id: "sid", name: "样本ID", render: (r) => <span className="whitespace-nowrap font-mono text-xs">{r.sid}</span> },
        { id: "split", name: "切分", render: (r) => <Chip size="sm" className="whitespace-nowrap">{SPLIT_LABEL[r.split] ?? r.split}</Chip> },
        { id: "user", name: "用户输入（user）", render: (r) => <span className="line-clamp-2 break-all font-mono text-xs text-muted">{r.user}</span> },
        { id: "answer", name: "最终回答（answer）", render: (r) => <span className="line-clamp-2 break-all text-xs">{r.answer}</span> },
        editCol,
      ];
      return cols;
    }
    return [
      ...source.viewColumns.map((c): Column => ({
        id: c,
        name: shortLabel(source.labels[c], c),
        render: source.enums[c] ? (r) => <span className="whitespace-nowrap">{decodeEnum(source.enums, c, r[c]) ?? "—"}</span> : undefined,
      })),
      editCol,
    ];
  }, [source]);

  const exportUrl = (withMeta = false) => {
    const p = new URLSearchParams(params);
    if (withMeta) p.set("meta", "1");
    return `/api/export?${p}`;
  };

  const datasets = sources.filter((s) => s.kind === "dataset");
  const sfts = sources.filter((s) => s.kind === "sft");

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface p-4 lg:block">
        <div className="mb-6">
          <h1 className="text-lg font-semibold">文旅训练数据管理台</h1>
          <p className="text-xs text-muted">查看 · 在线修改 · 一键导出 JSONL</p>
        </div>
        <NavGroup title="SFT 训练集" items={sfts} active={active} onSelect={setActive} />
        <NavGroup title="明细数据集" items={datasets} active={active} onSelect={setActive} />
      </aside>

      <main className="min-w-0 flex-1 p-4 lg:p-8">
        {/* 小屏幕下的数据源切换 */}
        <div className="mb-4 flex gap-2 overflow-x-auto lg:hidden">
          {sources.map((s) => (
            <Button key={s.name} size="sm" variant={s.name === active ? "primary" : "secondary"} onPress={() => setActive(s.name)}>
              {s.title}
            </Button>
          ))}
        </div>

        {loadErr ? (
          <Alert status="danger" className="mb-4">
            <Alert.Content>
              <Alert.Title>数据加载失败</Alert.Title>
              <Alert.Description>{loadErr}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {!source ? (
          <div className="flex justify-center py-32">
            <Spinner />
          </div>
        ) : (
          <>
            <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-semibold">{source.title}</h2>
                  <Chip size="sm">{source.kind === "sft" ? "SFT 训练集" : "明细数据集"}</Chip>
                </div>
                {source.kind === "dataset" ? <p className="mt-1 text-sm text-muted">{source.comment}</p> : null}
                <p className="mt-1 font-mono text-xs text-muted">
                  {source.kind === "sft" ? `ads.ads_llm_sft_sample_f（task_code=${source.name}）` : `${source.db}.${source.table}`} · 共{" "}
                  {source.rows.toLocaleString("zh-CN")} 条 · 已修改 {source.edited.toLocaleString("zh-CN")} 条
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={exportUrl()} download>
                  <Button variant="primary">导出 JSONL{q || editedOnly || (source.kind === "sft" && split !== "all") ? "（当前筛选）" : "（全部）"}</Button>
                </a>
                {source.kind === "sft" ? (
                  <a href={exportUrl(true)} download>
                    <Button variant="secondary">导出含评测真值</Button>
                  </a>
                ) : null}
              </div>
            </header>

            <div className="mb-4 flex flex-wrap items-center gap-4">
              <SearchField value={keyword} onChange={setKeyword} className="w-full max-w-sm" aria-label="搜索">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={source.kind === "sft" ? "搜索样本内容或样本ID" : `搜索：${source.searchColumns.map((c) => shortLabel(source.labels[c], c)).join(" / ")}`} />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>
              {source.kind === "sft" ? (
                <Tabs selectedKey={split} onSelectionChange={(k) => setSplit(String(k))}>
                  <Tabs.ListContainer>
                    <Tabs.List aria-label="数据切分">
                      {["all", "train", "val", "test"].map((k) => (
                        <Tabs.Tab key={k} id={k} className="whitespace-nowrap">
                          {k === "all" ? "全部" : SPLIT_LABEL[k]}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      ))}
                    </Tabs.List>
                  </Tabs.ListContainer>
                </Tabs>
              ) : null}
              <Switch isSelected={editedOnly} onChange={setEditedOnly}>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Switch.Content>只看已修改</Switch.Content>
              </Switch>
              {loading ? <Spinner size="sm" /> : null}
            </div>

            <DataTable
              key={active}
              columns={columns}
              rows={data.rows}
              total={data.total}
              page={page}
              pageSize={PAGE_SIZE}
              loading={loading}
              onPageChange={setPage}
              onRowAction={(r) => setOpenId(r._id)}
              emptyText={editedOnly ? "还没有修改过的记录" : "没有匹配的记录"}
            />
          </>
        )}
      </main>

      {source ? (
        <EditDrawer
          source={source}
          rowId={openId}
          onClose={() => setOpenId(null)}
          onSaved={() => {
            setTick((t) => t + 1);
            loadSources();
          }}
        />
      ) : null}
    </div>
  );
}

function NavGroup({ title, items, active, onSelect }: { title: string; items: SourceInfo[]; active: string; onSelect: (n: string) => void }) {
  return (
    <nav className="mb-6">
      <h3 className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s.name}>
            <button
              type="button"
              onClick={() => onSelect(s.name)}
              className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                s.name === active ? "bg-accent text-accent-foreground" : "hover:bg-surface-secondary"
              }`}
            >
              <span className="truncate">{s.title}</span>
              <span className={`ml-2 shrink-0 text-xs ${s.name === active ? "opacity-80" : "text-muted"}`}>
                {s.edited ? `✎${s.edited} · ` : ""}
                {(s.rows / 10000).toFixed(0)}万
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
