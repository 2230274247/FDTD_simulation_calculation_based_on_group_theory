import { api } from "./api.js";
import { drawLine, drawTrend, drawHeatmap } from "./charts.js";

const routes = {
  overview: "研究总览",
  run: "运行控制",
  results: "结果浏览",
  diagnosis: "光谱诊断",
  topology: "模式接力 / 拓扑候选",
  quality: "质量审计",
  supplement: "补做实验",
  resources: "资源浏览",
};

const state = {
  meta: null,
  overview: null,
  quality: null,
  supplements: [],
  scriptsPage: null,
  runsPage: null,
  resourcesPage: null,
  selectedRunId: "",
  selectedScriptIds: new Set(),
  runDetails: new Map(),
  filePreview: null,
  diagnostics: null,
  spectrum: null,
  trend: null,
  relay: null,
  heatmap: null,
  missing: null,
  packages: null,
  activeJobId: "",
  runPreview: { payloadHash: "", previewHash: "", executionPlan: null, valid: false, warnings: [], dirtyReason: "" },
  jobLog: { mode: "all", search: "", autoScroll: true, data: null, jobId: "" },
  sampleSpectrum: { controller: null, data: null, sampleId: "", featureType: "auto", selection: null, lastResult: null, requestSeq: 0, lastSavedManual: false },
  resultFilters: { scope: "current", group: "", mother: "", perturbation: "", risk: "" },
  selectedStructure: null,
  structureTree: null,
  structureNavigator: null,
  selectedSampleId: "",
  supplementUI: { selectedKeys: new Set(), focusedKey: "", expandedRuns: new Set(), step: 1, lastCreatedPackageId: "" },
  resultPreviewImages: [],
  resultPreviewIndex: 0,
  resultAutoplayTimer: null,
  supplementSearch: "",
  supplementVisibleLimit: 420,
  indexStatus: { running: false, progress: 0 },
  preloadStatus: null,
  warmupStarted: false,
  warmupDone: false,
  search: "",
};

let warmupPausedUntil = 0;
let renderSeq = 0;
const actionLocks = new Map();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const fmt = (value, digits = 0) => {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const tagTone = (risk) => risk === "high" ? "red" : risk === "medium" ? "orange" : "green";
const STRUCTURE_NAV_STORAGE_KEY = "fdtd.result-structure-navigator.v1";

function structurePathKey(path) {
  if (!path) return "";
  return [path.group || "", path.mother || "", path.perturbation || "", path.run_id || ""].join("||");
}

function structurePathLabel(path) {
  if (!path) return "";
  const parts = [path.group, path.mother, path.perturbation, path.run_name || path.run_id].filter(Boolean);
  return parts.join(" / ");
}

function loadStructureNavigatorState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STRUCTURE_NAV_STORAGE_KEY) || "{}");
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      scope: parsed.scope || "current",
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded : [],
    };
  } catch {
    return { query: "", scope: "current", favorites: [], recent: [], expanded: [] };
  }
}

function ensureStructureNavigatorState() {
  if (!state.structureNavigator) {
    state.structureNavigator = loadStructureNavigatorState();
  }
  return state.structureNavigator;
}

function saveStructureNavigatorState() {
  const nav = ensureStructureNavigatorState();
  localStorage.setItem(STRUCTURE_NAV_STORAGE_KEY, JSON.stringify({
    query: nav.query || "",
    scope: nav.scope || "current",
    favorites: nav.favorites || [],
    recent: nav.recent || [],
    expanded: nav.expanded || [],
  }));
}

function normalizeStructureRecord(node, parent = {}) {
  const kind = node.kind || parent.kind || "";
  const group = kind === "group" ? (node.name || parent.group || node.group || "") : (node.group || parent.group || "");
  const mother = kind === "mother" ? (node.name || parent.mother || node.mother_structure || "") : (node.mother_structure || parent.mother || "");
  const perturbation = kind === "perturbation" ? (node.name || parent.perturbation || node.perturbation || "") : (node.perturbation || parent.perturbation || "");
  const runId = kind === "run" ? (node.run_id || node.id || "") : (node.run_id || parent.run_id || "");
  return {
    key: structurePathKey({ group, mother, perturbation, run_id: runId }),
    label: structurePathLabel({
      group,
      mother,
      perturbation,
      run_id: runId,
      run_name: node.run_name || node.name || "",
    }),
    scope: ensureStructureNavigatorState().scope || "current",
    group,
    mother,
    perturbation,
    run_id: runId,
    run_name: node.run_name || node.name || "",
    kind: node.kind || parent.kind || "",
  };
}

function pushStructureRecent(record) {
  if (!record || !record.key) return;
  const nav = ensureStructureNavigatorState();
  const list = [record, ...(nav.recent || []).filter((item) => item.key !== record.key)];
  nav.recent = list.slice(0, 12);
  saveStructureNavigatorState();
}

function toggleStructureFavorite(record) {
  if (!record || !record.key) return;
  const nav = ensureStructureNavigatorState();
  const favorites = nav.favorites || [];
  const idx = favorites.findIndex((item) => item.key === record.key);
  if (idx >= 0) favorites.splice(idx, 1);
  else favorites.unshift(record);
  nav.favorites = favorites.slice(0, 20);
  saveStructureNavigatorState();
}

function toggleStructureExpanded(key, forceOpen = null) {
  const nav = ensureStructureNavigatorState();
  const expanded = new Set(nav.expanded || []);
  const shouldOpen = forceOpen === null ? !expanded.has(key) : forceOpen;
  if (shouldOpen) expanded.add(key);
  else expanded.delete(key);
  nav.expanded = Array.from(expanded);
  saveStructureNavigatorState();
}

function setStructureScope(scope) {
  const nav = ensureStructureNavigatorState();
  nav.scope = scope || "current";
  state.resultFilters.scope = nav.scope;
  saveStructureNavigatorState();
}

function selectStructurePath(record, runId = "") {
  const nav = ensureStructureNavigatorState();
  const selected = {
    ...record,
    run_id: runId || record.run_id || "",
    key: structurePathKey({ ...record, run_id: runId || record.run_id || "" }),
  };
  if (!selected.scope) selected.scope = nav.scope || "current";
  state.selectedStructure = selected;
  if (selected.scope) state.resultFilters.scope = selected.scope;
  if (selected.group !== undefined) state.resultFilters.group = selected.group || "";
  if (selected.mother !== undefined) state.resultFilters.mother = selected.mother || "";
  if (selected.perturbation !== undefined) state.resultFilters.perturbation = selected.perturbation || "";
  if (selected.scope) nav.scope = selected.scope;
  pushStructureRecent(selected);
  return selected;
}

function structureNodeMatchesQuery(node, query) {
  if (!query) return true;
  const haystack = [
    node.name,
    node.group,
    node.mother_structure,
    node.perturbation,
    node.run_name,
    node.run_id,
    ...(node.runs || []).map((run) => [run.run_name, run.run_id, run.group, run.mother_structure, run.perturbation].filter(Boolean).join(" ")),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function structureAncestorKeys(record) {
  if (!record) return [];
  const keys = [];
  const group = record.group || "";
  const mother = record.mother || "";
  const perturbation = record.perturbation || "";
  if (group) keys.push(structurePathKey({ group }));
  if (group && mother) keys.push(structurePathKey({ group, mother }));
  if (group && mother && perturbation) keys.push(structurePathKey({ group, mother, perturbation }));
  if (group && mother && perturbation && record.run_id) {
    keys.push(structurePathKey({ group, mother, perturbation, run_id: record.run_id }));
  }
  return keys;
}

export function scheduleIdleTask(fn) {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => fn(), { timeout: 3000 });
  } else {
    setTimeout(fn, 300);
  }
}

function toast(message, type = "info") {
  const host = $("#toast-host");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

function openDrawer(title, html) {
  $("#drawer-title").textContent = title;
  $("#drawer-body").innerHTML = html;
  $("#drawer-mask").hidden = false;
  $("#drawer").hidden = false;
}

function closeDrawer() {
  $("#drawer-mask").hidden = true;
  $("#drawer").hidden = true;
}

function openModal({ title, body, confirmText = "确认", danger = false, onConfirm }) {
  const root = $("#modal-root");
  root.hidden = false;
  root.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><strong>${esc(title)}</strong><button class="icon-btn" data-close-modal type="button" aria-label="关闭">×</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button class="btn ghost" data-close-modal type="button">取消</button>
        <button class="btn ${danger ? "danger" : "primary"}" data-confirm-modal type="button">${esc(confirmText)}</button>
      </div>
    </section>`;
  $$("[data-close-modal]", root).forEach((btn) => btn.addEventListener("click", closeModal));
  $("[data-confirm-modal]", root).addEventListener("click", async () => {
    if (onConfirm) await onConfirm();
    closeModal();
  });
}

function closeModal() {
  const root = $("#modal-root");
  root.hidden = true;
  root.innerHTML = "";
}

function setRouteClickHandler(root, key, handler) {
  const prop = `__${key}ClickHandler`;
  if (root[prop]) root.removeEventListener("click", root[prop]);
  root[prop] = handler;
  root.addEventListener("click", handler);
}

async function copyText(text) {
  if (!text) throw new Error("没有可复制的路径");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function downloadText(filename, text) {
  const blob = new Blob([text || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ensureJobLogState() {
  if (!state.jobLog) {
    state.jobLog = { mode: "all", search: "", autoScroll: true, data: null, jobId: "" };
  }
  if (state.jobLog.autoScroll === undefined) state.jobLog.autoScroll = true;
  if (!state.jobLog.mode) state.jobLog.mode = "all";
  if (state.jobLog.search === undefined) state.jobLog.search = "";
  return state.jobLog;
}

function jobLogLineTone(level) {
  return level === "error" ? "red" : level === "warning" ? "orange" : level === "progress" ? "blue" : "green";
}

function jobLogLineMatches(entry, mode, query) {
  const level = String(entry?.level || "info");
  if (mode === "progress" && level !== "progress") return false;
  if (mode === "warn" && !(level === "warning" || level === "error")) return false;
  if (mode === "raw") {
    if (!query) return true;
    return [entry?.raw, entry?.text, entry?.source, entry?.time].some((value) => String(value || "").toLowerCase().includes(query));
  }
  if (query && ![entry?.time, entry?.source, entry?.text, entry?.raw].some((value) => String(value || "").toLowerCase().includes(query))) {
    return false;
  }
  return true;
}

function jobLogDisplayText(log) {
  const data = log || {};
  const mode = (ensureJobLogState().mode || "all").toLowerCase();
  const query = ensureJobLogState().search.trim().toLowerCase();
  const structured = Array.isArray(data.structured_lines) ? data.structured_lines : [];
  const filtered = structured.filter((entry) => jobLogLineMatches(entry, mode, query));
  const fallbackText = String(data.raw_text || data.text || "").trim();
  const total = structured.length;
  const collapsed = Number(data.collapsed_count || 0);
  const warning = data.encoding_warning ? `<span class="tag orange">${esc(data.encoding_warning)}</span>` : "";
  const summary = `<div class="muted" style="margin-bottom:8px">总计 ${fmt(total)} 行 · 折叠 ${fmt(collapsed)} 行${warning ? ` · ${warning}` : ""}</div>`;
  const controls = `
    <div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <div class="segmented" id="job-log-mode">
        <button class="${mode === "all" ? "active" : ""}" data-job-log-mode="all" type="button">全部</button>
        <button class="${mode === "progress" ? "active" : ""}" data-job-log-mode="progress" type="button">进度</button>
        <button class="${mode === "warn" ? "active" : ""}" data-job-log-mode="warn" type="button">warning/error</button>
        <button class="${mode === "raw" ? "active" : ""}" data-job-log-mode="raw" type="button">原始日志</button>
      </div>
      <label class="muted" style="display:flex;align-items:center;gap:6px"><input id="job-log-auto-scroll" type="checkbox" ${ensureJobLogState().autoScroll ? "checked" : ""}>自动滚动</label>
      <input class="input" id="job-log-search" type="search" placeholder="搜索日志" value="${esc(ensureJobLogState().search || "")}" style="max-width:240px;flex:1 1 220px">
      <button class="btn ghost" data-job-log-copy type="button">复制</button>
      <button class="btn ghost" data-job-log-download type="button">下载</button>
    </div>`;
  const body = mode === "raw"
    ? (() => {
      const rawLines = fallbackText ? fallbackText.split(/\r?\n/) : [];
      const displayText = query ? rawLines.filter((line) => line.toLowerCase().includes(query)).join("\n") : fallbackText;
      if (query && !displayText) return `<div id="job-log-body" class="empty" style="max-height:40vh;overflow:auto">没有匹配的日志行。</div>`;
      return `<pre class="terminal" id="job-log-body" style="margin:0;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(displayText || "暂无日志")}</pre>`;
    })()
    : (filtered.length ? `<div id="job-log-body" style="max-height:40vh;overflow:auto">${filtered.map((entry) => {
      const repeated = Number(entry.repeated_count || 1);
      const time = entry.time ? `<span class="muted">${esc(entry.time)}</span>` : "";
      const source = entry.source ? `<span class="tag blue">${esc(entry.source)}</span>` : "";
      const count = repeated > 1 ? ` <span class="tag green">x${repeated}</span>` : "";
      return `<div style="padding:6px 0;border-bottom:1px solid rgba(0,0,0,.06);display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap"><span class="tag ${jobLogLineTone(entry.level)}">${esc(String(entry.level || "info").toUpperCase())}</span>${time}${source}<span style="white-space:pre-wrap;word-break:break-word;flex:1 1 100%">${esc(entry.text || "")}${count}</span></div>`;
    }).join("")}</div>` : (fallbackText ? `<pre class="terminal" id="job-log-body" style="margin:0;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(fallbackText)}</pre>` : `<div id="job-log-body" class="empty" style="max-height:40vh;overflow:auto">没有匹配的日志行。</div>`));
  return `${controls}${summary}${body}`;
}

function jobLogPlainText(log) {
  const data = log || {};
  const mode = (ensureJobLogState().mode || "all").toLowerCase();
  const query = ensureJobLogState().search.trim().toLowerCase();
  const structured = Array.isArray(data.structured_lines) ? data.structured_lines : [];
  const fallbackText = String(data.raw_text || data.text || "").trim();
  if (mode === "raw") {
    if (!query) return fallbackText || "暂无日志";
    return fallbackText.split(/\r?\n/).filter((line) => line.toLowerCase().includes(query)).join("\n") || "暂无日志";
  }
  if (!structured.length) return fallbackText || "暂无日志";
  const filtered = structured.filter((entry) => jobLogLineMatches(entry, mode, query));
  if (!filtered.length) return "暂无日志";
  return filtered.map((entry) => {
    const parts = [];
    if (entry.time) parts.push(`[${entry.time}]`);
    if (entry.source) parts.push(`[${entry.source}]`);
    parts.push(`[${String(entry.level || "info").toUpperCase()}] ${entry.text || ""}`);
    return parts.join(" ");
  }).join("\n");
}

function renderJobLogPanel(root, log = null) {
  const panel = $("#job-log", root);
  if (!panel) return;
  const jobLog = ensureJobLogState();
  if (log) jobLog.data = log;
  panel.innerHTML = jobLogDisplayText(jobLog.data || {});
  const body = $("#job-log-body", panel);
  if (body && jobLog.autoScroll && body.scrollHeight > body.clientHeight) {
    body.scrollTop = body.scrollHeight;
  }
}

async function runActionOnce(key, fn, lockMs = 1200) {
  const now = Date.now();
  if (actionLocks.get(key) > now) return;
  actionLocks.set(key, now + lockMs);
  try {
    await fn();
  } finally {
    setTimeout(() => {
      if ((actionLocks.get(key) || 0) <= Date.now()) actionLocks.delete(key);
    }, lockMs + 50);
  }
}

function routeName() {
  const raw = window.location.hash.replace(/^#/, "");
  return routes[raw] ? raw : "overview";
}

function updateHeader() {
  const built = state.meta?.built_at;
  $("#index-time").textContent = built ? `索引缓存：${built.replace("T", " ").slice(0, 19)}` : "索引缓存：未建立";
  $("#crumb-title").textContent = routes[routeName()];
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.route === routeName()));
}

