const listeners = new Set();

export const state = {
  bootstrapped: false,
  bootReady: false,
  fullWarmupStarted: false,
  fullWarmupDone: false,
  meta: null,
  overview: null,
  route: "overview",
  search: "",
  cache: {
    schema_version: 2,
    summary: {},
    groups: [],
    runs: [],
    risks: [],
    files: [],
    errors: [],
  },
  scripts: [],
  runIndex: { loaded: false, page: 1, pageSize: 50, total: 0, items: [] },
  scriptRegistry: { loaded: false, items: [] },
  runDetails: new Map(),
  spectraCache: new Map(),
  resourcePages: new Map(),
  activeJobs: new Map(),
  loading: {},
  errors: {},
  quality: {},
  supplements: [],
  indexStatus: { running: false, progress: 0, message: "未刷新" },
  selectedRunId: "",
  selectedFilePath: "",
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function updateState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(state));
}

export function setBootstrap(data) {
  const overview = data?.overview || {};
  const compatCache = data?.index_cache || {
    schema_version: 2,
    built_at: data?.meta?.built_at || "",
    summary: { ...(overview.summary || {}), high_value_candidates: overview.top_candidates || [] },
    groups: overview.groups || [],
    runs: overview.recent_runs || [],
    risks: overview.risks || [],
  };
  updateState({
    bootstrapped: true,
    bootReady: true,
    meta: data?.meta || null,
    overview,
    cache: compatCache,
    scripts: data?.script_registry?.scripts || [],
    scriptRegistry: { loaded: Boolean(data?.script_registry), items: data?.script_registry?.scripts || [] },
    quality: data?.quality_cache || {},
    supplements: data?.supplement_index?.packages || [],
  });
}

export function summary() {
  return state.cache?.summary || {};
}

export function runs() {
  return state.cache?.runs || [];
}

export function files() {
  return state.cache?.files || [];
}

export function risks() {
  return state.cache?.risks || [];
}

export function groups() {
  return state.cache?.groups || [];
}

export function searchText(item) {
  return [
    item.run_id,
    item.run_name,
    item.group,
    item.symmetry,
    item.mother_structure,
    item.perturbation,
    item.reduction_path,
    item.relative_path,
    item.script_id,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function filteredRuns() {
  const q = state.search.trim().toLowerCase();
  const list = runs();
  if (!q) return list;
  return list.filter((item) => searchText(item).includes(q));
}

export function filteredScripts() {
  const q = state.search.trim().toLowerCase();
  const list = state.scripts || [];
  if (!q) return list;
  return list.filter((item) => searchText(item).includes(q));
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function fmtNumber(value, digits = 0, fallback = "0") {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function pct(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(digits)}%`;
}

export function groupBy(list, key) {
  return list.reduce((acc, item) => {
    const k = item[key] || "未分类";
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}