function ensureStatusBar() {
  let bar = $("#data-status-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "data-status-bar";
    bar.style.cssText = "position:fixed;left:calc(var(--sidebar-w) + 18px);right:18px;bottom:12px;z-index:40;padding:8px 12px;border:1px solid var(--color-border);border-radius:8px;background:rgba(255,255,255,.95);box-shadow:var(--shadow-card);font-size:12px;color:var(--color-muted);";
    document.body.appendChild(bar);
  }
  return bar;
}

function updateStatusBar(extra = "") {
  const counts = state.meta?.counts || {};
  const preload = state.preloadStatus || {};
  ensureStatusBar().textContent = [
    `索引：${state.indexStatus.running ? `刷新中 ${state.indexStatus.progress || 0}%` : state.meta?.status || "未建立"}`,
    `run ${counts.runs || 0}`,
    `脚本 ${counts.scripts || 0}`,
    `谱线 ${preload.counts?.spectra_built || 0}/${counts.spectra || 0}`,
    `资源 ${counts.files || 0}`,
    state.warmupDone ? "后台预热完成" : state.warmupStarted ? `后台预热中 ${preload.progress || 0}%` : "后台预热待启动",
    extra,
  ].filter(Boolean).join("；");
}

async function bootstrap() {
  const started = performance.now();
  try {
    const data = await api.bootstrap();
    api.setLocalToken(data.local_token || "");
    state.meta = data.meta || null;
    state.overview = data.overview || null;
    state.quality = data.quality_cache || null;
    state.supplements = data.supplement_index?.packages || [];
    updateHeader();
    updateStatusBar(data.stale ? "当前显示上次缓存" : `bootstrap ${Math.round(performance.now() - started)} ms`);
    await renderRoute();
    startBackgroundWarmup();
  } catch (error) {
    $("#page-root").innerHTML = `<div class="empty">读取缓存失败：${esc(error.message)}</div>`;
    toast(`读取缓存失败：${error.message}`, "error");
  }
}

async function refreshIndex(fullRebuild = false) {
  if (fullRebuild) {
    if (!confirm("全量重建会彻底重扫项目目录，确认执行？")) return;
    if (!confirm("再次确认：全量重建是低频维护操作，不是日常刷新。继续？")) return;
  }
  try {
    state.indexStatus = await api.refreshIndex(fullRebuild ? { full_rebuild: true, confirm: true } : {});
    updateStatusBar("后台刷新已启动");
    pollIndexStatus();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function pollIndexStatus() {
  try {
    state.indexStatus = await api.indexStatus();
    updateStatusBar();
    $("#refresh-index").textContent = state.indexStatus.running ? `后台刷新 ${state.indexStatus.progress || 0}%` : "后台刷新";
    if (state.indexStatus.running) {
      setTimeout(pollIndexStatus, 1200);
    } else if (state.indexStatus.completed_at) {
      toast("索引已更新，当前视图已按需刷新。", "success");
      await bootstrap();
    }
  } catch (error) {
    toast(`索引状态读取失败：${error.message}`, "error");
  }
}

async function startBackgroundWarmup() {
  if (state.warmupStarted) return;
  try {
    state.preloadStatus = await api.preloadStart();
    state.warmupStarted = true;
    updateStatusBar();
  } catch {
    return;
  }
  const tasks = [
    () => api.cacheChunk("run_index", { page: 1, page_size: 50 }),
    () => api.cacheChunk("script_registry", { page: 1, page_size: 100 }),
    () => api.cacheChunk("quality"),
    () => api.cacheChunk("resources", { page: 1, page_size: 100 }),
    () => api.preloadNext("run_details", 4),
    () => api.preloadNext("spectra", 4),
  ];
  let cursor = 0;
  const next = async () => {
    if (Date.now() < warmupPausedUntil) {
      setTimeout(next, 600);
      return;
    }
    try {
      const result = await tasks[cursor % tasks.length]();
      if (result?.status) state.preloadStatus = result.status;
    } catch {
      // Warmup is best-effort and must not interrupt active work.
    }
    cursor += 1;
    updateStatusBar();
    if (cursor < 60) scheduleIdleTask(next);
    else {
      state.warmupDone = true;
      updateStatusBar();
    }
  };
  scheduleIdleTask(next);
}

function markUserPriority() {
  warmupPausedUntil = Date.now() + 1800;
}

async function loadRouteData(route) {
  const q = state.search.trim();
  if (route === "run") {
    state.scriptsPage = await api.scripts({ page: 1, page_size: 100, query: q });
  }
  if (["results", "diagnosis", "topology"].includes(route)) {
    const filters = route === "results" ? state.resultFilters : { scope: "current" };
    if (route === "results") {
      const [runsPage, structureTree] = await Promise.all([
        api.runs({ page: 1, page_size: 500, query: q, ...filters }),
        api.structureTree(filters.scope || "current"),
      ]);
      state.runsPage = runsPage;
      state.structureTree = structureTree;
    } else {
      state.runsPage = await api.runs({ page: 1, page_size: 50, query: q, ...filters });
    }
    if (!state.selectedRunId && state.runsPage.runs?.[0]) state.selectedRunId = state.runsPage.runs[0].run_id;
  }
  if (route === "quality") {
    state.quality = await api.cacheChunk("quality");
  }
  if (route === "supplement") {
    state.missing = await api.supplementMissing();
    state.packages = await api.supplementPackages();
  }
  if (route === "resources") {
    state.resourcesPage = await api.resources({ page: 1, page_size: 120, query: q });
  }
}

async function renderRoute() {
  const route = routeName();
  const seq = ++renderSeq;
  if (route !== "results") stopResultAutoplay();
  closeDrawer();
  closeModal();
  updateHeader();
  $("#page-root").innerHTML = `<div class="empty">正在加载 ${esc(routes[route])}...</div>`;
  try {
    await loadRouteData(route);
    if (seq !== renderSeq || route !== routeName()) return;
    $("#page-root").innerHTML = renderPage(route);
    await afterRender(route);
  } catch (error) {
    if (seq !== renderSeq || route !== routeName()) return;
    $("#page-root").innerHTML = `<div class="empty">页面加载失败：${esc(error.message)}</div>`;
    toast(error.message, "error");
  }
}

function renderPage(route) {
  return {
    overview: renderOverview,
    run: renderRunControl,
    results: renderResults,
    diagnosis: renderDiagnosis,
    topology: renderTopology,
    quality: renderQuality,
    supplement: renderSupplement,
    resources: renderResources,
  }[route]();
}

function pageHead(title, subtitle, action = "") {
  return `<div class="page-head"><div><h1 class="page-title">${esc(title)}</h1><div class="page-subtitle">${esc(subtitle)}</div></div>${action}</div>`;
}

function renderOverview() {
  const overview = state.overview || {};
  const s = overview.summary || {};
  const candidates = overview.top_candidates || [];
  const groups = overview.groups || [];
  const recent = overview.recent_runs || [];
  const risks = overview.risks || [];
  const noCache = !state.meta?.built_at;
  return `<section class="page active">
    ${pageHead("研究总览", "首屏只读轻量缓存；目录扫描必须由后台刷新显式触发。", `<button class="btn secondary" id="first-index" type="button">${noCache ? "开始首次索引" : "后台刷新索引"}</button>`)}
    <div class="stat-grid">
      ${statCard("有效 run", s.valid_run_count, "存在 T 谱、manifest 或扫描点")}
      ${statCard("异常 run", s.bad_run_count, "严重质量标记")}
      ${statCard("已诊断谱线", s.spectra_count, "T/R/A 谱线索引")}
      ${statCard("缺失证据", s.missing_evidence_count, "R/A/Field/Phase/Poynting")}
      ${statCard("母结构覆盖率", pct(s.mother_coverage_rate), "按脚本与有效结果估算")}
    </div>
    ${noCache ? `<div class="empty">尚未建立索引。页面不会自动扫描真实目录，请点击“开始首次索引”。</div>` : ""}
    <div class="overview-grid">
      <div class="card pad coverage-card"><div class="card-title">群分类覆盖</div>${groups.length ? groups.map(groupProgress).join("") : emptySmall("暂无群分类缓存")}</div>
      <div class="card pad advice-card"><div class="card-title">下一步建议</div>${adviceList(overview.next_actions || [])}</div>
      <div class="card pad candidate-card"><div class="card-title">高价值候选<button class="link" data-go="diagnosis" type="button">进入诊断</button></div>${candidateTable(candidates)}</div>
      <div class="card pad recent-card"><div class="card-title">最近活跃 run</div>${runTable(recent.slice(0, 10))}</div>
      <div class="card pad risk-card"><div class="card-title">风险提醒</div>${riskList(risks)}</div>
    </div>
  </section>`;
}
function statCard(label, value, note) {
  return `<div class="card stat-card"><div class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M13 16V8"/><path d="M18 16v-8"/></svg></div><div><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value ?? "-")}</div><div class="stat-note">${esc(note)}</div></div></div>`;
}

function groupProgress(group) {
  const rate = Number(group.coverage_rate) || 0;
  return `<div class="progress-row"><div class="progress-label">${esc(group.group || "未分类")}</div><div class="progress-track"><div class="progress-bar" style="width:${Math.max(2, Math.min(100, rate * 100))}%"></div></div><div class="progress-value">${pct(rate)}</div></div>`;
}

function candidateTable(rows) {
  if (!rows.length) return emptySmall("暂无候选缓存");
  return `<table class="table"><thead><tr><th>对象</th><th>score</th><th>λ0</th><th>Q</th></tr></thead><tbody>${rows.map((r) => `<tr data-run-jump="${esc(r.run_id)}"><td>${esc(r.group || "")} / ${esc(r.mother_structure || "")}<br><span class="muted">${esc(r.perturbation || r.run_id)}</span></td><td>${fmt(r.score || r.best_score, 2)}</td><td>${fmt(r.lambda0_nm, 2)}</td><td>${fmt(r.q || r.Q, 1)}</td></tr>`).join("")}</tbody></table>`;
}

function runTable(rows) {
  if (!rows.length) return emptySmall("暂无 run 缓存");
  return `<table class="table"><thead><tr><th>run</th><th>群</th><th>风险</th><th>谱线</th></tr></thead><tbody>${rows.map((r) => `<tr><td><button class="link" data-select-run="${esc(r.run_id)}" data-go="diagnosis" type="button">${esc(r.run_name || r.run_id)}</button><br><span class="muted">${esc(r.perturbation || "")}</span></td><td>${esc(r.group || "")}</td><td><span class="tag ${tagTone(r.risk_level || r.risk)}">${esc(r.risk_label || r.risk || "-")}</span></td><td>${fmt(r.spectrum_count || r.spectra_count || 0)}</td></tr>`).join("")}</tbody></table>`;
}

function adviceList(rows) {
  if (!rows.length) return emptySmall("暂无建议");
  return `<div class="advice-list">${rows.slice(0, 10).map((a) => `<button class="advice-item warn" data-go="${esc(a.target || "quality")}" type="button"><span class="dot orange"></span><span>${esc(a.title)}</span><strong>${fmt(a.count || 0)}</strong></button>`).join("")}</div>`;
}

function riskList(rows) {
  if (!rows.length) return emptySmall("暂无风险提醒");
  return `<div class="risk-list">${rows.slice(0, 10).map((r) => `<div class="risk-item"><span class="dot ${r.level === "high" ? "red" : "orange"}"></span><span><strong>${esc(r.title)}</strong><br><span class="muted">${esc(r.detail || "")}</span></span><button class="link" data-select-run="${esc(r.run_id || "")}" data-go="quality" type="button">查看</button></div>`).join("")}</div>`;
}

function emptySmall(text) {
  return `<div class="empty">${esc(text)}</div>`;
}

function renderRunControl() {
  const scripts = state.scriptsPage?.scripts || [];
  return `<section class="page active">
    ${pageHead("运行控制", "只通过 subprocess 调用 fdtd_master_controller.py；启动前写入 job_manifest、快照和临时 overrides。", `<button class="btn secondary" id="refresh-scripts" type="button">刷新脚本列表</button>`)}
    <div class="layout-3">
      <div class="card pad"><div class="card-title">结构与脚本 <span class="muted">${fmt(state.scriptsPage?.total || scripts.length)} 个</span></div><div class="script-tree">${scripts.length ? scripts.map(scriptRow).join("") : emptySmall("暂无脚本缓存")}</div></div>
      <div class="card pad">${runForm()}</div>
      <div><div class="card pad"><div class="card-title">启动摘要</div><table class="table"><tbody><tr><td>选择脚本</td><td id="selected-script-count">${state.selectedScriptIds.size}</td></tr><tr><td>扫描点数估算</td><td id="point-estimate">待预览</td></tr><tr><td>预计时长</td><td id="duration-estimate">待预览</td></tr><tr><td>安全状态</td><td id="run-preview-status">${state.runPreview?.valid ? "已预览，可启动" : (state.runPreview?.dirtyReason || "未预览")}</td></tr></tbody></table><div class="toolbar" style="margin-top:14px"><button class="btn secondary" id="preview-run" type="button">预览命令</button><button class="btn primary" id="start-run" type="button" ${state.runPreview?.valid ? "" : "disabled"}>启动</button></div></div><div class="terminal-head" style="margin-top:12px"><span>实时日志</span><button class="link" id="stop-job" type="button">停止任务</button></div><div class="card pad" id="job-log">${jobLogDisplayText(ensureJobLogState().data || { text: "尚未启动任务。", raw_text: "尚未启动任务。", structured_lines: [] })}</div></div>
    </div>
    <div class="bottom-actions"><span class="muted">危险操作都需要二次确认；full + parallel 会触发高风险确认。</span><div class="toolbar"><button class="btn ghost" id="clear-selected" type="button">清空选择</button><button class="btn primary" id="bottom-start" type="button" ${state.runPreview?.valid ? "" : "disabled"}>确认启动</button></div></div>
  </section>`;
}

function scriptRow(s) {
  const id = String(s.id || s.script_id);
  const status = { has_full: "已有 full", has_test: "已有 test", missing_result: "缺结果", failed: "异常", unknown: "未知" }[s.status] || s.status || "未知";
  return `<button class="tree-row ${state.selectedScriptIds.has(id) ? "active" : ""}" data-script-id="${esc(id)}" type="button"><span class="dot ${s.status === "failed" ? "red" : s.status === "has_full" ? "green" : "orange"}"></span><span>${esc(s.group || "")} / ${esc(s.mother_structure || "")} / ${esc(s.perturbation || s.relative_path)}</span><span class="tag blue">${esc(status)}</span></button>`;
}

function runForm() {
  return `<div class="card-title">运行参数</div>
    <div class="field"><label>运行模式</label><div class="segmented" id="mode-control"><button class="active" data-value="preview" type="button">preview</button><button data-value="test" type="button">test</button><button data-value="full" type="button">full</button></div></div>
    <div class="field" style="margin-top:12px"><label>执行策略</label><div class="segmented" id="style-control"><button class="active" data-value="sequential" type="button">sequential</button><button data-value="parallel" type="button">parallel</button></div></div>
    <div class="form-grid" style="margin-top:12px">
      ${inputField("max-parallel", "并发数", "2", "个")}
      ${inputField("start-value", "start", "", "nm")}
      ${inputField("end-value", "end", "", "nm")}
      ${inputField("step-value", "step", "", "nm")}
      ${inputField("mesh-accuracy", "mesh accuracy", "", "级")}
      ${inputField("dt-factor", "dt 稳定阈值", "", "CFL")}
      ${inputField("runtime-fs", "runtime", "", "fs")}
      ${inputField("auto-shutoff", "auto shutoff", "", "min")}
      ${inputField("child-timeout", "子任务超时", "3600", "s")}
    </div>
    <div class="notice" style="margin-top:14px">页面加载不会运行脚本；只有点击启动并确认后才会执行。</div>`;
}

function inputField(id, label, value, unit) {
  return `<div class="field unit-field"><label>${esc(label)}</label><input class="input" id="${esc(id)}" type="number" value="${esc(value)}"><span class="unit">${esc(unit)}</span></div>`;
}

function renderResults() {
  const runs = state.runsPage?.runs || [];
  return `<section class="page active">
    ${pageHead("结果浏览", "按当前结果 / 历史结果分区加载；run 树使用 群类别 → 母结构 → 扰动 → run 的层级，点击样本后预览对应谱图。")}
    <div class="results-layout">
      <div class="card pad results-sidebar">
        <div id="structure-navigator">${renderStructureNavigator()}</div>
      </div>
      <div class="results-main">
        <div class="card pad">
          <div class="card-title">样本点 / 输出文件 <span id="run-title" class="muted">${esc(state.selectedRunId || "未选择")}</span></div>
          <div id="sample-table" class="empty">请选择 run。</div>
        </div>
        <div class="card chart-card">
          <div class="chart-head"><strong>参数趋势 / 相关资源</strong><span id="resource-hint" class="muted">选择 run 后按需加载</span></div>
          <div class="trend-resource-grid">
            <div class="chart-box small"><canvas id="result-trend-chart"></canvas></div>
            <div id="resource-strip" class="resource-strip">请选择 run。</div>
          </div>
        </div>
        <div class="card pad">
          <div class="card-title">谱图预览 <span class="muted">样本点联动</span></div>
          <div id="preview-pane" class="preview-pane spectrum-preview">点击“样本点 / 输出文件”中的样本后显示透射谱图。</div>
        </div>
      </div>
    </div>
  </section>`;
}

function renderStructureNavigator() {
  const nav = ensureStructureNavigatorState();
  const scope = nav.scope || "current";
  const query = (nav.query || "").trim();
  const tree = Array.isArray(state.structureTree?.tree) ? state.structureTree.tree : [];
  const filtered = filterStructureTree(tree, query);
  const selectedKey = state.selectedStructure?.key || structurePathKey({
    group: state.resultFilters.group || "",
    mother: state.resultFilters.mother || "",
    perturbation: state.resultFilters.perturbation || "",
    run_id: state.selectedRunId || "",
  });
  const openKeys = new Set(nav.expanded || []);
  [state.selectedStructure, ...(nav.recent || []), ...(nav.favorites || [])]
    .filter(Boolean)
    .forEach((record) => structureAncestorKeys(record).forEach((key) => openKeys.add(key)));
  return `
    <div class="structure-nav">
      <div class="card-title">StructureNavigator <span class="muted">${fmt(state.structureTree?.run_count || state.runsPage?.total || 0)} 个</span></div>
      <div class="structure-nav-bar">
        <input class="input structure-search" id="structure-search" type="search" placeholder="搜索结构 / 扰动 / run" value="${esc(nav.query || "")}">
        <div class="segmented structure-scope" id="structure-scope">
          <button class="${scope === "current" ? "active" : ""}" data-structure-scope="current" type="button">当前 results</button>
          <button class="${scope === "old" ? "active" : ""}" data-structure-scope="old" type="button">旧文件</button>
          <button class="${scope === "all" ? "active" : ""}" data-structure-scope="all" type="button">全部</button>
        </div>
      </div>
      <div class="structure-bands">
        ${renderStructurePins("最近使用", nav.recent || [], "recent")}
        ${renderStructurePins("收藏", nav.favorites || [], "favorite")}
      </div>
      <div class="structure-tree">${filtered.length ? filtered.map((node) => renderStructureNode(node, null, 0, openKeys, selectedKey, query)).join("") : emptySmall(query ? "未找到匹配结构" : "暂无结构树缓存")}</div>
    </div>`;
}

function renderStructurePins(title, items, kind) {
  if (!items.length) return `<div class="structure-band"><div class="structure-band-title">${esc(title)}</div><div class="muted structure-band-empty">暂无</div></div>`;
  return `<div class="structure-band"><div class="structure-band-title">${esc(title)}</div><div class="structure-pin-row">${items.slice(0, 6).map((item) => `<button class="structure-pin" data-structure-pin="${esc(item.key)}" data-structure-pin-kind="${esc(kind)}" data-structure-label="${esc(item.label || "")}" data-structure-group="${esc(item.group || "")}" data-structure-mother="${esc(item.mother || "")}" data-structure-perturbation="${esc(item.perturbation || "")}" data-structure-run="${esc(item.run_id || "")}" data-structure-scope="${esc(item.scope || "")}" type="button" title="${esc(item.label || item.key)}"><span>${esc(item.label || item.key)}</span></button>`).join("")}</div></div>`;
}

function filterStructureTree(nodes, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return nodes || [];
  const walk = (node, parent = {}) => {
    const current = {
      ...node,
      children: [],
      runs: [],
    };
    current.children = (node.children || []).map((child) => walk(child, {
      kind: node.kind || parent.kind || "",
      group: node.group || parent.group || "",
      mother: node.mother_structure || parent.mother || "",
      perturbation: node.perturbation || parent.perturbation || "",
      run_id: node.run_id || parent.run_id || "",
    })).filter(Boolean);
    current.runs = (node.runs || [])
      .map((run) => ({
        ...run,
        kind: "run",
        name: run.run_name || run.name || run.run_id,
        group: node.group || parent.group || "",
        mother_structure: node.mother_structure || parent.mother || "",
        perturbation: node.perturbation || parent.perturbation || "",
      }))
      .filter((run) => structureNodeMatchesQuery(run, q));
    const selfMatch = structureNodeMatchesQuery({
      ...node,
      group: node.group || parent.group || "",
      mother_structure: node.mother_structure || parent.mother || "",
      perturbation: node.perturbation || parent.perturbation || "",
      runs: node.runs || [],
    }, q);
    if (!selfMatch && !current.children.length && !current.runs.length) return null;
    return current;
  };
  return (nodes || []).map((node) => walk(node)).filter(Boolean);
}

function renderStructureNode(node, parent = null, level = 0, openKeys = new Set(), selectedKey = "", query = "") {
  const record = normalizeStructureRecord(node, parent || {});
  const key = record.key;
  const isSelected = key && key === selectedKey;
  const hasChildren = (node.children || []).length > 0;
  const hasRuns = (node.runs || []).length > 0;
  const canToggle = hasChildren || hasRuns;
  const expanded = query ? true : openKeys.has(key);
  const countTitle = [
    `run ${fmt(node.run_count || 0)}`,
    `full ${fmt(node.full_count || 0)}`,
    `test ${fmt(node.test_count || 0)}`,
    `high risk ${fmt(node.high_risk_count || 0)}`,
    `missing ${fmt(node.missing_evidence_count || 0)}`,
    `best ${fmt(node.best_score, 3)}`,
    `latest ${esc(node.latest_mtime || "")}`,
  ].join(" · ");
  const metaTags = `
    <span class="tag blue" title="run_count">${fmt(node.run_count || 0)}</span>
    <span class="tag green" title="full_count">${fmt(node.full_count || 0)}</span>
    <span class="tag orange" title="test_count">${fmt(node.test_count || 0)}</span>
    <span class="tag red" title="high_risk_count">${fmt(node.high_risk_count || 0)}</span>
  `;
  const toggle = canToggle ? `<button class="icon-btn structure-toggle" data-structure-toggle="${esc(key)}" type="button" aria-label="${expanded ? "收起" : "展开"}">${expanded ? "▾" : "▸"}</button>` : `<span class="structure-toggle-spacer"></span>`;
  const fav = `<button class="icon-btn structure-favorite ${isFavoriteRecord(record) ? "active" : ""}" data-structure-favorite="${esc(key)}" type="button" aria-label="收藏">${isFavoriteRecord(record) ? "★" : "☆"}</button>`;
  const selectButton = (node.kind === "perturbation" || node.kind === "run")
    ? `<button class="link structure-select" data-structure-select="${esc(key)}" data-structure-run="${esc(node.kind === "run" ? (node.run_id || "") : (node.runs?.[0]?.run_id || ""))}" title="${esc(countTitle)}">${esc(node.name || record.label || key)}</button>`
    : `<span class="structure-name" title="${esc(countTitle)}">${esc(node.name || record.label || key)}</span>`;
  return `
    <div class="structure-node level-${level} ${isSelected ? "active" : ""}" data-structure-node="${esc(key)}" data-structure-group="${esc(record.group || "")}" data-structure-mother="${esc(record.mother || "")}" data-structure-perturbation="${esc(record.perturbation || "")}" data-structure-run="${esc(record.run_id || "")}" data-structure-label="${esc(record.label || "")}" data-structure-kind="${esc(node.kind || "")}">
      <div class="structure-node-row">
        ${toggle}
        ${selectButton}
        <div class="structure-node-meta" title="${esc(countTitle)}">${metaTags}</div>
        ${fav}
      </div>
      ${expanded && hasRuns ? `<div class="structure-node-runs">${node.runs.map((run) => renderStructureNode(run, record, level + 1, openKeys, selectedKey, query)).join("")}</div>` : ""}
      ${expanded && hasChildren ? `<div class="structure-node-children">${node.children.map((child) => renderStructureNode(child, record, level + 1, openKeys, selectedKey, query)).join("")}</div>` : ""}
    </div>`;
}

function isFavoriteRecord(record) {
  const nav = ensureStructureNavigatorState();
  return (nav.favorites || []).some((item) => item.key === record.key);
}
function uniqueValues(rows, key) {
  return Array.from(new Set((rows || []).map((row) => row[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
}

function renderRunTree(runs) {
  const groups = new Map();
  runs.forEach((run) => {
    const g = run.group || "未分类";
    const m = run.mother_structure || "未识别母结构";
    const p = run.perturbation || "未识别扰动";
    if (!groups.has(g)) groups.set(g, new Map());
    if (!groups.get(g).has(m)) groups.get(g).set(m, new Map());
    if (!groups.get(g).get(m).has(p)) groups.get(g).get(m).set(p, []);
    groups.get(g).get(m).get(p).push(run);
  });
  return Array.from(groups.entries()).map(([group, mothers]) => `
    <div class="tree-block">
      <div class="tree-level level-0">${esc(group)} <span>${Array.from(mothers.values()).reduce((sum, p) => sum + Array.from(p.values()).reduce((n, rows) => n + rows.length, 0), 0)}</span></div>
      ${Array.from(mothers.entries()).map(([mother, perts]) => `
        <div class="tree-level level-1">${esc(mother)} <span>${Array.from(perts.values()).reduce((n, rows) => n + rows.length, 0)}</span></div>
        ${Array.from(perts.entries()).map(([perturbation, rows]) => `
          <div class="tree-level level-2">${esc(perturbation)} <span>${rows.length}</span></div>
          ${rows.map(runRow).join("")}
        `).join("")}
      `).join("")}
    </div>
  `).join("");
}

function runRow(r) {
  const label = r.run_name || r.run_id;
  return `<button class="tree-row run-leaf ${r.run_id === state.selectedRunId ? "active" : ""}" data-run-id="${esc(r.run_id)}" data-group="${esc(r.group || "")}" data-risk="${esc(r.risk_level || r.risk || "")}" type="button"><span class="dot ${tagTone(r.risk_level || r.risk)}"></span><span title="${esc(label)}">${esc(label)}</span><span class="tag blue">${fmt(r.sample_count || 0)}</span></button>`;
}

function renderDiagnosis() {
  const runs = state.runsPage?.runs || [];
  const d = state.diagnostics || {};
  const qFlags = d.quality?.flag_records || [];
  const imageFiles = selectedRunImageFiles();
  return `<section class="page active">
    ${pageHead("光谱诊断", "当前 run 的指标、谱线、趋势、谱图和质量旗标按需加载；优先显示 T 谱。")}
    ${runSelector(runs)}
    <div class="metric-grid">
      ${metric("最佳评分", d.best_score)}
      ${metric("λ0", d.lambda0_nm, "nm")}
      ${metric("Q", d.q)}
      ${metric("FWHM", d.fwhm_nm, "nm")}
    </div>
    <div class="layout-2"><div class="card chart-card"><div class="chart-head"><strong>T(λ) 曲线</strong><button class="btn secondary" id="load-spectrum" type="button">重载谱线</button></div><div class="chart-box"><canvas id="spectrum-chart"></canvas></div></div><div class="card pad"><div class="card-title">质量旗标</div><div id="quality-flags">${qFlags.length ? `<div class="flag-list">${qFlags.map((f) => `<div class="flag-item"><span class="dot ${f.severity === "fail" ? "red" : "orange"}"></span><span><strong>${esc(f.flag)}</strong><br><span class="muted">${esc(f.detail || "")}</span></span></div>`).join("")}</div>` : emptySmall("选择 run 后加载质量状态")}</div></div></div>
    <div class="card pad" style="margin-top:16px"><div class="card-title">谱图图片 <span class="muted">${fmt(imageFiles.length)} 张</span></div><div class="image-strip">${imageFiles.length ? imageFiles.slice(0, 18).map((f, idx) => `<button class="thumb" data-diagnosis-image="${esc(f.relative_path)}" type="button"><img src="/api/v2/files/raw?path=${encodeURIComponent(f.relative_path.replaceAll("\\", "/"))}" alt="${esc(f.name || f.relative_path)}"><span>${idx + 1}</span></button>`).join("") : emptySmall("该 run 暂无谱图 png；仍可显示 Excel/CSV 曲线。")}</div></div>
    <div class="card chart-card" style="margin-top:16px"><div class="chart-head"><strong>参数趋势</strong><button class="btn secondary" id="load-trend" type="button">加载趋势</button></div><div class="chart-box"><canvas id="trend-chart"></canvas></div></div>
  </section>`;
}

function runSelector(runs) {
  const selected = runs.find((r) => r.run_id === state.selectedRunId) || runs[0] || {};
  const group = selected.group || "";
  const mother = selected.mother_structure || "";
  const perturbation = selected.perturbation || "";
  const groups = uniqueValues(runs, "group");
  const mothers = uniqueValues(runs.filter((r) => !group || r.group === group), "mother_structure");
  const perturbations = uniqueValues(runs.filter((r) => (!group || r.group === group) && (!mother || r.mother_structure === mother)), "perturbation");
  const filteredRuns = runs.filter((r) =>
    (!group || r.group === group) &&
    (!mother || r.mother_structure === mother) &&
    (!perturbation || r.perturbation === perturbation)
  );
  return `<div class="run-cascade">
    <select class="select run-level-select" id="run-group-select" data-run-level="group"><option value="">全部群类别</option>${groups.map((x) => `<option value="${esc(x)}" ${x === group ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
    <select class="select run-level-select" id="run-mother-select" data-run-level="mother"><option value="">全部母结构</option>${mothers.map((x) => `<option value="${esc(x)}" ${x === mother ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
    <select class="select run-level-select" id="run-perturbation-select" data-run-level="perturbation"><option value="">全部扰动</option>${perturbations.map((x) => `<option value="${esc(x)}" ${x === perturbation ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
    <select class="select" id="run-select">${filteredRuns.map((r) => `<option value="${esc(r.run_id)}" ${r.run_id === state.selectedRunId ? "selected" : ""}>${esc(r.run_name || r.run_id)}</option>`).join("")}</select>
    <button class="btn secondary" id="load-run-diagnostics" type="button">加载当前 run</button>
  </div>`;
}

function bindRunCascade(root, onChange) {
  const pickFirst = () => {
    const runs = state.runsPage?.runs || [];
    const group = $("#run-group-select", root)?.value || "";
    const mother = $("#run-mother-select", root)?.value || "";
    const perturbation = $("#run-perturbation-select", root)?.value || "";
    const match = runs.find((r) =>
      (!group || r.group === group) &&
      (!mother || r.mother_structure === mother) &&
      (!perturbation || r.perturbation === perturbation)
    );
    if (match) state.selectedRunId = match.run_id;
  };
  $$(".run-level-select", root).forEach((select) => select.addEventListener("change", async () => {
    if (select.dataset.runLevel === "group") {
      const mother = $("#run-mother-select", root);
      const perturbation = $("#run-perturbation-select", root);
      if (mother) mother.value = "";
      if (perturbation) perturbation.value = "";
    }
    if (select.dataset.runLevel === "mother") {
      const perturbation = $("#run-perturbation-select", root);
      if (perturbation) perturbation.value = "";
    }
    pickFirst();
    await onChange();
  }));
  $("#run-select", root)?.addEventListener("change", async (event) => {
    state.selectedRunId = event.target.value;
    await onChange();
  });
}

function metric(label, value, unit = "") {
  return `<div class="metric"><label>${esc(label)}</label><strong>${fmt(value, 2)} ${esc(unit)}</strong></div>`;
}

function renderTopology() {
  const runs = state.runsPage?.runs || [];
  const relay = state.relay || {};
  const imageFiles = selectedRunImageFiles();
  return `<section class="page active">
    ${pageHead("模式接力 / 拓扑候选", "本页仅做候选筛选，不等价于严格拓扑证明。")}
    <div class="notice">本页仅为候选筛选；严格证明仍需 k-space 扫描、带隙演化、相位连续性与缠绕数验证。</div>
    ${runSelector(runs)}
    <div class="metric-grid">
      ${metric("候选强度", relay.candidate_strength)}
      ${metric("代表样本数", relay.representative_sample_count)}
      ${metric("证据缺口", relay.evidence_gaps?.length)}
      <div class="metric"><label>临界区间</label><strong>${esc(relay.critical_interval || "-")}</strong></div>
    </div>
    <div class="layout-2"><div class="card chart-card"><div class="chart-head"><strong>T(λ,δ) 热图</strong><button class="btn secondary" id="load-heatmap" type="button">重载热图</button></div><div class="chart-box"><canvas id="heatmap-chart"></canvas></div></div><div class="card pad"><div class="card-title">证据缺口 / Todo</div>${(relay.evidence_gaps || []).concat(relay.todo || []).length ? `<div class="flag-list">${(relay.evidence_gaps || []).concat(relay.todo || []).map((x) => `<div class="flag-item"><span class="dot orange"></span><span>${esc(x)}</span></div>`).join("")}</div>` : emptySmall("选择 run 后加载")}</div></div>
    <div class="card pad" style="margin-top:16px"><div class="card-title">代表谱图 <span class="muted">${fmt(imageFiles.length)} 张</span></div><div class="image-strip">${imageFiles.length ? imageFiles.slice(0, 18).map((f, idx) => `<button class="thumb" data-diagnosis-image="${esc(f.relative_path)}" type="button"><img src="/api/v2/files/raw?path=${encodeURIComponent(f.relative_path.replaceAll("\\", "/"))}" alt="${esc(f.name || f.relative_path)}"><span>${idx + 1}</span></button>`).join("") : emptySmall("该 run 暂无谱图 png；可先用热图和峰位轨迹判断候选。")}</div></div>
  </section>`;
}

function renderQuality() {
  const q = state.quality || {};
  const flags = q.flags || [];
  return `<section class="page active">
    ${pageHead("质量审计", "聚合 quality_cache 中的严重问题、警告、缺失证据和复跑建议。", `<button class="btn secondary" id="dry-run-manager" type="button">结果整理 dry-run</button>`)}
    <div class="stat-grid">${statCard("严重问题", q.serious_count || 0, "severity=fail/serious")}${statCard("警告数量", q.warning_count || 0, "需要复核")}${statCard("缺失证据", q.missing_evidence_count || 0, "补做实验候选")}${statCard("通过样本", q.passed_count || 0, "无旗标 run")}${statCard("待复跑", q.rerun_suggested_count || 0, "按风险估算")}</div>
    <div class="card pad"><div class="card-title">异常列表</div>${flags.length ? `<table class="table"><thead><tr><th>run</th><th>旗标</th><th>级别</th><th>建议</th></tr></thead><tbody>${flags.slice(0, 220).map((f) => `<tr><td>${esc(f.run_id || "")}</td><td>${esc(f.flag || "")}<br><span class="muted">${esc(f.detail || "")}</span></td><td><span class="tag ${f.severity === "fail" || f.severity === "serious" ? "red" : "orange"}">${esc(f.severity || "")}</span></td><td>${esc(f.suggestion || "")}</td></tr>`).join("")}</tbody></table>` : emptySmall("暂无质量旗标")}</div>
  </section>`;
}

function ensureSupplementUIState() {
  if (!state.supplementUI) {
    state.supplementUI = { selectedKeys: new Set(), focusedKey: "", expandedRuns: new Set(), step: 1, lastCreatedPackageId: "" };
  }
  if (!(state.supplementUI.selectedKeys instanceof Set)) state.supplementUI.selectedKeys = new Set(state.supplementUI.selectedKeys || []);
  if (!(state.supplementUI.expandedRuns instanceof Set)) state.supplementUI.expandedRuns = new Set(state.supplementUI.expandedRuns || []);
  if (!Number.isFinite(Number(state.supplementUI.step))) state.supplementUI.step = 1;
  if (!state.supplementUI.lastCreatedPackageId) state.supplementUI.lastCreatedPackageId = "";
  return state.supplementUI;
}

function setSupplementStep(step) {
  const ui = ensureSupplementUIState();
  ui.step = Math.max(1, Math.min(3, Number(step) || 1));
}

function supplementRunKey(runId) {
  return safeDomKey(runId || "");
}

function supplementSelectedItems(items) {
  const ui = ensureSupplementUIState();
  return (items || []).filter((item) => ui.selectedKeys.has(supplementKey(item)));
}

function supplementRunStats(rows) {
  const first = rows[0] || {};
  const sampleCount = rows.length;
  const missingTypes = Array.from(new Set(rows.flatMap((item) => item.missing_evidence || []))).filter(Boolean);
  const hasMasterTemplate = rows.some((item) => !!item.has_master_template_fsp);
  const risk = first.risk_level || first.risk || "medium";
  return {
    runId: first.run_id || "",
    runName: first.run_name || first.run_id || "",
    group: first.group || "",
    mother: first.mother_structure || "",
    perturbation: first.perturbation || "",
    sampleCount,
    missingTypes,
    risk,
    riskLabel: first.risk_label || first.risk || "",
    hasMasterTemplate,
  };
}

function supplementSummaryChips(item) {
  const missing = (item.missing_evidence || []).slice(0, 3);
  return [
    `<span class="tag ${tagTone(item.risk_level || item.risk || "")}">${esc(item.risk_label || item.risk || "未知风险")}</span>`,
    `<span class="tag blue">${fmt(item.sample_count || 1, 0)} 样本</span>`,
    `<span class="tag ${item.has_master_template_fsp ? "green" : "orange"}">${item.has_master_template_fsp ? "master_template 已有" : "缺 master_template"}</span>`,
    missing.length ? `<span class="tag">${esc(missing.join(" · "))}</span>` : "",
  ].filter(Boolean).join(" ");
}

function renderSupplement() {
  const allItems = state.missing?.items || [];
  allItems.forEach((item, index) => { item.__sourceIndex = index; });
  const q = state.supplementSearch.trim().toLowerCase();
  const items = q ? allItems.filter((item) => JSON.stringify(item).toLowerCase().includes(q)) : allItems;
  const visibleItems = items.slice(0, state.supplementVisibleLimit);
  const packages = state.packages?.packages || state.supplements || [];
  const ui = ensureSupplementUIState();
  const selectedItems = supplementSelectedItems(allItems);
  const focusItem = selectedItems.find((item) => supplementKey(item) === ui.focusedKey) || selectedItems[0] || visibleItems[0] || items[0] || null;
  const selectedCount = selectedItems.length;
  return `<section class="page active">
    ${pageHead("补做实验", "三步流程：先选目标，再确认母文件与监视器策略，最后生成任务包。")}
    <div class="notice">Step 2 只修改任务包里复制出来的 <code>master_template.fsp</code>，不修改原始 run。任务包删除时也只会针对 V2 patch 包目录。</div>
    <div class="stepper">
      <button class="stepper-item ${ui.step === 1 ? "active" : ""}" data-supplement-step="1" type="button"><span>1</span><strong>选择补做目标</strong></button>
      <button class="stepper-item ${ui.step === 2 ? "active" : ""}" data-supplement-step="2" type="button"><span>2</span><strong>确认母文件与监视器</strong></button>
      <button class="stepper-item ${ui.step === 3 ? "active" : ""}" data-supplement-step="3" type="button"><span>3</span><strong>生成任务包 / 打开任务包</strong></button>
    </div>
    <div class="results-layout supplement-layout">
      <div class="card pad supplement-tree-card">
        <div class="card-title">Step 1 选择补做目标 <span class="muted">${fmt(selectedCount, 0)} 已选 · ${fmt(visibleItems.length)} / ${fmt(items.length)} / ${fmt(allItems.length)} 条</span></div>
        <div class="toolbar supplement-toolbar">
          <select class="select" id="supplement-type" style="max-width:220px">
            <option value="field">Field</option>
            <option value="phase">Phase</option>
            <option value="poynting">Poynting</option>
            <option value="R">R</option>
            <option value="A">A</option>
            <option value="angle-resolved">angle-resolved</option>
            <option value="band sweep">band sweep</option>
          </select>
          <input class="input" id="supplement-search" placeholder="搜索 run、样本、缺失类型、风险" value="${esc(state.supplementSearch)}">
        </div>
        ${visibleItems.length ? `<div class="supplement-tree">${renderSupplementTree(visibleItems)}</div>${items.length > visibleItems.length ? `<div class="toolbar" style="margin-top:12px"><button class="btn secondary" id="load-more-supplement" type="button">加载更多 ${Math.min(420, items.length - visibleItems.length)} 条</button><span class="muted">搜索可缩小目标范围。</span></div>` : ""}` : emptySmall("暂无待补做样本")}
      </div>
      <div class="supplement-main">
        <div class="card pad supplement-step-card">
          <div class="card-title">Step 2 确认母文件与监视器策略</div>
          <div class="notice">只会在任务包内部复制出来的 <code>master_template.fsp</code> 上修改监视器策略，不会直接改原始 run。</div>
          ${renderSupplementDetailPanel(focusItem, selectedItems)}
        </div>
        <div class="card pad supplement-step-card">
          <div class="card-title">Step 3 生成任务包 / 打开任务包</div>
          <div class="toolbar" style="gap:8px;flex-wrap:wrap">
            <button class="btn primary" id="create-package" type="button" ${selectedCount ? "" : "disabled"}>生成任务包</button>
            ${ui.lastCreatedPackageId ? `<button class="btn secondary" data-show-package="${esc(ui.lastCreatedPackageId)}" type="button">打开上次任务包</button>` : ""}
          </div>
          <div class="muted" style="margin-top:8px">仅支持同一个 run；当前已选 ${fmt(selectedCount, 0)} 个样本。</div>
          <div class="package-list" style="margin-top:12px">${packages.length ? packages.slice(0, 40).map((p) => renderSupplementPackageRow(p)).join("") : emptySmall("暂无补做任务包")}</div>
        </div>
      </div>
    </div>
  </section>`;
}

function renderSupplementDetailPanel(focusItem, selectedItems) {
  if (!focusItem) return emptySmall("先在左侧勾选一个补做目标。");
  const templatePath = focusItem.master_template_fsp_path || "";
  const sourceFsp = focusItem.source_fsp || focusItem.source_fsp_path || focusItem.work_fsp_dir || "";
  const sourceRun = focusItem.source_run_dir || focusItem.source_run_path || focusItem.source_run_abs_path || "";
  const missing = (focusItem.selected_missing_evidence || focusItem.missing_evidence || []).join("、") || "无";
  const reason = focusItem.reason || "请选择补做目标后查看具体缺失原因。";
  return `
    <table class="table supplement-detail">
      <tbody>
        <tr><td>run</td><td>${esc(focusItem.run_name || focusItem.run_id || "")}</td></tr>
        <tr><td>sample</td><td>${esc(focusItem.sample_id || "")} · δ ${esc(focusItem.delta ?? "-")}</td></tr>
        <tr><td>λ0 / Q / FWHM</td><td>${fmt(focusItem.lambda0_nm, 2)} / ${fmt(focusItem.Q, 1)} / ${fmt(focusItem.FWHM_nm, 3)}</td></tr>
        <tr><td>source_fsp</td><td>${sourceFsp ? `<span class="mono">${esc(sourceFsp)}</span>` : "无"}</td></tr>
        <tr><td>master_template</td><td>${templatePath ? `<span class="mono">${esc(templatePath)}</span>` : "未找到"}</td></tr>
        <tr><td>源 run 目录</td><td>${sourceRun ? `<span class="mono">${esc(sourceRun)}</span>` : "未知"}</td></tr>
        <tr><td>缺失原因</td><td>${esc(missing)}<br><span class="muted">${esc(reason)}</span></td></tr>
        <tr><td>已选样本</td><td>${fmt(selectedItems.length, 0)} 个</td></tr>
      </tbody>
    </table>
    <div class="muted" style="margin-top:8px">Step 2 只改任务包内复制出来的母文件，原始 run 目录保持只读。</div>
  `;
}

function renderSupplementPackageRow(p) {
  return `<div class="package-row patch-package">
    <div>
      <strong>${esc(p.package_id)}</strong><br>
      <span class="muted">${esc(p.source_run_id || "")}</span><br>
      <span class="muted mono">${esc(p.output_root || p.relative_path || "")}</span>
    </div>
    <span>${esc(p.status || "")}</span>
    <span>${esc(p.created_at || "")}</span>
    <button class="btn ghost" data-show-package="${esc(p.package_id)}" type="button">详情</button>
    <button class="btn danger" data-delete-package="${esc(p.package_id)}" type="button">删除</button>
  </div>`;
}

function renderSupplementTree(items) {
  const runs = new Map();
  items.forEach((item, index) => {
    item.__index = Number.isFinite(item.__sourceIndex) ? item.__sourceIndex : index;
    const runId = item.run_id || "unknown_run";
    if (!runs.has(runId)) runs.set(runId, []);
    runs.get(runId).push(item);
  });
  const ui = ensureSupplementUIState();
  const selectedKeys = ui.selectedKeys || new Set();
  return Array.from(runs.entries()).map(([runId, rows]) => renderSupplementRunNode(runId, rows, selectedKeys, ui.expandedRuns || new Set())).join("");
}

function renderSupplementRunNode(runId, rows, selectedKeys, expandedRuns) {
  const stats = supplementRunStats(rows);
  const runKey = supplementRunKey(runId);
  const isExpanded = expandedRuns.has(runKey) || rows.some((item) => selectedKeys.has(supplementKey(item)));
  return `<div class="supplement-run ${isExpanded ? "open" : ""}" data-supplement-run="${esc(runKey)}" data-supplement-run-id="${esc(runId)}">
    <button class="supplement-run-head" data-supplement-toggle-run="${esc(runKey)}" type="button">
      <label class="supplement-run-check" title="选择该 run 下全部样本">
        <input type="checkbox" data-supplement-run-check="${esc(runKey)}" data-run-id="${esc(runId)}" ${rows.every((item) => selectedKeys.has(supplementKey(item))) ? "checked" : ""}>
      </label>
      <div class="supplement-run-meta">
        <strong>${esc(stats.runName || runId)}</strong>
        <span>${esc(stats.group || "")} / ${esc(stats.mother || "")} / ${esc(stats.perturbation || "")}</span>
      </div>
      <div class="supplement-run-tags">
        <span class="tag blue">${fmt(stats.sampleCount, 0)} 样本</span>
        <span class="tag ${tagTone(stats.risk)}">${esc(stats.riskLabel || stats.risk || "")}</span>
        <span class="tag ${stats.hasMasterTemplate ? "green" : "orange"}">${stats.hasMasterTemplate ? "master_template 有" : "缺 master_template"}</span>
        ${stats.missingTypes.slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}
      </div>
    </button>
    <div class="supplement-run-body">
      ${rows.map((item) => renderSupplementSampleNode(runKey, item, selectedKeys)).join("")}
    </div>
  </div>`;
}

function renderSupplementSampleNode(runKey, item, selectedKeys) {
  const key = supplementKey(item);
  const missing = (item.missing_evidence || []).slice(0, 4);
  const selected = selectedKeys.has(key);
  return `<div class="supplement-sample ${selected ? "active" : ""}" data-supplement-sample="${esc(key)}" data-supplement-run-id="${esc(item.run_id || "")}" data-item-index="${esc(item.__index)}">
    <label class="supplement-sample-head">
      <input type="checkbox" data-supplement-sample-check="${esc(key)}" data-parent-run="${esc(runKey)}" data-item-index="${esc(item.__index)}" ${selected ? "checked" : ""}>
      <span class="supplement-sample-title">样本 ${esc(item.sample_id || "")}</span>
      <span class="supplement-sample-delta">δ ${esc(item.delta ?? "-")}</span>
    </label>
    <div class="supplement-sample-tags">
      ${supplementSummaryChips(item)}
      ${missing.length ? `<span class="tag">${esc(missing.join(" · "))}</span>` : ""}
    </div>
  </div>`;
}

function supplementKey(item) {
  return [item.run_id, item.sample_id].map((x) => String(x ?? "").replaceAll("|", "_")).join("|");
}

function safeDomKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, "_");
}

function renderResources() {
  const files = state.resourcesPage?.files || state.resourcesPage?.resources || [];
  return `<section class="page active">
    ${pageHead("资源浏览", "资源列表来自 resource_index_light 分页缓存；文件内容只有点击预览时读取。")}
    <div class="layout-2"><div class="card pad"><div class="card-title">资源索引 <span class="muted">${fmt(state.resourcesPage?.total || files.length)} 个</span></div>${files.length ? `<div class="resource-list">${files.map((f) => `<button class="resource-row" data-file-path="${esc(f.relative_path)}" type="button"><strong>${esc(f.relative_path)}</strong><span>${esc(f.kind || f.extension || "")}</span><span>${fmt(f.size || 0)} B</span></button>`).join("")}</div>` : emptySmall("暂无资源缓存")}</div><div class="card pad"><div class="card-title">文件预览</div><div id="resource-preview" class="preview-pane">选择文件后显示预览。</div></div></div>
  </section>`;
}

async function afterRender(route) {
  const root = $("#page-root");
  if (route === "overview") bindOverview(root);
  if (route === "run") bindRun(root);
  if (route === "results") bindResults(root);
  if (route === "diagnosis") bindDiagnosis(root);
  if (route === "topology") bindTopology(root);
  if (route === "quality") bindQuality(root);
  if (route === "supplement") bindSupplement(root);
  if (route === "resources") bindResources(root);
}

function bindOverview(root) {
  $("#first-index", root)?.addEventListener("click", () => refreshIndex(false));
  $$("[data-run-jump]", root).forEach((row) => row.addEventListener("click", () => {
    state.selectedRunId = row.dataset.runJump;
    navigate("diagnosis");
  }));
}

function activeValue(root, id) {
  return $(`#${id} .active`, root)?.dataset.value;
}

function collectRunPayload(root) {
  const wildcard = {};
  [
    ["start-value", "START_NM"], ["end-value", "END_NM"], ["step-value", "STEP_NM"],
    ["mesh-accuracy", "MESH_ACCURACY"], ["dt-factor", "DT_STABILITY_FACTOR"],
    ["runtime-fs", "SIMULATION_TIME_FS"], ["auto-shutoff", "AUTO_SHUTOFF_MIN"],
  ].forEach(([id, key]) => {
    const raw = $(`#${id}`, root)?.value;
    if (raw !== "") wildcard[key] = Number(raw);
  });
  return {
    mode: activeValue(root, "mode-control") || "preview",
    style: activeValue(root, "style-control") || "sequential",
    max_parallel: Number($("#max-parallel", root)?.value || 2),
    ids: Array.from(state.selectedScriptIds),
    overrides: Object.keys(wildcard).length ? { "*": wildcard } : {},
    child_timeout_s: Number($("#child-timeout", root)?.value || 3600),
  };
}

function stablePayloadString(value) {
  if (Array.isArray(value)) return `[${value.map(stablePayloadString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stablePayloadString(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function runPayloadHash(payload) {
  return stablePayloadString({
    ids: (payload.ids || []).map((x) => String(x)),
    mode: payload.mode || "preview",
    style: payload.style || "sequential",
    max_parallel: Number(payload.max_parallel || 2),
    overrides: payload.overrides || {},
    child_timeout_s: Number(payload.child_timeout_s || 3600),
  });
}

function runPreviewMatchesCurrent(root) {
  return state.runPreview?.valid && state.runPreview.payloadHash === runPayloadHash(collectRunPayload(root));
}

function updateRunPreviewControls(root) {
  const current = runPayloadHash(collectRunPayload(root));
  const preview = state.runPreview || {};
  if (preview.valid && preview.payloadHash !== current) {
    state.runPreview.valid = false;
    state.runPreview.dirtyReason = "参数已变化，请重新预览";
  }
  const startAllowed = !!(state.runPreview?.valid && state.runPreview.payloadHash === current);
  [$("#start-run", root), $("#bottom-start", root)].filter(Boolean).forEach((btn) => {
    btn.disabled = !startAllowed;
  });
  const status = $("#run-preview-status", root);
  if (status) {
    if (startAllowed) status.textContent = "已预览，可启动";
    else if (state.runPreview?.dirtyReason) status.textContent = state.runPreview.dirtyReason;
    else status.textContent = "未预览";
  }
}

function invalidateRunPreview(root, reason = "参数已变化，请重新预览") {
  state.runPreview = {
    ...(state.runPreview || {}),
    valid: false,
    dirtyReason: reason,
  };
  updateRunPreviewControls(root);
}

function bindRun(root) {
  const invalidate = () => invalidateRunPreview(root);
  $$(".tree-row[data-script-id]", root).forEach((row) => row.addEventListener("click", () => {
    const id = row.dataset.scriptId;
    if (state.selectedScriptIds.has(id)) state.selectedScriptIds.delete(id);
    else state.selectedScriptIds.add(id);
    row.classList.toggle("active");
    $("#selected-script-count", root).textContent = state.selectedScriptIds.size;
    invalidate();
  }));
  $$(".segmented", root).forEach((seg) => seg.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    $$("button", seg).forEach((b) => b.classList.toggle("active", b === btn));
    invalidate();
  }));
  root.__runPreviewDirtyHandler && root.removeEventListener("input", root.__runPreviewDirtyHandler);
  root.__runPreviewDirtyHandler = (event) => {
    if (!event.target.closest("#mode-control, #style-control, #max-parallel, #start-value, #end-value, #step-value, #mesh-accuracy, #dt-factor, #runtime-fs, #auto-shutoff, #child-timeout")) return;
    invalidate();
  };
  root.addEventListener("input", root.__runPreviewDirtyHandler);
  root.addEventListener("change", root.__runPreviewDirtyHandler);
  $("#refresh-scripts", root)?.addEventListener("click", async () => {
    await api.refreshScripts();
    state.scriptsPage = null;
    toast("脚本缓存已刷新。", "success");
    await renderRoute();
  });
  $("#preview-run", root)?.addEventListener("click", async () => {
    try {
      const payload = collectRunPayload(root);
      const preview = await api.controllerPreview(payload);
      const plan = preview.resolved_execution_plan || preview.job_preview || {};
      const command = preview.command || plan.command || [];
      state.runPreview = {
        payloadHash: preview.payload_hash || runPayloadHash(payload),
        previewHash: preview.preview_hash || "",
        executionPlan: plan,
        valid: true,
        warnings: preview.warnings || plan.warnings || [],
        dirtyReason: "",
      };
      $("#point-estimate", root).textContent = plan.estimated_points || preview.estimated_points || "按脚本默认";
      $("#duration-estimate", root).textContent = plan.estimated_runtime || preview.estimated_duration || "无法估算";
      state.jobLog.data = {
        text: Array.isArray(command) ? command.join(" ") : String(command || ""),
        raw_text: Array.isArray(command) ? command.join(" ") : String(command || ""),
        structured_lines: [],
        collapsed_count: 0,
        encoding_warning: "",
      };
      renderJobLogPanel(root);
      updateRunPreviewControls(root);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  const start = () => {
    const payload = collectRunPayload(root);
    if (!payload.ids.length) return toast("请先选择至少一个脚本。", "error");
    if (!state.runPreview?.valid || state.runPreview.payloadHash !== runPayloadHash(payload)) {
      return toast("参数已变化，请重新预览。", "error");
    }
    const highRisk = payload.mode === "full" && payload.style === "parallel";
    const plan = state.runPreview.executionPlan || {};
    const accepted = Array.isArray(plan.overrides_accepted) ? plan.overrides_accepted : [];
    const rejected = Array.isArray(plan.overrides_rejected) ? plan.overrides_rejected : [];
    const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
    const modalBody = `
      <table class="table">
        <tbody>
          <tr><td>脚本数量</td><td>${fmt(plan.script_count ?? payload.ids.length)}</td></tr>
          <tr><td>mode</td><td>${esc(payload.mode)}</td></tr>
          <tr><td>style</td><td>${esc(payload.style)}</td></tr>
          <tr><td>并发数</td><td>${fmt(payload.max_parallel, 0)}</td></tr>
          <tr><td>overrides_accepted</td><td>${esc(accepted.length ? accepted.join(", ") : "无")}</td></tr>
          <tr><td>overrides_rejected</td><td>${esc(rejected.length ? rejected.join(", ") : "无")}</td></tr>
          <tr><td>risk_level</td><td>${esc(plan.risk_level || (highRisk ? "high" : "low"))}</td></tr>
          <tr><td>warnings</td><td>${esc(warnings.length ? warnings.join("；") : "无")}</td></tr>
        </tbody>
      </table>
    `;
    openModal({
      title: highRisk ? "高风险启动确认" : "启动确认",
      danger: highRisk,
      confirmText: highRisk ? "确认 full 并行启动" : "确认启动",
      body: `${highRisk ? "<p>full + parallel 可能占用大量内存。</p>" : "<p>将通过 fdtd_master_controller.py 启动任务。</p>"}${modalBody}<pre class=\"mono\">${esc(JSON.stringify({ preview_hash: state.runPreview.previewHash, payload_hash: state.runPreview.payloadHash, ids: payload.ids, mode: payload.mode, style: payload.style, max_parallel: payload.max_parallel }, null, 2))}</pre>`,
      onConfirm: async () => {
        const job = await api.controllerStart({ ...payload, preview_hash: state.runPreview.previewHash, payload_hash: state.runPreview.payloadHash, confirm: true, risk_ack: highRisk });
        state.activeJobId = job.job_id;
        state.jobLog.data = {
          text: `任务已启动：${job.job_id}\n${Array.isArray(job.command) ? job.command.join(" ") : job.command}`,
          raw_text: `任务已启动：${job.job_id}\n${Array.isArray(job.command) ? job.command.join(" ") : job.command}`,
          structured_lines: [],
          collapsed_count: 0,
          encoding_warning: "",
        };
        renderJobLogPanel(root);
        pollJob(root);
      },
    });
  };
  $("#start-run", root)?.addEventListener("click", start);
  $("#bottom-start", root)?.addEventListener("click", start);
  $("#clear-selected", root)?.addEventListener("click", () => {
    state.selectedScriptIds.clear();
    $$(".tree-row.active", root).forEach((row) => row.classList.remove("active"));
    $("#selected-script-count", root).textContent = "0";
    invalidate();
  });
  $("#stop-job", root)?.addEventListener("click", async () => {
    if (!state.activeJobId) return toast("当前没有可停止任务。", "error");
    await api.stopJob(state.activeJobId);
    toast("已发送停止请求。", "success");
  });
  root.addEventListener("click", (event) => {
    const modeBtn = event.target.closest("[data-job-log-mode]");
    if (modeBtn) {
      const jobLog = ensureJobLogState();
      jobLog.mode = modeBtn.dataset.jobLogMode || "all";
      renderJobLogPanel(root);
      return;
    }
    const copyBtn = event.target.closest("[data-job-log-copy]");
    if (copyBtn) {
      const jobLog = ensureJobLogState();
      const text = jobLogPlainText(jobLog.data || {});
      copyText(String(text || "")).then(() => toast("日志已复制。", "success")).catch((error) => toast(error.message, "error"));
      return;
    }
    const downloadBtn = event.target.closest("[data-job-log-download]");
    if (downloadBtn) {
      const jobLog = ensureJobLogState();
      const text = jobLogPlainText(jobLog.data || {});
      downloadText(`fdtd_job_log_${state.activeJobId || "current"}.txt`, String(text || ""));
    }
  });
  root.addEventListener("input", (event) => {
    if (event.target.id !== "job-log-search") return;
    const jobLog = ensureJobLogState();
    jobLog.search = event.target.value || "";
    renderJobLogPanel(root);
  });
  root.addEventListener("change", (event) => {
    if (event.target.id !== "job-log-auto-scroll") return;
    const jobLog = ensureJobLogState();
    jobLog.autoScroll = !!event.target.checked;
    renderJobLogPanel(root);
  });
  updateRunPreviewControls(root);
}

function stopResultAutoplay() {
  if (state.resultAutoplayTimer) {
    clearInterval(state.resultAutoplayTimer);
    state.resultAutoplayTimer = null;
  }
}

async function pollJob(root) {
  if (!state.activeJobId) return;
  try {
    const [log, job] = await Promise.all([api.jobLog(state.activeJobId), api.job(state.activeJobId)]);
    state.jobLog = {
      ...(ensureJobLogState()),
      jobId: state.activeJobId,
      data: log || {},
    };
    renderJobLogPanel(root, log);
    if (job.status === "running" || job.status === "stopping") {
      setTimeout(() => pollJob(root), 1500);
    } else {
      const changes = await api.cacheChanges(job.created_at || "");
      toast(`任务结束，已增量索引 ${changes.changed_runs?.length || 0} 个 run。`, "success");
      await bootstrap();
    }
  } catch (error) {
    state.jobLog.data = {
      text: error.message,
      raw_text: error.message,
      structured_lines: [],
      collapsed_count: 0,
      encoding_warning: "",
    };
    renderJobLogPanel(root);
  }
}

function sampleRiskTone(sample) {
  const flags = sample.quality_flags || [];
  const maxT = Number(sample.max_T ?? sample.max_t);
  if (flags.includes("T > 1") || (Number.isFinite(maxT) && maxT > 1)) return "bad";
  if (flags.some((x) => String(x).includes("FWHM")) || (sample.missing_evidence || []).length) return "warn";
  return "ok";
}

function sampleEvidenceText(sample) {
  return [...(sample.quality_flags || []), ...(sample.missing_evidence || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function sampleMissingReason(sample, field) {
  const text = sampleEvidenceText(sample);
  const hasPeak = /peak|选峰|峰/.test(text);
  const hasSpectrum = /spectrum|spectra|谱/.test(text);
  const hasFailure = /识别|identify|fit|failed|error|失败/.test(text);
  const lambdaValue = sample.lambda0_nm ?? sample.lambda0;
  const hasLambda0 = lambdaValue !== null && lambdaValue !== undefined && lambdaValue !== "" && Number.isFinite(Number(lambdaValue));
  if (field === "lambda0") {
    if (hasPeak) return "需选择峰";
    if (hasSpectrum) return "缺谱线";
    if (hasFailure) return "识别失败";
    return "未计算";
  }
  if (field === "q" || field === "fwhm") {
    if (hasPeak || !hasLambda0) return "需选择峰";
    if (hasSpectrum) return "缺谱线";
    if (hasFailure) return "识别失败";
    return "未计算";
  }
  if (field === "maxT") {
    if (hasSpectrum) return "缺谱线";
    if (hasFailure) return "识别失败";
    return "未计算";
  }
  return "未计算";
}

function sampleMetricChip(label, value, digits, reason) {
  const hasValue = value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  if (hasValue) {
    const text = `${label} ${fmt(value, digits)}`;
    return `<span class="sample-chip" title="${esc(text)}">${esc(text)}</span>`;
  }
  const text = `${label} ${reason}`;
  return `<span class="sample-chip empty" title="${esc(text)}">${esc(text)}</span>`;
}

function sampleRow(sample, index) {
  const tone = sampleRiskTone(sample);
  const flags = sample.quality_flags || [];
  const missing = sample.missing_evidence || [];
  const maxT = Number(sample.max_T ?? sample.max_t);
  const status = flags.includes("T > 1") || (Number.isFinite(maxT) && maxT > 1)
    ? { text: "不收敛：T > 1", tone: "bad" }
    : { text: tone === "ok" ? "质量正常" : "需复核", tone };
  const evidence = [...missing, ...flags].slice(0, 5).join(", ");
  const tooltip = evidence ? `${status.text}｜${evidence}` : status.text;
  const metrics = [
    sampleMetricChip("λ0", sample.lambda0_nm ?? sample.lambda0, 2, sampleMissingReason(sample, "lambda0")),
    sampleMetricChip("Q", sample.Q ?? sample.q, 1, sampleMissingReason(sample, "q")),
    sampleMetricChip("FWHM", sample.FWHM_nm ?? sample.fwhm_nm, 3, sampleMissingReason(sample, "fwhm")),
    sampleMetricChip("Tmax", sample.max_T ?? sample.max_t, 3, sampleMissingReason(sample, "maxT")),
  ].join("");
  const manualTag = sample.manual_verified ? `<span class="tag green" title="manual verified">manual verified</span>` : "";
  return `<tr class="sample-row ${state.selectedSampleId === String(sample.sample_id) ? "active" : ""}" data-sample-index="${index}" data-sample-id="${esc(sample.sample_id)}" title="${esc(tooltip)}">
    <td><button class="link sample-name" data-sample-index="${index}" type="button">${esc(sample.sample_id)}</button></td>
    <td><div class="sample-delta">${esc(sample.delta ?? "未提供")}</div><div class="muted sample-params">${esc(sample.param_text || sample.perturbation || "")}</div></td>
    <td><div class="sample-status"><span class="flag-text ${status.tone}" title="${esc(tooltip)}">${esc(status.text)}</span>${manualTag}${evidence ? `<span class="muted sample-status-note" title="${esc(evidence)}">${esc(evidence)}</span>` : ""}</div></td>
    <td>${fmt(sample.score, 3)}</td>
    <td><div class="sample-actions">${metrics}<button class="link" data-sample-index="${index}" type="button">详情</button></div></td>
  </tr>`;
}
function getRunImages(detail) {
  const files = detail?.files || [];
  const images = files.filter((f) => f.kind === "image" || /\.(png|jpg|jpeg|webp)$/i.test(f.relative_path || ""));
  const preferred = images.filter((f) => /03_|transmission|abs2|spectrum|png/i.test(f.relative_path || ""));
  return (preferred.length ? preferred : images).slice(0, 300);
}

function selectedRunImageFiles() {
  const detail = state.runDetails.get(state.selectedRunId);
  return getRunImages(detail);
}

function resourceChips(files) {
  const wanted = files.filter((f) => ["image", "xlsx", "csv", "fsp"].includes(f.kind) || ["xlsx", "csv", "fsp", "png", "jpg"].includes(f.extension)).slice(0, 60);
  if (!wanted.length) return "该 run 暂无可快速预览的谱图、表格或 FSP。";
  return wanted.map((f) => `<button class="resource-chip" data-file-path="${esc(f.relative_path)}" type="button">${esc(f.kind || f.extension)} · ${esc(f.name || f.relative_path)}</button>`).join("");
}

function normalizeSpectrumPoints(points) {
  return (points || [])
    .map((point) => {
      if (Array.isArray(point)) {
        return { x: Number(point[0]), y: Number(point[1]) };
      }
      return { x: Number(point?.x ?? point?.lambda_nm ?? point?.lambda), y: Number(point?.y ?? point?.T ?? point?.value) };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function currentPeakFeatureType(root) {
  const active = root.querySelector("[data-peak-feature].active");
  return active?.dataset.peakFeature || ensureSampleSpectrumState().featureType || "auto";
}

function ensureSampleSpectrumState() {
  if (!state.sampleSpectrum) {
    state.sampleSpectrum = { controller: null, data: null, sampleId: "", featureType: "auto", selection: null, lastResult: null, requestSeq: 0, lastSavedManual: false };
  }
  if (!state.sampleSpectrum.featureType) state.sampleSpectrum.featureType = "auto";
  return state.sampleSpectrum;
}

function setPeakFeatureType(root, featureType) {
  const spec = ensureSampleSpectrumState();
  spec.featureType = featureType || "auto";
  $("#peak-feature-mode", root)?.querySelectorAll("button")?.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.peakFeature === spec.featureType);
  });
}

function peakMarkersFromResult(result) {
  const metrics = result?.metrics || result || {};
  const markers = {
    vertical: [],
    horizontal: [],
    selection: null,
  };
  if (Number.isFinite(Number(metrics.lambda0_nm))) {
    markers.vertical.push({ x: Number(metrics.lambda0_nm), label: "λ0", color: "#D92D20" });
  }
  if (Number.isFinite(Number(metrics.left_boundary_nm))) {
    markers.vertical.push({ x: Number(metrics.left_boundary_nm), label: "左 FWHM", color: "#D97706", dashed: [6, 4] });
  }
  if (Number.isFinite(Number(metrics.right_boundary_nm))) {
    markers.vertical.push({ x: Number(metrics.right_boundary_nm), label: "右 FWHM", color: "#D97706", dashed: [6, 4] });
  }
  if (Number.isFinite(Number(metrics.half_level))) {
    markers.horizontal.push({ y: Number(metrics.half_level), label: "half", color: "#2563EB", dashed: [6, 4] });
  }
  if (Number.isFinite(Number(metrics.lambda_min_nm)) && Number.isFinite(Number(metrics.lambda_max_nm))) {
    markers.selection = { min: Number(metrics.lambda_min_nm), max: Number(metrics.lambda_max_nm) };
  }
  return markers;
}

function peakSummaryHtml(result, manualVerified = false) {
  const metrics = result?.metrics || result || {};
  const warnings = Array.isArray(result?.warnings) ? result.warnings : (Array.isArray(metrics.warnings) ? metrics.warnings : []);
  const usedCount = Number(result?.used_points?.length ?? metrics.used_point_count ?? 0);
  const featureType = metrics.feature_type || result?.resolved_feature_type || "auto";
  return `
    <div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <span class="tag ${manualVerified ? "green" : "blue"}">${manualVerified ? "manual verified" : "计算结果"}</span>
      <span class="tag blue">${esc(featureType)}</span>
      <span class="tag">${fmt(usedCount, 0)} 个原始点</span>
      ${warnings.length ? `<span class="tag orange">${esc(warnings.join("；"))}</span>` : ""}
    </div>
    <table class="table">
      <tbody>
        <tr><td>λ0</td><td>${fmt(metrics.lambda0_nm, 3)} nm</td></tr>
        <tr><td>FWHM</td><td>${fmt(metrics.FWHM_nm, 4)} nm</td></tr>
        <tr><td>Q</td><td>${fmt(metrics.Q, 2)}</td></tr>
        <tr><td>Tmax</td><td>${fmt(metrics.max_T, 4)}</td></tr>
        <tr><td>Tmin</td><td>${fmt(metrics.min_T, 4)}</td></tr>
        <tr><td>contrast</td><td>${fmt(metrics.contrast, 4)}</td></tr>
        <tr><td>边界</td><td>${fmt(metrics.left_boundary_nm, 3)} / ${fmt(metrics.right_boundary_nm, 3)}</td></tr>
      </tbody>
    </table>
  `;
}

async function recalcPeakSelection(root) {
  const spec = ensureSampleSpectrumState();
  if (!state.selectedRunId || !spec.sampleId) return null;
  const lambdaMin = $("#peak-min", root)?.value;
  const lambdaMax = $("#peak-max", root)?.value;
  if (lambdaMin === undefined || lambdaMax === undefined || lambdaMin === "" || lambdaMax === "") {
    $("#peak-result", root).textContent = "请先框选或填写 λ_min / λ_max。";
    return null;
  }
  const requestSeq = ++spec.requestSeq;
  const featureType = currentPeakFeatureType(root);
  $("#peak-result", root).textContent = "正在计算峰值..."; 
  try {
    const result = await api.peakCalc({
      run_id: state.selectedRunId,
      sample_id: spec.sampleId,
      kind: "T",
      lambda_min: lambdaMin,
      lambda_max: lambdaMax,
      feature_type: featureType,
    });
    if (requestSeq !== spec.requestSeq) return result;
    spec.lastResult = result;
    spec.lastSavedManual = false;
    spec.selection = { min: Number(lambdaMin), max: Number(lambdaMax) };
    if (spec.controller) {
      spec.controller.setSelection(spec.selection, true);
      spec.controller.drawMarkers(peakMarkersFromResult(result));
    }
    $("#peak-result", root).innerHTML = peakSummaryHtml(result, !!spec.lastSavedManual);
    return result;
  } catch (error) {
    if (requestSeq !== spec.requestSeq) return null;
    $("#peak-result", root).textContent = `峰值计算失败：${error.message}`;
    return null;
  }
}

function applySelectionToInputs(root, selection) {
  if (!selection) return;
  const minInput = $("#peak-min", root);
  const maxInput = $("#peak-max", root);
  if (minInput) minInput.value = Number(selection.min).toFixed(3);
  if (maxInput) maxInput.value = Number(selection.max).toFixed(3);
}

function renderSamplePreview(root, detail, sampleIndex) {
  const spec = ensureSampleSpectrumState();
  if (spec.controller) {
    spec.controller.destroy();
    spec.controller = null;
  }
  const samples = detail.samples || [];
  const sample = samples[sampleIndex] || samples[0] || {};
  state.selectedSampleId = String(sample.sample_id || "");
  spec.sampleId = state.selectedSampleId;
  state.resultPreviewImages = getRunImages(detail);
  state.resultPreviewIndex = Math.min(Math.max(sampleIndex, 0), Math.max(0, state.resultPreviewImages.length - 1));
  const image = state.resultPreviewImages[state.resultPreviewIndex];
  const manualSelection = sample.manual_selection || null;
  spec.featureType = manualSelection?.feature_type || "auto";
  spec.selection = manualSelection ? { min: Number(manualSelection.lambda_min_nm), max: Number(manualSelection.lambda_max_nm) } : null;
  spec.lastResult = manualSelection ? { metrics: manualSelection.metrics || {}, used_points: manualSelection.used_points || [], warnings: manualSelection.warnings || [] } : null;
  const pane = $("#preview-pane", root);
  if (!pane) return;
  pane.innerHTML = `
    <div class="preview-toolbar">
      <button class="btn ghost" data-preview-prev type="button">上一张</button>
      <button class="btn ghost" data-preview-next type="button">下一张</button>
      <button class="btn secondary" data-preview-auto type="button">${state.resultAutoplayTimer ? "停止播放" : "自动播放"}</button>
      ${image ? `<button class="btn ghost" data-open-folder="${esc(image.relative_path)}" type="button">打开文件夹</button>` : ""}
    </div>
    <div class="preview-stage">
      ${image ? `<img id="preview-image" src="/api/v2/files/raw?path=${encodeURIComponent(image.relative_path.replaceAll("\\", "/"))}" alt="${esc(image.name || image.relative_path)}">` : `<div class="empty">该样本没有找到谱图图片，将显示 T(λ) 曲线。</div>`}
    </div>
    <div id="preview-path" class="muted">${image ? esc(image.relative_path) : "无谱图图片"}</div>
    <div class="peak-tools" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
      <div class="segmented" id="peak-feature-mode">
        <button class="${spec.featureType === "auto" ? "active" : ""}" data-peak-feature="auto" type="button">自动判断 peak/dip</button>
        <button class="${spec.featureType === "peak" ? "active" : ""}" data-peak-feature="peak" type="button">按 peak 计算</button>
        <button class="${spec.featureType === "dip" ? "active" : ""}" data-peak-feature="dip" type="button">按 dip 计算</button>
      </div>
      <input class="input" id="peak-min" type="number" step="0.001" placeholder="λ min nm" value="${esc(manualSelection ? Number(manualSelection.lambda_min_nm).toFixed(3) : sample.lambda0_nm ? (Number(sample.lambda0_nm) - 10).toFixed(3) : "")}">
      <input class="input" id="peak-max" type="number" step="0.001" placeholder="λ max nm" value="${esc(manualSelection ? Number(manualSelection.lambda_max_nm).toFixed(3) : sample.lambda0_nm ? (Number(sample.lambda0_nm) + 10).toFixed(3) : "")}">
      <button class="btn ghost" data-peak-clear type="button">清除选择</button>
      <button class="btn primary" data-peak-save type="button">保存确认</button>
    </div>
    <div class="chart-box small" style="margin-top:10px;position:relative"><canvas id="sample-spectrum-canvas"></canvas></div>
    <div id="peak-result" class="muted">${manualSelection ? peakSummaryHtml(manualSelection, true) : "框选峰区后会自动计算 λ0 / FWHM / Q。"} </div>
  `;
  loadSampleSpectrum(root, sample);
}

async function loadSampleSpectrum(root, sample = {}) {
  if (!state.selectedRunId) return;
  const spec = ensureSampleSpectrumState();
  spec.sampleId = String(sample?.sample_id || state.selectedSampleId || "");
  try {
    const data = await api.diagnosticsSpectrum(state.selectedRunId, spec.sampleId || "", "T");
    spec.data = data;
    const points = normalizeSpectrumPoints(data.points || []);
    const canvas = $("#sample-spectrum-canvas", root);
    if (!canvas) return;
    spec.controller = drawLine(canvas, points, {
      xLabel: "λ (nm)",
      yLabel: "T",
      interactive: true,
      selection: spec.selection,
      markers: peakMarkersFromResult(sample.manual_selection || spec.lastResult || {}),
      onSelectionChange: (selection) => {
        if (!selection) {
          spec.selection = null;
          $("#peak-result", root).textContent = "请重新框选峰区。";
          return;
        }
        spec.selection = { min: Number(selection.min), max: Number(selection.max) };
        applySelectionToInputs(root, spec.selection);
        recalcPeakSelection(root);
      },
    });
    if (spec.selection) {
      spec.controller.setSelection(spec.selection, true);
    }
    if (spec.lastResult) {
      spec.controller.drawMarkers(peakMarkersFromResult(spec.lastResult));
    }
    if (!spec.selection && sample.manual_selection) {
      spec.selection = { min: Number(sample.manual_selection.lambda_min_nm), max: Number(sample.manual_selection.lambda_max_nm) };
      applySelectionToInputs(root, spec.selection);
      spec.controller.setSelection(spec.selection, true);
      spec.controller.drawMarkers(peakMarkersFromResult(sample.manual_selection));
    }
    if (spec.lastResult) {
      $("#peak-result", root).innerHTML = peakSummaryHtml(spec.lastResult, !!sample.manual_verified);
    }
  } catch (error) {
    $("#peak-result", root).textContent = `谱线读取失败：${error.message}`;
  }
}

function showPreviewImage(root, delta) {
  if (!state.resultPreviewImages.length) return;
  state.resultPreviewIndex = (state.resultPreviewIndex + delta + state.resultPreviewImages.length) % state.resultPreviewImages.length;
  const image = state.resultPreviewImages[state.resultPreviewIndex];
  const img = $("#preview-image", root);
  if (img) {
    img.src = `/api/v2/files/raw?path=${encodeURIComponent(image.relative_path.replaceAll("\\", "/"))}`;
    img.alt = image.name || image.relative_path;
  }
  const path = $("#preview-path", root);
  if (path) path.textContent = image.relative_path;
}

function evidenceAdvice(missing) {
  const advice = {
    R: "缺 R：补反射谱输出",
    A: "缺 A：补吸收谱输出",
    Field: "缺 Field：添加场监视器",
    Phase: "缺 Phase：导出相位数据",
    Poynting: "缺 Poynting：添加能流监视器",
  };
  return (missing || []).map((x) => `<span class="tag orange">${esc(advice[x] || `缺 ${x}`)}</span>`).join(" ");
}

function bindResults(root) {
  root.__resultsInputHandler && root.removeEventListener("input", root.__resultsInputHandler);
  root.__resultsInputHandler = (event) => {
    const search = event.target.closest("#structure-search");
    if (!search) return;
    const nav = ensureStructureNavigatorState();
    nav.query = search.value || "";
    saveStructureNavigatorState();
    const pane = $("#structure-navigator", root);
    if (pane) pane.innerHTML = renderStructureNavigator();
    return;
  };
  root.addEventListener("input", root.__resultsInputHandler);
  root.addEventListener("input", (event) => {
    if (!event.target.closest("#peak-min, #peak-max")) return;
    const spec = ensureSampleSpectrumState();
    const minValue = $("#peak-min", root)?.value;
    const maxValue = $("#peak-max", root)?.value;
    if (minValue === "" || maxValue === "") return;
    spec.selection = { min: Number(minValue), max: Number(maxValue) };
    if (Number.isFinite(spec.selection.min) && Number.isFinite(spec.selection.max)) {
      if (spec.controller) spec.controller.setSelection(spec.selection, true);
      recalcPeakSelection(root);
    }
  });

  setRouteClickHandler(root, "results", (event) => {
    if (routeName() !== "results") return;
    const featureBtn = event.target.closest("[data-peak-feature]");
    if (featureBtn) {
      event.preventDefault();
      const featureType = featureBtn.dataset.peakFeature || "auto";
      setPeakFeatureType(root, featureType);
      const spec = ensureSampleSpectrumState();
      if (spec.selection) recalcPeakSelection(root);
      return;
    }
    if (event.target.closest("[data-peak-clear]")) {
      event.preventDefault();
      const spec = ensureSampleSpectrumState();
      spec.selection = null;
      spec.lastResult = null;
      spec.lastSavedManual = false;
      if (spec.controller) spec.controller.clearSelection();
      if (spec.controller) spec.controller.drawMarkers({});
      const minInput = $("#peak-min", root);
      const maxInput = $("#peak-max", root);
      if (minInput) minInput.value = "";
      if (maxInput) maxInput.value = "";
      $("#peak-result", root).textContent = "已清除选择，请重新框选峰区。";
      return;
    }
    if (event.target.closest("[data-peak-save]")) {
      event.preventDefault();
      const spec = ensureSampleSpectrumState();
      const result = spec.lastResult;
      if (!result) {
        toast("请先框选峰区并完成计算。", "error");
        return;
      }
      const metrics = result.metrics || {};
      openModal({
        title: "保存峰值确认",
        confirmText: "确认保存",
        body: `
          <p>将把手动选择写入当前 run 的 <code>12_analysis_summary/v2_peak_selections.json</code>，并标记 <code>manual_verified</code>。</p>
          ${peakSummaryHtml(result, true)}
        `,
        onConfirm: async () => {
          const payload = {
            run_id: state.selectedRunId,
            sample_id: spec.sampleId,
            kind: "T",
            lambda_min: $("#peak-min", root)?.value,
            lambda_max: $("#peak-max", root)?.value,
            feature_type: metrics.feature_type || currentPeakFeatureType(root),
          };
          const saved = await api.savePeakSelection(payload);
          spec.lastSavedManual = true;
          spec.lastResult = saved.selection || result;
          $("#peak-result", root).innerHTML = peakSummaryHtml(saved.selection || result, true);
          toast("峰值区间已写入 run 的分析摘要。", "success");
          await loadRunInResults(root, state.selectedRunId);
        },
      });
      return;
    }
    const scopeBtn = event.target.closest("[data-structure-scope]");
    if (scopeBtn) {
      setStructureScope(scopeBtn.dataset.structureScope);
      renderRoute();
      return;
    }
    const toggleBtn = event.target.closest("[data-structure-toggle]");
    if (toggleBtn) {
      toggleStructureExpanded(toggleBtn.dataset.structureToggle);
      const pane = $("#structure-navigator", root);
      if (pane) pane.innerHTML = renderStructureNavigator();
      return;
    }
    const favoriteBtn = event.target.closest("[data-structure-favorite]");
    if (favoriteBtn) {
      const record = recordFromStructureElement(favoriteBtn);
      if (record) toggleStructureFavorite(record);
      const pane = $("#structure-navigator", root);
      if (pane) pane.innerHTML = renderStructureNavigator();
      return;
    }
    const pinBtn = event.target.closest("[data-structure-pin]");
    if (pinBtn) {
      const record = recordFromStructureElement(pinBtn);
      if (record) {
        selectStructurePath(record, record.run_id || "");
        state.selectedRunId = record.run_id || state.selectedRunId;
        renderRoute();
      }
      return;
    }
    const selectBtn = event.target.closest("[data-structure-select]");
    if (selectBtn) {
      const record = recordFromStructureElement(selectBtn);
      if (record) {
        selectStructurePath(record, record.kind === "run" ? (selectBtn.dataset.structureRun || record.run_id || "") : "");
        if (selectBtn.dataset.structureRun) state.selectedRunId = selectBtn.dataset.structureRun;
        renderRoute();
      }
      return;
    }
    const sampleBtn = event.target.closest("[data-sample-index]");
    if (sampleBtn && sampleBtn.closest("#sample-table")) {
      const detail = state.runDetails.get(state.selectedRunId);
      if (detail) {
        renderSamplePreview(root, detail, Number(sampleBtn.dataset.sampleIndex || 0));
        $$(".sample-row", root).forEach((row) => row.classList.toggle("active", row.dataset.sampleId === state.selectedSampleId));
      }
      return;
    }
    if (event.target.closest("[data-preview-prev]")) return showPreviewImage(root, -1);
    if (event.target.closest("[data-preview-next]")) return showPreviewImage(root, 1);
    if (event.target.closest("[data-preview-auto]")) {
      if (state.resultAutoplayTimer) {
        stopResultAutoplay();
        event.target.closest("[data-preview-auto]").textContent = "自动播放";
      } else {
        state.resultAutoplayTimer = setInterval(() => showPreviewImage(root, 1), 1600);
        event.target.closest("[data-preview-auto]").textContent = "停止播放";
      }
      return;
    }
    const openFolder = event.target.closest("[data-open-folder]");
    if (openFolder) {
      event.preventDefault();
      event.stopPropagation();
      runActionOnce(`open-folder:${openFolder.dataset.openFolder}`, async () => {
        await api.openFolder(openFolder.dataset.openFolder);
        toast("已请求打开文件夹。", "success");
      }).catch((error) => toast(error.message, "error"));
      return;
    }
    const btn = event.target.closest("[data-file-path]");
    const pane = $("#preview-pane", root);
    if (btn && pane) previewFile(btn.dataset.filePath, pane);
  });
  if (state.selectedRunId) loadRunInResults(root, state.selectedRunId);
}

function recordFromStructureElement(el) {
  if (!el) return null;
  const host = el.closest("[data-structure-node]") || el;
  const dataset = host.dataset || {};
  const record = {
    key: dataset.structurePin || dataset.structureSelect || dataset.structureFavorite || dataset.structureToggle || "",
    label: dataset.structureLabel || "",
    group: dataset.structureGroup || "",
    mother: dataset.structureMother || "",
    perturbation: dataset.structurePerturbation || "",
    run_id: dataset.structureRun || "",
    kind: dataset.structureKind || "",
  };
  if (!record.key) record.key = structurePathKey(record);
  if (!record.label) record.label = structurePathLabel(record);
  return record;
}

async function loadRunInResults(root, runId) {
  state.selectedRunId = runId;
  stopResultAutoplay();
  $$(".tree-row[data-run-id]", root).forEach((row) => row.classList.toggle("active", row.dataset.runId === runId));
  try {
    const detail = await api.run(runId);
    state.runDetails.set(runId, detail);
    $("#run-title", root).textContent = detail.run?.run_name || detail.run_name || runId;
    const selected = selectStructurePath({
      kind: "run",
      group: detail.run?.group || detail.group || "",
      mother: detail.run?.mother_structure || detail.mother_structure || "",
      perturbation: detail.run?.perturbation || detail.perturbation || "",
      run_id: runId,
      run_name: detail.run?.run_name || detail.run_name || runId,
      scope: ensureStructureNavigatorState().scope || state.resultFilters.scope || "current",
    }, runId);
    state.selectedStructure = selected;
    const samples = detail.samples || [];
    const files = detail.files || [];
    const samplePane = $("#sample-table", root);
    samplePane.className = samples.length ? "" : "empty";
    samplePane.innerHTML = samples.length ? `<div class="sample-table-wrap"><table class="table sample-table"><thead><tr><th>sample</th><th>δ / 参数</th><th>质量状态</th><th>score</th><th>操作</th></tr></thead><tbody>${samples.slice(0, 160).map(sampleRow).join("")}</tbody></table></div>` : "未发现 scan_points / manifest 样本摘要。";
    const strip = $("#resource-strip", root);
    if (strip) strip.innerHTML = resourceChips(files);
    const hint = $("#resource-hint", root);
    if (hint) hint.textContent = `${fmt(files.length)} 个文件，已隐藏完整文件表，只保留关键资源入口`;
    try {
      const trend = await api.diagnosticsTrend(runId);
      drawTrend($("#result-trend-chart", root), trend.points || detail.metrics || [], "delta", "score");
    } catch {
      drawTrend($("#result-trend-chart", root), detail.metrics || [], "delta", "score");
    }
    if (samples.length) renderSamplePreview(root, detail, 0);
  } catch (error) {
    toast(error.message, "error");
  }
}
async function previewFile(path, pane) {
  if (!pane) return;
  try {
    const data = await api.previewFile(path);
    if (data.kind === "image") {
      pane.innerHTML = `<img src="${esc(data.url)}" alt="${esc(path)}"><p class="muted">${esc(path)}</p>`;
    } else if (data.kind === "xlsx") {
      pane.innerHTML = `<strong>工作表摘要</strong><pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
    } else if (data.kind === "fsp") {
      pane.innerHTML = `<table class="table"><tbody><tr><td>路径</td><td>${esc(data.relative_path)}</td></tr><tr><td>大小</td><td>${fmt(data.size)} B</td></tr><tr><td>mtime</td><td>${esc(data.mtime)}</td></tr></tbody></table><div class="toolbar" style="margin-top:10px"><button class="btn primary" data-open-fsp="${esc(data.relative_path)}" type="button">打开 FSP</button><button class="btn ghost" data-open-folder="${esc(data.relative_path)}" type="button">打开文件夹</button></div>`;
    } else {
      pane.innerHTML = `<pre>${esc(data.text || JSON.stringify(data, null, 2))}</pre>`;
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindDiagnosis(root) {
  bindRunCascade(root, async () => {
    state.diagnostics = null;
    state.spectrum = null;
    state.trend = null;
    await renderRoute();
  });
  $("#load-run-diagnostics", root)?.addEventListener("click", () => loadDiagnostics(root));
  $("#load-spectrum", root)?.addEventListener("click", () => loadSpectrum(root));
  $("#load-trend", root)?.addEventListener("click", () => loadTrend(root));
  setRouteClickHandler(root, "diagnosis", (event) => {
    if (routeName() !== "diagnosis") return;
    const img = event.target.closest("[data-diagnosis-image]");
    if (img) openDrawer("谱图预览", `<img src="/api/v2/files/raw?path=${encodeURIComponent(img.dataset.diagnosisImage.replaceAll("\\", "/"))}" alt="${esc(img.dataset.diagnosisImage)}" style="width:100%;height:auto;border-radius:8px"><p class="muted">${esc(img.dataset.diagnosisImage)}</p>`);
  });
  if (state.spectrum?.run_id === state.selectedRunId) {
    const points = normalizeSpectrumPoints(state.spectrum.points || []);
    drawLine($("#spectrum-chart", root), points, { xLabel: "λ (nm)", yLabel: "T" });
  } else if (state.diagnostics?.run_id === state.selectedRunId) {
    loadSpectrum(root);
  }
  if (state.trend?.run_id === state.selectedRunId) {
    drawTrend($("#trend-chart", root), state.trend.points || [], "delta", "score");
  } else if (state.diagnostics?.run_id === state.selectedRunId) {
    loadTrend(root);
  }
  if (state.selectedRunId && (state.diagnostics?.run_id !== state.selectedRunId || !state.diagnostics?.quality)) loadDiagnostics(root);
}

async function loadDiagnostics(root) {
  if (!state.selectedRunId) return;
  try {
    const [diagnostics, q, detail] = await Promise.all([
      api.diagnosticsRun(state.selectedRunId),
      api.diagnosticsQuality(state.selectedRunId),
      api.run(state.selectedRunId),
    ]);
    state.diagnostics = diagnostics;
    state.diagnostics.quality = q;
    state.runDetails.set(state.selectedRunId, detail);
    await renderRoute();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadSpectrum(root) {
  if (!state.selectedRunId) return;
  const data = await api.diagnosticsSpectrum(state.selectedRunId, "", "T");
  state.spectrum = data;
  const points = normalizeSpectrumPoints(data.points || []);
  drawLine($("#spectrum-chart", root), points, { xLabel: "λ (nm)", yLabel: "T" });
}

async function loadTrend(root) {
  if (!state.selectedRunId) return;
  state.trend = await api.diagnosticsTrend(state.selectedRunId);
  drawTrend($("#trend-chart", root), state.trend.points || [], "delta", "score");
}

function bindTopology(root) {
  bindRunCascade(root, async () => {
    state.relay = null;
    state.heatmap = null;
    await renderRoute();
  });
  $("#load-run-diagnostics", root)?.addEventListener("click", () => loadRelay(root));
  $("#load-heatmap", root)?.addEventListener("click", () => loadHeatmap(root));
  setRouteClickHandler(root, "topology", (event) => {
    if (routeName() !== "topology") return;
    const img = event.target.closest("[data-diagnosis-image]");
    if (img) openDrawer("代表谱图", `<img src="/api/v2/files/raw?path=${encodeURIComponent(img.dataset.diagnosisImage.replaceAll("\\", "/"))}" alt="${esc(img.dataset.diagnosisImage)}" style="width:100%;height:auto;border-radius:8px"><p class="muted">${esc(img.dataset.diagnosisImage)}</p>`);
  });
  if (state.heatmap?.run_id === state.selectedRunId) {
    drawHeatmap($("#heatmap-chart", root), state.heatmap);
  }
  if (state.selectedRunId && state.relay?.run_id !== state.selectedRunId) loadRelay(root);
}

async function loadRelay(root) {
  const [relay, detail, heatmap] = await Promise.all([
    api.modeRelay(state.selectedRunId),
    api.run(state.selectedRunId),
    api.modeRelayHeatmap(state.selectedRunId),
  ]);
  state.relay = relay;
  state.heatmap = heatmap;
  state.runDetails.set(state.selectedRunId, detail);
  $("#page-root").innerHTML = renderTopology();
  bindTopology($("#page-root"));
}

async function loadHeatmap(root) {
  state.heatmap = await api.modeRelayHeatmap(state.selectedRunId);
  drawHeatmap($("#heatmap-chart", root), state.heatmap);
}

function bindQuality(root) {
  $("#dry-run-manager", root)?.addEventListener("click", async () => {
    try {
      const result = await api.resultManagerDryRun();
      openDrawer("结果整理 dry-run", `<pre class="mono">${esc(result.text || JSON.stringify(result, null, 2))}</pre>`);
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

function bindSupplement(root) {
  const ui = ensureSupplementUIState();
  root.__supplementChangeHandler && root.removeEventListener("change", root.__supplementChangeHandler);
  root.__supplementChangeHandler = (event) => {
    const sampleCheck = event.target.closest("[data-supplement-sample-check]");
    if (sampleCheck) {
      const sampleKey = sampleCheck.dataset.supplementSampleCheck;
      if (sampleCheck.checked) ui.selectedKeys.add(sampleKey);
      else ui.selectedKeys.delete(sampleKey);
      ui.focusedKey = sampleKey;
      setSupplementStep(2);
      renderRoute();
      return;
    }
    const runCheck = event.target.closest("[data-supplement-run-check]");
    if (runCheck) {
      const runId = runCheck.dataset.runId || "";
      (state.missing?.items || []).forEach((item) => {
        if ((item.run_id || "") !== runId) return;
        const key = supplementKey(item);
        if (runCheck.checked) ui.selectedKeys.add(key);
        else ui.selectedKeys.delete(key);
        if (runCheck.checked) ui.focusedKey = key;
      });
      setSupplementStep(2);
      renderRoute();
    }
  };
  root.addEventListener("change", root.__supplementChangeHandler);
  $("#supplement-search", root)?.addEventListener("input", async (event) => {
    state.supplementSearch = event.target.value;
    state.supplementVisibleLimit = 420;
    await renderRoute();
  });
  $("#supplement-type", root)?.addEventListener("change", () => renderRoute());
  $("#load-more-supplement", root)?.addEventListener("click", async () => {
    state.supplementVisibleLimit += 420;
    await renderRoute();
  });
  setRouteClickHandler(root, "supplement", (event) => {
    if (routeName() !== "supplement") return;
    const stepBtn = event.target.closest("[data-supplement-step]");
    if (stepBtn) {
      event.preventDefault();
      setSupplementStep(stepBtn.dataset.supplementStep);
      renderRoute();
      return;
    }
    const toggleRun = event.target.closest("[data-supplement-toggle-run]");
    if (toggleRun) {
      event.preventDefault();
      const runKey = toggleRun.dataset.supplementToggleRun;
      if (ui.expandedRuns.has(runKey)) ui.expandedRuns.delete(runKey);
      else ui.expandedRuns.add(runKey);
      renderRoute();
      return;
    }
    const sampleCard = event.target.closest("[data-supplement-sample]");
    if (sampleCard && !event.target.closest("input, button, a, label")) {
      ui.focusedKey = sampleCard.dataset.supplementSample || ui.focusedKey;
      setSupplementStep(2);
      renderRoute();
      return;
    }
    const create = event.target.closest("#create-package");
    if (create) {
      event.preventDefault();
      runActionOnce("create-supplement-package", () => createSupplementPackageFromSelection(root), 2000)
        .catch((error) => toast(error.message, "error"));
      return;
    }
    const show = event.target.closest("[data-show-package]");
    if (show) {
      showPackageModal(show.dataset.showPackage);
      return;
    }
    const del = event.target.closest("[data-delete-package]");
    if (!del) return;
    const packageId = del.dataset.deletePackage;
    let deleteDetail = null;
    openModal({
      title: "删除补做任务包",
      danger: true,
      confirmText: "确认删除任务包",
      body: `<p>只会删除 V2 patch 任务包目录和 supplement_index 条目，不会删除原始 run。</p><div id="delete-patch-detail" class="empty">正在读取真实路径...</div>`,
      onConfirm: async () => {
        await api.deleteSupplementPackage(packageId, {
          confirmed: true,
          package_type: deleteDetail?.package_type || "patch_v2",
          real_path: deleteDetail?.patch_request_abs_path || deleteDetail?.output_root || deleteDetail?.relative_path || "",
        });
        toast("补做任务包已删除。", "success");
        state.packages = await api.supplementPackages();
        await renderRoute();
      },
    });
    const confirmBtn = $("#modal-root [data-confirm-modal]");
    if (confirmBtn) confirmBtn.disabled = true;
    (async () => {
      try {
        deleteDetail = await api.supplementPackage(packageId);
        const host = $("#delete-patch-detail", $("#modal-root"));
        if (host) host.innerHTML = renderSupplementDeletePrompt(deleteDetail);
        const confirmBtn = $("#modal-root [data-confirm-modal]");
        const check = $("#modal-root #delete-patch-confirm");
        if (confirmBtn && check) {
          confirmBtn.disabled = !check.checked;
          check.addEventListener("change", () => {
            confirmBtn.disabled = !check.checked;
          });
        }
      } catch (error) {
        const host = $("#delete-patch-detail", $("#modal-root"));
        if (host) host.innerHTML = `<div class="notice warn">${esc(error.message)}</div>`;
      }
    })();
  });
}

async function createSupplementPackageFromSelection(root) {
  const items = state.missing?.items || [];
  const selected = collectSupplementSelection(root, items);
  if (!selected.length) return toast("请至少选择一个待补做样本。", "error");
  const supplementType = $("#supplement-type", root).value;
  const runIds = Array.from(new Set(selected.map((x) => x.run_id).filter(Boolean)));
  if (runIds.length > 1) return toast("一次任务包只支持一个 run，请在树中选择单个 run。", "error");
  const item = await api.createSupplementPackage({
    supplement_type: supplementType,
    monitor_policy: "single_monitor_only",
    patch_mode: true,
    output_to_existing_run: true,
    reuse_existing_perturbation_points: true,
    samples: selected,
  });
  toast(`已生成任务包：${item.package_id}`, "success");
  const ui = ensureSupplementUIState();
  ui.lastCreatedPackageId = item.package_id;
  state.packages = await api.supplementPackages();
  await renderRoute();
  showPatchPackageModal(item);
}

function applySupplementCheck(root, source) {
  const checked = source.checked;
  const group = source.dataset.treeGroup;
  const run = source.dataset.treeRun;
  const sample = source.dataset.treeSample;
  if (group) {
    $$(`[data-parent-group="${CSS.escape(group)}"], [data-tree-leaf][data-parent-run]`, root)
      .filter((node) => {
        const runNode = node.closest(".patch-run");
        return runNode && runNode.querySelector(`[data-parent-group="${CSS.escape(group)}"]`);
      })
      .forEach((node) => { node.checked = checked; });
  }
  if (run) {
    $$(`[data-parent-run="${CSS.escape(run)}"]`, root).forEach((node) => { node.checked = checked; });
  }
  if (sample) {
    $$(`[data-tree-leaf="${CSS.escape(sample)}"]`, root).forEach((node) => { node.checked = checked; });
  }
}

function updateSupplementTreeState(root) {
  $$("[data-patch-sample]", root).forEach((sampleNode) => {
    const sampleKey = sampleNode.dataset.patchSample;
    const sampleBox = sampleNode.querySelector(`[data-tree-sample="${CSS.escape(sampleKey)}"]`);
    const leaves = $$(`[data-tree-leaf="${CSS.escape(sampleKey)}"]`, sampleNode);
    const checked = leaves.filter((x) => x.checked).length;
    if (sampleBox && leaves.length) {
      sampleBox.checked = checked === leaves.length;
      sampleBox.indeterminate = checked > 0 && checked < leaves.length;
    }
  });
  $$("[data-patch-run]", root).forEach((runNode) => {
    const runKey = runNode.dataset.patchRun;
    const runBox = runNode.querySelector(`[data-tree-run="${CSS.escape(runKey)}"]`);
    const leaves = $$(`[data-parent-run="${CSS.escape(runKey)}"][data-tree-leaf]`, runNode);
    const checked = leaves.filter((x) => x.checked).length;
    if (runBox && leaves.length) {
      runBox.checked = checked === leaves.length;
      runBox.indeterminate = checked > 0 && checked < leaves.length;
    }
  });
  $$("[data-patch-batch]", root).forEach((batchNode) => {
    const batchKey = batchNode.dataset.patchBatch;
    const batchBox = batchNode.querySelector(`[data-tree-group="${CSS.escape(batchKey)}"]`);
    const leaves = $$("[data-tree-leaf]", batchNode);
    const checked = leaves.filter((x) => x.checked).length;
    if (batchBox && leaves.length) {
      batchBox.checked = checked === leaves.length;
      batchBox.indeterminate = checked > 0 && checked < leaves.length;
    }
  });
}

function collectSupplementSelection(root, items) {
  const ui = ensureSupplementUIState();
  return (items || [])
    .filter((item) => ui.selectedKeys.has(supplementKey(item)))
    .map((item) => ({
      ...item,
      selected_missing_evidence: Array.from(new Set(item.selected_missing_evidence || item.missing_evidence || [])),
    }));
}

async function showPackageModal(packageId) {
  try {
    const detail = await api.supplementPackage(packageId);
    showPatchPackageModal(detail);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderSupplementDeletePrompt(detail) {
  const realPath = detail.patch_request_abs_path || detail.output_root || detail.relative_path || "";
  return `
    <div class="notice warn">删除只允许 V2 patch 任务包，不会删除原始 run。请再次核对真实路径，并勾选确认。</div>
    <table class="table">
      <tbody>
        <tr><td>任务包</td><td>${esc(detail.package_id || "")}</td></tr>
        <tr><td>真实路径</td><td class="mono">${esc(realPath)}</td></tr>
        <tr><td>source run</td><td class="mono">${esc(detail.source_run_abs_path || detail.source_run_dir || "")}</td></tr>
        <tr><td>master_template</td><td class="mono">${esc(detail.master_template_fsp_abs_path || detail.master_template_fsp_path || "")}</td></tr>
        <tr><td>工作目录</td><td class="mono">${esc(detail.work_fsp_abs_path || detail.work_fsp_dir || "")}</td></tr>
      </tbody>
    </table>
    <label class="checkbox-line" style="display:flex;gap:8px;align-items:flex-start;margin-top:10px">
      <input id="delete-patch-confirm" type="checkbox">
      <span>我确认这是 V2 patch 任务包，不是原始 run。</span>
    </label>
  `;
}

function showPatchPackageModal(item) {
  const master = item.master_template_fsp_path || "";
  const masterCopy = item.master_template_fsp_abs_path || master;
  const workDir = item.work_fsp_dir || "";
  const workDirText = item.work_fsp_abs_path || workDir;
  const runDir = item.source_run_dir || "";
  const runDirCopy = item.source_run_abs_path || runDir;
  const outputs = item.target_output_dirs || item.expected_output_dirs || item.expected_outputs?.map((x) => x.relative_path) || [];
  const outputAbs = item.target_output_abs_dirs || [];
  const outputText = outputs.map((path, index) => esc(outputAbs[index] || path)).join("<br>") || "-";
  const legacyWarning = (!runDir || !masterCopy)
    ? `<div class="notice warn">这个任务包缺少 source run 或 master_template.fsp 记录，通常是旧版本生成的任务包。建议删除后用当前树形选择重新生成。</div>`
    : "";
  openModal({
    title: "补做任务包",
    confirmText: "关闭",
    body: `<div class="patch-modal">
      <div class="notice">补做模式会在已有 run 内追加输出，不新建 run_model_time。只需要修改 master_template.fsp 这个母文件的监视器，sample fsp 由补做脚本从母文件复制并按原扰动点自动生成。</div>
      ${legacyWarning}
      <table class="table"><tbody>
        <tr><td>任务包</td><td>${esc(item.package_id || "")}</td></tr>
        <tr><td>source run</td><td>${esc(runDirCopy || runDir || "-")}</td></tr>
        <tr><td>工作 FSP 文件夹</td><td>${esc(workDirText || "-")}</td></tr>
        <tr><td>master_template.fsp</td><td>${esc(masterCopy || "未找到")}</td></tr>
        <tr><td>预计追加输出目录</td><td>${outputText}</td></tr>
        <tr><td>选中样本</td><td>${fmt(item.sample_count || item.patch_request?.samples?.length || 0)} 个</td></tr>
        <tr><td>模式</td><td><span class="tag green">patch_mode=true</span> <span class="tag green">output_to_existing_run=true</span></td></tr>
      </tbody></table>
      <div class="modal-action-grid">
        <button class="btn secondary" data-open-folder="${esc(workDir)}" type="button" ${workDir ? "" : "disabled"}>打开工作 FSP 文件夹</button>
        <button class="btn ghost" data-copy-path="${esc(masterCopy)}" type="button" ${masterCopy ? "" : "disabled"}>复制 master_template.fsp 路径</button>
        <button class="btn ghost" data-copy-path="${esc(runDirCopy)}" type="button" ${runDirCopy ? "" : "disabled"}>复制本次 run 结果目录路径</button>
        <button class="btn secondary" data-refresh-patch-run="${esc(runDir)}" type="button" ${runDir ? "" : "disabled"}>补做完成后刷新该 run 缓存</button>
      </div>
    </div>`,
  });
}

function bindResources(root) {
  setRouteClickHandler(root, "resources", (event) => {
    if (routeName() !== "resources") return;
    const btn = event.target.closest("[data-file-path]");
    const pane = $("#resource-preview", root);
    if (btn && pane) previewFile(btn.dataset.filePath, pane);
  });
}

function navigate(route) {
  if (!routes[route]) return;
  if (window.location.hash === `#${route}`) renderRoute();
  else window.location.hash = route;
}

function bindChrome() {
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-mask").addEventListener("click", closeDrawer);
  $("#modal-root").addEventListener("click", (event) => { if (event.target.id === "modal-root") closeModal(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
      closeModal();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#global-search").focus();
    }
  });
  $("#nav").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-route]");
    if (btn) navigate(btn.dataset.route);
  });
  document.body.addEventListener("click", (event) => {
    markUserPriority();
    const go = event.target.closest("[data-go]");
    if (go) navigate(go.dataset.go);
    const selectRun = event.target.closest("[data-select-run]");
    if (selectRun?.dataset.selectRun) state.selectedRunId = selectRun.dataset.selectRun;
    const openFsp = event.target.closest("[data-open-fsp]");
    if (openFsp?.dataset.openFsp) {
      event.preventDefault();
      event.stopPropagation();
      api.openFile(openFsp.dataset.openFsp).then(() => toast("已请求打开 FSP。", "success")).catch((error) => toast(error.message, "error"));
      return;
    }
    const openFolder = event.target.closest("[data-open-folder]");
    if (openFolder?.dataset.openFolder && routeName() !== "results") {
      event.preventDefault();
      event.stopPropagation();
      runActionOnce(`open-folder:${openFolder.dataset.openFolder}`, async () => {
        await api.openFolder(openFolder.dataset.openFolder);
        toast("已请求打开文件夹。", "success");
      }).catch((error) => toast(error.message, "error"));
      return;
    }
    const copyPath = event.target.closest("[data-copy-path]");
    if (copyPath?.dataset.copyPath) {
      event.preventDefault();
      event.stopPropagation();
      copyText(copyPath.dataset.copyPath).then(() => toast("路径已复制。", "success")).catch((error) => toast(error.message, "error"));
      return;
    }
    const refreshPatch = event.target.closest("[data-refresh-patch-run]");
    if (refreshPatch?.dataset.refreshPatchRun) {
      event.preventDefault();
      event.stopPropagation();
      api.refreshDelta({ dirty_paths: [refreshPatch.dataset.refreshPatchRun] })
        .then(() => toast("补做完成、已更新缓存。", "success"))
        .catch((error) => toast(error.message, "error"));
    }
  }, true);
  $("#global-search").addEventListener("input", async (event) => {
    state.search = event.target.value;
    if (["run", "results", "resources"].includes(routeName())) await renderRoute();
  });
  $("#refresh-index").addEventListener("click", () => refreshIndex(false));
  $("#refresh-index").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    refreshIndex(true);
  });
  $("#export-summary").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.overview || {}, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fdtd_workbench_overview.json";
    a.click();
    URL.revokeObjectURL(url);
  });
  $("#open-config").addEventListener("click", () => openDrawer("工作台配置", `
    <div class="field"><label>缓存加载</label><div>首屏只读 overview/meta 轻量缓存，完整 run、谱线和资源按需加载。</div></div>
    <div class="field" style="margin-top:12px"><label>扫描策略</label><div>后台刷新走增量索引；全量重建需右键“后台刷新”并二次确认。</div></div>
    <div class="field" style="margin-top:12px"><label>运行安全</label><div>网页端启动仿真会写 job_manifest、before/after snapshot、delta_files，再局部刷新缓存。</div></div>
  `));
  window.addEventListener("hashchange", renderRoute);
  if (!window.location.hash) window.location.hash = "overview";
}

bindChrome();
bootstrap();

if (typeof window !== "undefined") {
  window.__fdtdWorkbench = {
    state,
    ensureJobLogState,
    renderJobLogPanel,
    jobLogDisplayText,
    jobLogPlainText,
  };
}



