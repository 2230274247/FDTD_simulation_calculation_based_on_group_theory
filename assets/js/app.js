import { api } from "./api.js";
import { drawLine, drawResponseAnalysis, drawDiagnosisTrendMatrix, drawModeRelayHeatmap } from "./charts.js";

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
  scriptTreeExpanded: new Set(),
  defaultOverrides: {},
  perScriptOverrides: {},
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
  resultTreeExpanded: new Set(),
  resultAnalysisMetric: "lambda0_nm",
  diagnosisTrendMetric: "score",
  diagnosisTrendRows: [],
  diagnosisSelectedPoint: null,
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
  supplementPlanPreview: null,
  supplementRunState: { jobId: "", cursor: 0, logs: [], status: "", timer: null },
  indexStatus: { running: false, progress: 0 },
  preloadStatus: null,
  warmupStarted: false,
  warmupDone: false,
  search: "",
};

let warmupPausedUntil = 0;
let renderSeq = 0;
const actionLocks = new Map();
let jobPollTimer = null;

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
const ACTIVE_JOB_STORAGE_KEY = "fdtd.activeJobId.v1";
const SUPPLEMENT_OPENED_FSP_STORAGE_KEY = "fdtd.supplement.openedFsp.v1";
const OVERVIEW_ALLOWED_GROUPS = new Set(["C2", "C3", "C4", "C6", "近径向高对称结构"]);
const OVERVIEW_GROUP_LABELS = {
  C2: "C2",
  C3: "C3",
  C4: "C4",
  C6: "C6",
  "近径向": "近径向高对称结构",
  "近径向高对称结构": "近径向高对称结构",
};

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
  nav.recent = list.slice(0, 3);
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
  $("[data-confirm-modal]", root).addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.dataset.loading = "1";
    btn.textContent = "处理中...";
    try {
      if (onConfirm) await onConfirm();
      closeModal();
    } catch (error) {
      toast(error.message || String(error), "error");
      btn.disabled = false;
      btn.dataset.loading = "0";
      btn.textContent = original;
    }
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

function loadActiveJobId() {
  try {
    return localStorage.getItem(ACTIVE_JOB_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveActiveJobId(jobId) {
  try {
    if (!jobId) localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    else localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, String(jobId));
  } catch {
    // ignore
  }
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

function ensureFloatingLogPanel() {
  let panel = $("#floating-job-log");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "floating-job-log";
    panel.className = "floating-job-log collapsed";
    panel.innerHTML = `
      <header class="floating-job-log-head">
        <strong class="floating-log-title">实时日志</strong>
        <div class="toolbar">
          <button class="btn danger" id="floating-log-stop" type="button">强制中断</button>
          <button class="btn ghost" id="floating-log-copy" type="button">复制</button>
          <button class="btn ghost" id="floating-log-download" type="button">下载</button>
          <button class="btn ghost" id="floating-log-toggle" type="button">展开</button>
        </div>
      </header>
      <div class="floating-job-log-body" id="floating-log-body"></div>`;
    document.body.appendChild(panel);
    let drag = null;
    panel.addEventListener("pointerdown", (event) => {
      if (!panel.classList.contains("collapsed")) return;
      // 点击展开按钮时不进入拖动模式，避免吞掉 click 事件
      if (event.target.closest("#floating-log-toggle")) return;
      if (!event.target.closest(".floating-job-log-head")) return;
      panel.setPointerCapture(event.pointerId);
      const rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    });
    panel.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const left = Math.max(8, Math.min(window.innerWidth - 64, event.clientX - drag.dx));
      const top = Math.max(8, Math.min(window.innerHeight - 64, event.clientY - drag.dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    panel.addEventListener("pointerup", () => { drag = null; });
    panel.addEventListener("click", async (event) => {
      const toggle = event.target.closest("#floating-log-toggle");
      if (toggle) {
        panel.classList.toggle("collapsed");
        toggle.textContent = panel.classList.contains("collapsed") ? "展开" : "收起";
        return;
      }
      if (event.target.closest("#floating-log-copy")) {
        const text = jobLogPlainText(ensureJobLogState().data || {});
        await copyText(String(text || ""));
        toast("日志已复制。", "success");
        return;
      }
      if (event.target.closest("#floating-log-download")) {
        const text = jobLogPlainText(ensureJobLogState().data || {});
        downloadText(`fdtd_job_log_${state.activeJobId || "current"}.txt`, String(text || ""));
        return;
      }
      if (event.target.closest("#floating-log-stop")) {
        if (!state.activeJobId) {
          toast("当前没有运行中的任务。", "error");
          return;
        }
        await api.stopJob(state.activeJobId);
        toast("已发送强制中断请求。", "success");
        return;
      }
      const modeBtn = event.target.closest("[data-job-log-mode]");
      if (modeBtn) {
        const jobLog = ensureJobLogState();
        jobLog.mode = modeBtn.dataset.jobLogMode || "all";
        updateFloatingLogPanel();
        return;
      }
      if (event.target.closest("[data-job-log-copy]")) {
        const text = jobLogPlainText(ensureJobLogState().data || {});
        await copyText(String(text || ""));
        toast("日志已复制。", "success");
        return;
      }
      if (event.target.closest("[data-job-log-download]")) {
        const text = jobLogPlainText(ensureJobLogState().data || {});
        downloadText(`fdtd_job_log_${state.activeJobId || "current"}.txt`, String(text || ""));
      }
    });
    panel.addEventListener("input", (event) => {
      if (event.target.id !== "job-log-search") return;
      const jobLog = ensureJobLogState();
      jobLog.search = event.target.value || "";
      updateFloatingLogPanel();
    });
    panel.addEventListener("change", (event) => {
      if (event.target.id !== "job-log-auto-scroll") return;
      const jobLog = ensureJobLogState();
      jobLog.autoScroll = !!event.target.checked;
      updateFloatingLogPanel();
    });
  }
  return panel;
}

function updateFloatingLogPanel(log = null) {
  const panel = ensureFloatingLogPanel();
  const body = $("#floating-log-body", panel);
  const data = log || ensureJobLogState().data || { text: "尚无日志", raw_text: "尚无日志", structured_lines: [] };
  body.innerHTML = `<div class="floating-job-log-content">${jobLogDisplayText(data)}</div>`;
  const content = $(".floating-job-log-content", panel);
  if (content) content.classList.add("floating-compact");
  panel.hidden = !state.activeJobId && !(data?.text || data?.raw_text);
  const logBody = $("#job-log-body", panel);
  if (logBody && ensureJobLogState().autoScroll && logBody.scrollHeight > logBody.clientHeight) {
    logBody.scrollTop = logBody.scrollHeight;
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
    if (!state.activeJobId) state.activeJobId = loadActiveJobId();
    if (!state.supplementRunState?.jobId) {
      const sid = localStorage.getItem("fdtd.supplement.jobid.v1") || "";
      if (sid) state.supplementRunState = { ...(state.supplementRunState || {}), jobId: sid, cursor: 0, logs: [], status: "running", timer: null };
    }
    const data = await api.bootstrap();
    api.setLocalToken(data.local_token || "");
    state.meta = data.meta || null;
    state.overview = data.overview || null;
    state.quality = data.quality_cache || null;
    state.supplements = data.supplement_index?.packages || [];
    updateHeader();
    updateStatusBar(data.stale ? "当前显示上次缓存" : `bootstrap ${Math.round(performance.now() - started)} ms`);
    await renderRoute();
    updateFloatingLogPanel();
    if (state.activeJobId) pollJob();
    if (state.supplementRunState?.jobId) {
      startSupplementLogPolling($("#page-root"));
    }
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
    const [missing, packages] = await Promise.all([
      api.supplementMissing(),
      api.supplementPackages(),
    ]);
    let supplementTree = { tree: [] };
    try {
      supplementTree = await api.supplementTree({ scope: "current", query: state.supplementSearch || "" });
    } catch (error) {
      const msg = String(error?.message || "");
      if (!msg.includes("/api/v2/supplement/tree")) throw error;
      supplementTree = { tree: [] };
    }
    state.missing = missing;
    state.packages = packages;
    state.supplementTree = supplementTree;
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
  const groups = (overview.groups || [])
    .map((g) => ({ ...g, group: OVERVIEW_GROUP_LABELS[g.group] || g.group }))
    .filter((g) => OVERVIEW_ALLOWED_GROUPS.has(g.group));
  const recent = overview.recent_runs || [];
  const risks = overview.risks || [];
  const noCache = !state.meta?.built_at;
  const cacheBanner = state.indexStatus.running
    ? "当前显示上次缓存 / 正在后台刷新"
    : (state.meta?.stale ? "当前显示上次缓存" : "当前显示最新缓存");
  return `<section class="page active">
    ${pageHead("研究总览", "首屏只读轻量缓存；目录扫描必须由后台刷新显式触发。", `<div class="toolbar"><button class="btn secondary" id="first-index" type="button" title="增量刷新索引；顶部按钮支持右键全量重建">${noCache ? "开始首次索引" : "后台刷新索引"}</button><button class="btn ghost" id="rebuild-index" type="button" title="清空缓存并全量重建">清空缓存重建</button></div>`)}
    <div class="notice" style="margin-bottom:12px">${esc(cacheBanner)}</div>
    <div class="stat-grid">
      ${statCard("有效 run", s.valid_run_count, "当前 results 下真实存在且无严重问题", "口径：仅统计白名单群目录的 active run，且不存在不收敛/T>1/FWHM不可靠/子进程失败/manifest异常。")}
      ${statCard("异常 run", s.bad_run_count, "当前 results 下存在严重异常", "口径：任意样本触发不收敛、T>1、FWHM不可靠、子进程失败、manifest异常即 +1。")}
      ${statCard("已诊断谱线", s.diagnosed_spectra ?? s.spectra_count, "仅统计旧文件中的良好结果", "口径：仅统计 .../results/.../旧文件/.../良好 下谱线，不计入 active run。")}
      ${statCard("缺失证据", s.missing_evidence_count, "R/A/Field/Phase/Poynting")}
      ${statCard("母结构覆盖率", pct(s.mother_coverage_rate), "按脚本与有效结果估算", "群分类覆盖仅允许：C2/C3/C4/C6/近径向高对称结构。")}
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
function statCard(label, value, note, tooltip = "") {
  return `<div class="card stat-card" title="${esc(tooltip || note)}"><div class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M13 16V8"/><path d="M18 16v-8"/></svg></div><div><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value ?? "-")}</div><div class="stat-note">${esc(note)}</div></div></div>`;
}

function groupProgress(group) {
  const rate = Number(group.coverage_rate) || 0;
  return `<div class="progress-row"><div class="progress-label">${esc(OVERVIEW_GROUP_LABELS[group.group] || group.group || "未分类")}</div><div class="progress-track"><div class="progress-bar" style="width:${Math.max(2, Math.min(100, rate * 100))}%"></div></div><div class="progress-value">${pct(rate)}</div></div>`;
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
  const selectedCount = state.selectedScriptIds.size;
  const selectedRows = scripts.filter((s) => state.selectedScriptIds.has(String(s.id || s.script_id)));
  return `<section class="page active">
    ${pageHead("运行控制", "只通过 subprocess 调用 fdtd_master_controller.py；启动前写入 job_manifest、快照和临时 overrides。", `<button class="btn secondary" id="refresh-scripts" type="button">刷新脚本列表</button>`)}
    <div class="layout-3">
      <div class="card pad"><div class="card-title">结构与脚本 <span class="muted">${fmt(state.scriptsPage?.total || scripts.length)} 个</span></div><div class="script-tree">${renderScriptTree(scripts)}</div></div>
      <div class="card pad">${runForm()}</div>
      <div><div class="card pad"><div class="card-title">启动摘要</div><table class="table"><tbody><tr><td>选择脚本</td><td id="selected-script-count">${selectedCount}</td></tr><tr><td>扫描点数估算</td><td id="point-estimate">待预览</td></tr><tr><td>预计时长</td><td id="duration-estimate">待预览</td></tr><tr><td>安全状态</td><td id="run-preview-status">${state.runPreview?.valid ? "已预览，可启动" : (state.runPreview?.dirtyReason || "未预览")}</td></tr></tbody></table><div class="toolbar" style="margin-top:14px"><button class="btn secondary" id="preview-run" type="button">预览命令</button><button class="btn primary" id="start-run" type="button" ${state.runPreview?.valid ? "" : "disabled"}>启动</button></div></div>
      <div class="card pad run-override-card" style="margin-top:12px">
        <div class="card-title">已选脚本参数表 <span class="muted">${selectedCount} 个</span></div>
        ${renderSelectedScriptOverrides(selectedRows)}
      </div></div>
    </div>
    <div class="bottom-actions"><span class="muted">危险操作都需要二次确认；full + parallel 会触发高风险确认。</span><div class="toolbar"><button class="btn ghost" id="clear-selected" type="button">清空选择</button><button class="btn primary" id="bottom-start" type="button" ${state.runPreview?.valid ? "" : "disabled"}>确认启动</button></div></div>
  </section>`;
}

function runForm() {
  return `<div class="card-title">运行参数</div>
    <div class="field"><label>运行模式</label><div class="segmented" id="mode-control"><button class="active" data-value="preview" type="button">preview</button><button data-value="test" type="button">test</button><button data-value="full" type="button">full</button></div></div>
    <div class="field" style="margin-top:12px"><label>执行策略</label><div class="segmented" id="style-control"><button class="active" data-value="sequential" type="button">sequential</button><button data-value="parallel" type="button">parallel</button></div></div>
    <div class="form-grid" style="margin-top:12px">
      ${inputField("max-parallel", "并发数", "2", "个")}
      ${inputField("child-timeout", "子任务超时", "3600", "s")}
    </div>
    <div class="card-title" style="margin-top:12px">默认参数</div>
    <div class="form-grid">
      ${overrideInputField("default", "START_NM", "start", "nm", state.defaultOverrides.START_NM ?? "")}
      ${overrideInputField("default", "END_NM", "end", "nm", state.defaultOverrides.END_NM ?? "")}
      ${overrideInputField("default", "STEP_NM", "step", "nm", state.defaultOverrides.STEP_NM ?? "")}
      ${overrideInputField("default", "MESH_ACCURACY", "mesh accuracy", "级", state.defaultOverrides.MESH_ACCURACY ?? "")}
      ${overrideInputField("default", "SIMULATION_TIME_FS", "runtime", "fs", state.defaultOverrides.SIMULATION_TIME_FS ?? "")}
      ${overrideInputField("default", "AUTO_SHUTOFF_MIN", "auto shutoff", "min", state.defaultOverrides.AUTO_SHUTOFF_MIN ?? "")}
      ${overrideInputField("default", "DT_STABILITY_FACTOR", "dt 稳定阈值", "CFL", state.defaultOverrides.DT_STABILITY_FACTOR ?? "")}
    </div>
    <div class="notice" style="margin-top:14px">页面加载不会运行脚本；只有点击启动并确认后才会执行。</div>`;
}

function inputField(id, label, value, unit) {
  return `<div class="field unit-field"><label>${esc(label)}</label><input class="input" id="${esc(id)}" type="number" value="${esc(value)}"><span class="unit">${esc(unit)}</span></div>`;
}

function overrideInputField(scope, key, label, unit, value = "") {
  return `<div class="field unit-field"><label>${esc(label)}</label><input class="input" data-override-scope="${esc(scope)}" data-override-key="${esc(key)}" type="number" value="${esc(value)}"><span class="unit">${esc(unit)}</span></div>`;
}

function scriptStatusTag(status) {
  const map = { has_full: ["已有 full", "green"], has_test: ["已有 test", "blue"], missing_result: ["缺结果", "orange"], failed: ["异常", "red"], unknown: ["未知", "orange"] };
  const [label, tone] = map[status] || [status || "未知", "orange"];
  return `<span class="tag ${tone}">${esc(label)}</span>`;
}

function scriptTreeModel(scripts) {
  const groupsMap = new Map();
  scripts.forEach((script) => {
    const group = script.group || "未分类";
    const mother = script.mother_structure || "未识别母结构";
    const perturb = script.perturbation || "未识别扰动";
    if (!groupsMap.has(group)) groupsMap.set(group, new Map());
    if (!groupsMap.get(group).has(mother)) groupsMap.get(group).set(mother, new Map());
    if (!groupsMap.get(group).get(mother).has(perturb)) groupsMap.get(group).get(mother).set(perturb, []);
    groupsMap.get(group).get(mother).get(perturb).push(script);
  });
  const out = [];
  for (const [group, mothers] of groupsMap.entries()) {
    const gNode = { key: `g:${group}`, type: "group", label: group, children: [] };
    for (const [mother, perts] of mothers.entries()) {
      const mNode = { key: `m:${group}|${mother}`, type: "mother", label: mother, children: [] };
      for (const [perturb, rows] of perts.entries()) {
        const pNode = { key: `p:${group}|${mother}|${perturb}`, type: "perturbation", label: perturb, children: [] };
        rows.forEach((s) => pNode.children.push({ key: `s:${String(s.id || s.script_id)}`, type: "script", scriptId: String(s.id || s.script_id), script: s, label: s.relative_path || s.script_path || s.perturbation || s.script_id }));
        mNode.children.push(pNode);
      }
      gNode.children.push(mNode);
    }
    out.push(gNode);
  }
  return out;
}

function collectScriptIds(node) {
  if (!node) return [];
  if (node.type === "script") return [node.scriptId];
  return (node.children || []).flatMap((c) => collectScriptIds(c));
}

function scriptSelectionState(node) {
  const ids = collectScriptIds(node);
  if (!ids.length) return { checked: false, indeterminate: false, total: 0, selected: 0 };
  const selected = ids.filter((id) => state.selectedScriptIds.has(id)).length;
  return { checked: selected === ids.length, indeterminate: selected > 0 && selected < ids.length, total: ids.length, selected };
}

function renderScriptTree(scripts) {
  if (!scripts.length) return emptySmall("暂无脚本缓存");
  const model = scriptTreeModel(scripts);
  const renderNode = (node, level = 0) => {
    const sel = scriptSelectionState(node);
    const expandable = node.type !== "script";
    const expanded = expandable ? state.scriptTreeExpanded.has(node.key) : false;
    const status = node.type === "script" ? scriptStatusTag(node.script.status) : `<span class="tag blue">${fmt(sel.selected)}/${fmt(sel.total)}</span>`;
    const dot = node.type === "script" ? `<span class="dot ${node.script.status === "failed" ? "red" : node.script.status === "has_full" ? "green" : "orange"}"></span>` : `<span class="dot blue"></span>`;
    return `<div class="run-tree-node level-${level}">
      <div class="run-tree-row" data-tree-key="${esc(node.key)}" data-tree-type="${esc(node.type)}" data-script-id="${esc(node.scriptId || "")}">
        ${expandable ? `<button class="icon-btn run-tree-toggle" data-tree-toggle="${esc(node.key)}" type="button">${expanded ? "▾" : "▸"}</button>` : `<span class="run-tree-toggle-spacer"></span>`}
        <input type="checkbox" data-tree-check="${esc(node.key)}" ${sel.checked ? "checked" : ""} ${sel.indeterminate ? "data-indeterminate=1" : ""}>
        ${dot}
        <span class="run-tree-label">${esc(node.type === "script" ? (node.script.mother_structure ? `${node.script.mother_structure} / ${node.script.perturbation}` : node.label) : node.label)}</span>
        ${status}
      </div>
      ${expandable && expanded ? `<div class="run-tree-children">${(node.children || []).map((child) => renderNode(child, level + 1)).join("")}</div>` : ""}
    </div>`;
  };
  return `<div class="run-script-tree">${model.map((n) => renderNode(n, 0)).join("")}</div>`;
}

function renderSelectedScriptOverrides(rows) {
  if (!rows.length) return `<div class="empty">请选择脚本后再设置单脚本参数。</div>`;
  const keys = ["START_NM", "END_NM", "STEP_NM", "MESH_ACCURACY", "SIMULATION_TIME_FS", "AUTO_SHUTOFF_MIN", "DT_STABILITY_FACTOR"];
  return `<div class="run-script-overrides">${rows.map((script) => {
    const sid = String(script.id || script.script_id);
    const open = state.scriptTreeExpanded.has(`o:${sid}`);
    const values = state.perScriptOverrides[sid] || {};
    return `<div class="override-item">
      <div class="override-head">
        <button class="link" data-override-toggle="${esc(sid)}" type="button">${open ? "▾" : "▸"} ${esc(script.group || "")} / ${esc(script.mother_structure || "")} / ${esc(script.perturbation || sid)}</button>
        ${scriptStatusTag(script.status)}
      </div>
      ${open ? `<div class="override-grid">${keys.map((k) => `<div class="field"><label>${esc(k)}</label><input class="input" data-override-scope="script" data-override-script-id="${esc(sid)}" data-override-key="${esc(k)}" type="number" value="${esc(values[k] ?? "")}"></div>`).join("")}</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

function renderResults() {
  const runs = state.runsPage?.runs || [];
  return `<section class="page active">
    ${pageHead("结果浏览", "群类别 → 母结构 → 扰动方式 → run；支持按 scope 过滤并保存展开状态。", `<button class="btn secondary" id="refresh-results-index" type="button">刷新结果索引</button>`)}
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
          <div class="chart-head"><strong>样本参数—光谱响应联动分析</strong><span id="resource-hint" class="muted">选择 run 后加载 δ→指标关系</span></div>
          <div class="toolbar" id="result-metric-tabs" style="margin-bottom:8px">
            ${[
              ["lambda0_nm", "δ → λ0"],
              ["q", "δ → Q"],
              ["fwhm_nm", "δ → FWHM"],
              ["max_t", "δ → max(T)"],
              ["score", "δ → score"],
            ].map(([key, label]) => `<button class="btn ghost ${state.resultAnalysisMetric === key ? "active" : ""}" data-result-metric="${esc(key)}" type="button">${esc(label)}</button>`).join("")}
          </div>
          <div class="trend-resource-grid">
            <div class="chart-box small"><div id="result-response-chart" style="width:100%;height:210px"></div></div>
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
  const treeRaw = Array.isArray(state.structureTree?.tree) ? state.structureTree.tree : [];
  const tree = pruneStructureTreeByScope(filterAllowedResultTree(treeRaw), scope);
  const filtered = filterStructureTree(tree, query);
  const visibleRunCount = countTreeRuns(filtered);
  const selectedKey = state.selectedStructure?.key || structurePathKey({
    group: state.resultFilters.group || "",
    mother: state.resultFilters.mother || "",
    perturbation: state.resultFilters.perturbation || "",
    run_id: state.selectedRunId || "",
  });
  const openKeys = new Set(state.resultTreeExpanded || []);
  return `
    <div class="structure-nav">
      <div class="card-title">StructureNavigator <span class="muted">${fmt(visibleRunCount)} 个</span></div>
      <div class="structure-nav-bar">
        <input class="input structure-search" id="structure-search" type="search" placeholder="搜索结构 / 扰动 / run" value="${esc(nav.query || "")}">
        <div class="segmented structure-scope" id="structure-scope">
          <button class="${scope === "current" ? "active" : ""}" data-structure-scope="current" type="button">当前 results</button>
          <button class="${scope === "old" ? "active" : ""}" data-structure-scope="old" type="button">旧文件良好</button>
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

function countTreeRuns(nodes) {
  const walk = (node) => {
    const directRuns = Array.isArray(node.runs) ? node.runs.length : (node.kind === "run" ? 1 : 0);
    const childRuns = (node.children || []).reduce((sum, child) => sum + walk(child), 0);
    return directRuns + childRuns;
  };
  return (nodes || []).reduce((sum, node) => sum + walk(node), 0);
}

function runRecordMatchesScope(run, scope) {
  if (!run) return false;
  const runScope = String(run.scope || "").toLowerCase();
  const isArchived = Boolean(run.is_archived_good) || runScope === "archived_good" || runScope === "old";
  const isActive = run.is_active_result !== false && !isArchived;
  if (scope === "old") return isArchived;
  if (scope === "all") return isActive || isArchived;
  return isActive;
}

function pruneStructureTreeByScope(nodes, scope = "current") {
  const normalizeRun = (run) => {
    const runScope = String(run.scope || "").toLowerCase();
    if (!run.scope) {
      if (run.is_archived_good) run.scope = "archived_good";
      else if (run.is_active_result === false) run.scope = "ignored";
      else run.scope = "active";
    } else if (runScope === "old") {
      run.scope = "archived_good";
    } else if (runScope === "current") {
      run.scope = "active";
    }
    return run;
  };
  const walk = (node) => {
    const current = { ...node };
    const runs = (node.runs || [])
      .map((run) => normalizeRun({ ...run }))
      .filter((run) => runRecordMatchesScope(run, scope));
    const children = (node.children || []).map((child) => walk(child)).filter(Boolean);
    current.runs = runs;
    current.children = children;
    if (!runs.length && !children.length) return null;
    current.run_count = runs.length || children.reduce((sum, child) => sum + (child.run_count || 0), 0);
    return current;
  };
  return (nodes || []).map((node) => walk(node)).filter(Boolean);
}

function removeRunFromStructureTree(runId) {
  if (!runId || !state.structureTree?.tree) return;
  const walk = (node) => {
    const runs = (node.runs || []).filter((run) => (run.run_id || "") !== runId);
    const children = (node.children || []).map((child) => walk(child)).filter(Boolean);
    if (!runs.length && !children.length) return null;
    return { ...node, runs, children };
  };
  state.structureTree = {
    ...state.structureTree,
    tree: (state.structureTree.tree || []).map((node) => walk(node)).filter(Boolean),
  };
}

function filterAllowedResultTree(nodes) {
  const allowed = new Set(["C2", "C3", "C4", "C6", "近径向高对称结构", "近径向"]);
  const normalize = (name) => (name === "近径向" ? "近径向高对称结构" : name);
  return (nodes || [])
    .filter((node) => allowed.has(node.name || node.group || ""))
    .map((node) => ({
      ...node,
      name: normalize(node.name || node.group || ""),
      group: normalize(node.group || node.name || ""),
    }));
}

function renderStructurePins(title, items, kind) {
  if (!items.length) return `<div class="structure-band"><div class="structure-band-title">${esc(title)}</div><div class="muted structure-band-empty">暂无</div></div>`;
  return `<div class="structure-band"><div class="structure-band-title">${esc(title)}</div><div class="structure-pin-row">${items.slice(0, 3).map((item) => `<button class="structure-pin" data-structure-pin="${esc(item.key)}" data-structure-pin-kind="${esc(kind)}" data-structure-label="${esc(item.label || "")}" data-structure-group="${esc(item.group || "")}" data-structure-mother="${esc(item.mother || "")}" data-structure-perturbation="${esc(item.perturbation || "")}" data-structure-run="${esc(item.run_id || "")}" data-structure-scope="${esc(item.scope || "")}" type="button" title="${esc(item.label || item.key)}"><span>${esc(item.label || item.key)}</span></button>`).join("")}</div></div>`;
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
    ? `<button class="link structure-select" data-structure-select="${esc(key)}" data-structure-run="${esc(node.kind === "run" ? (node.run_id || "") : (node.runs?.[0]?.run_id || ""))}" title="${esc(countTitle)}" type="button">${esc(node.name || record.label || key)}</button>`
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
    <div class="card chart-card" style="margin-top:16px">
      <div class="chart-head"><strong>诊断趋势矩阵</strong><button class="btn secondary" id="load-trend" type="button">加载趋势</button></div>
      <div class="toolbar" id="diagnosis-metric-tabs">
        ${[
          ["lambda0_nm", "λ0 vs δ"],
          ["q", "Q vs δ"],
          ["fwhm_nm", "FWHM vs δ"],
          ["max_t", "max(T) vs δ"],
          ["score", "score vs δ"],
        ].map(([key, label]) => `<button class="btn ghost ${state.diagnosisTrendMetric === key ? "active" : ""}" data-diagnosis-metric="${esc(key)}" type="button">${esc(label)}</button>`).join("")}
      </div>
      <div class="chart-box"><div id="diagnosis-trend-chart" style="width:100%;height:260px"></div></div>
      <div id="diagnosis-evidence-chips" class="diag-evidence"></div>
      <div class="diag-proof-note">提示：缺 Field / Phase / Poynting 时，当前结论不能作为严格拓扑证明。</div>
    </div>
  </section>`;
}

function diagnosisMetricConfig(key) {
  const map = {
    lambda0_nm: { yKey: "lambda0_nm", yLabel: "中心波长 λ0 (nm)" },
    q: { yKey: "q", yLabel: "品质因子 Q" },
    fwhm_nm: { yKey: "fwhm_nm", yLabel: "半高宽 FWHM (nm)" },
    max_t: { yKey: "max_t", yLabel: "峰值 max(T)" },
    score: { yKey: "score", yLabel: "综合得分 score" },
  };
  return map[key] || map.score;
}

function diagnosisPointSeverity(point) {
  const flags = point.quality_flags || [];
  const missing = point.missing_evidence || [];
  const critical = ["T > 1", "FWHM 不可靠", "子进程失败", "manifest 异常", "未收敛", "non-converged"];
  const highRisk = flags.some((f) => critical.some((k) => String(f || "").toLowerCase().includes(k.toLowerCase())))
    || Number(point.max_t) > 1;
  if (highRisk) return "high";
  if (flags.length || missing.length) return "warn";
  return "ok";
}

function buildDiagnosisTrendRows(detail, trendPoints) {
  const samples = detail?.samples || [];
  const sampleByDelta = new Map(samples.map((s) => [String(s.delta ?? ""), s]));
  return (trendPoints || []).map((row, idx) => {
    const sample = sampleByDelta.get(String(row.delta ?? "")) || {};
    const point = {
      idx,
      sample_id: sample.sample_id || row.sample_id || `#${idx + 1}`,
      delta: Number(row.delta ?? idx),
      lambda0_nm: Number(row.lambda0_nm ?? row.lambda_peak_nm ?? sample.lambda0_nm),
      q: Number(row.q ?? row.Q ?? sample.q ?? sample.Q),
      fwhm_nm: Number(row.fwhm_nm ?? row.FWHM_nm ?? sample.fwhm_nm ?? sample.FWHM_nm),
      max_t: Number(row.max_t ?? row.max_T ?? sample.max_t ?? sample.max_T),
      score: Number(row.score ?? sample.score),
      quality_flags: (sample.quality_flags || row.quality_flags || []).map((x) => String(x)),
      missing_evidence: (sample.missing_evidence || row.missing_evidence || detail?.missing_evidence || []).map((x) => String(x)),
    };
    point.severity = diagnosisPointSeverity(point);
    return point;
  }).filter((p) => Number.isFinite(p.delta));
}

function renderDiagnosisEvidenceChips(root, point) {
  const host = $("#diagnosis-evidence-chips", root);
  if (!host) return;
  if (!point) {
    host.innerHTML = `<div class="muted">选择趋势点后显示证据完整度。</div>`;
    return;
  }
  const missingSet = new Set((point.missing_evidence || []).map((x) => String(x).toLowerCase()));
  const keys = ["R", "A", "Field", "Phase", "Poynting"];
  const chips = keys.map((key) => {
    const miss = missingSet.has(key.toLowerCase());
    return `<span class="diag-chip ${miss ? "missing" : "ok"}">${esc(key)}: ${miss ? "缺失" : "就绪"}</span>`;
  }).join("");
  host.innerHTML = `<div class="diag-evidence-head">样本 ${esc(point.sample_id)} · δ=${fmt(point.delta, 4)} · 风险=${esc(point.severity)}</div><div class="diag-chip-row">${chips}</div>`;
}

function renderDiagnosisTrendMatrix(root) {
  const host = $("#diagnosis-trend-chart", root);
  if (!host) return;
  const rows = state.diagnosisTrendRows || [];
  if (!rows.length) {
    host.innerHTML = `<div class="empty" style="min-height:260px">暂无趋势数据。</div>`;
    renderDiagnosisEvidenceChips(root, null);
    return;
  }
  const metric = diagnosisMetricConfig(state.diagnosisTrendMetric);
  const chartRows = rows
    .filter((r) => Number.isFinite(Number(r[metric.yKey])))
    .map((r) => ({ ...r, value: Number(r[metric.yKey]) }));
  if (!chartRows.length) {
    host.innerHTML = `<div class="empty" style="min-height:260px">当前指标暂无可绘制数据。</div>`;
    renderDiagnosisEvidenceChips(root, null);
    return;
  }
  drawDiagnosisTrendMatrix(host, chartRows, {
    metric: state.diagnosisTrendMetric,
    xLabel: "扰动参数 δ",
    yLabel: metric.yLabel,
    onPointSelected(point) {
      state.diagnosisSelectedPoint = point || null;
      renderDiagnosisEvidenceChips(root, point || null);
    },
  });
  const selected = state.diagnosisSelectedPoint && chartRows.find((r) => r.sample_id === state.diagnosisSelectedPoint.sample_id && r.delta === state.diagnosisSelectedPoint.delta);
  renderDiagnosisEvidenceChips(root, selected || chartRows[0] || null);
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
  const todoList = [
    "k-space 扫描",
    "band sweep",
    "相位连续性",
    "缠绕数",
    "Field",
    "Phase",
    "Poynting",
    ...(relay.evidence_gaps || []),
    ...(relay.todo || []),
  ];
  const uniqueTodo = Array.from(new Set(todoList.filter(Boolean)));
  const hasWeakEvidence = uniqueTodo.length > 0;
  return `<section class="page active">
    ${pageHead("模式接力 / 拓扑候选", "本页仅做候选筛选，不等价于严格拓扑证明。")}
    <div class="notice">本页仅为候选筛选；严格证明仍需 k-space / band sweep / 相位连续性 / 缠绕数，以及 Field-Phase-Poynting 证据链。</div>
    ${runSelector(runs)}
    <div class="metric-grid">
      ${metric("候选强度", relay.candidate_strength)}
      ${metric("代表样本数", relay.representative_sample_count)}
      ${metric("证据缺口", uniqueTodo.length)}
      <div class="metric"><label>临界区间</label><strong>${esc(relay.critical_interval || "-")}</strong></div>
    </div>
    <div class="layout-2">
      <div class="card chart-card">
        <div class="chart-head"><strong>T(λ, δ) 模式接力热图</strong><button class="btn secondary" id="load-heatmap" type="button">重载热图</button></div>
        <div class="chart-box"><div id="mode-relay-heatmap" style="width:100%;height:520px"></div></div>
        <div class="muted topo-note">图中叠加 λ_peak / λ_dip 轨迹，并自动标注起点模式、反交叉区、模式切换点、高透射候选与 T&gt;1 异常点。</div>
      </div>
      <div class="card pad">
        <div class="card-title">严格证明缺口 / Todo</div>
        ${uniqueTodo.length ? `<div class="flag-list">${uniqueTodo.map((x) => `<div class="flag-item"><span class="dot orange"></span><span>${esc(x)}</span></div>`).join("")}</div>` : emptySmall("暂无缺口")}
        ${hasWeakEvidence ? `<div class="topo-action"><button class="btn primary" data-go="supplement" type="button">去补做实验</button></div>` : `<div class="muted" style="margin-top:10px">证据链较完整，仍需避免把候选写成已证明。</div>`}
      </div>
    </div>
    <div class="card pad" style="margin-top:16px"><div class="card-title">代表谱图 <span class="muted">${fmt(imageFiles.length)} 张</span></div><div class="image-strip">${imageFiles.length ? imageFiles.slice(0, 18).map((f, idx) => `<button class="thumb" data-diagnosis-image="${esc(f.relative_path)}" type="button"><img src="/api/v2/files/raw?path=${encodeURIComponent(f.relative_path.replaceAll("\\", "/"))}" alt="${esc(f.name || f.relative_path)}"><span>${idx + 1}</span></button>`).join("") : emptySmall("该 run 暂无谱图 png；可先用热图和峰位轨迹判断候选。")}</div></div>
  </section>`;
}

function relayAnnotations(heatmap, relay) {
  const rows = heatmap?.values || [];
  const lambdas = heatmap?.lambda_grid || [];
  const deltas = heatmap?.deltas || [];
  const peakTrack = [];
  const dipTrack = [];
  const highTrans = [];
  const tOverOne = [];
  rows.forEach((row, rIdx) => {
    if (!Array.isArray(row) || !row.length) return;
    let maxV = -Infinity; let minV = Infinity;
    let maxI = -1; let minI = -1;
    row.forEach((v, i) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      if (n > maxV) { maxV = n; maxI = i; }
      if (n < minV) { minV = n; minI = i; }
    });
    if (maxI >= 0) peakTrack.push([Number(lambdas[maxI]), Number(deltas[rIdx]), Number(maxV)]);
    if (minI >= 0) dipTrack.push([Number(lambdas[minI]), Number(deltas[rIdx]), Number(minV)]);
    const tAbs = (Number(heatmap?.raw_min) || 0) + ((Number(heatmap?.raw_max) || 1) - (Number(heatmap?.raw_min) || 0)) * Number(maxV);
    if (Number.isFinite(tAbs) && tAbs > 0.92) highTrans.push([Number(lambdas[maxI]), Number(deltas[rIdx]), tAbs]);
    if (Number.isFinite(tAbs) && tAbs > 1.0) tOverOne.push([Number(lambdas[maxI]), Number(deltas[rIdx]), tAbs]);
  });
  const switchPoints = [];
  for (let i = 1; i < peakTrack.length; i += 1) {
    const jump = Math.abs((peakTrack[i]?.[0] || 0) - (peakTrack[i - 1]?.[0] || 0));
    if (jump > 25) switchPoints.push(peakTrack[i]);
  }
  const antiCross = [];
  for (let i = 0; i < Math.min(peakTrack.length, dipTrack.length); i += 1) {
    const gap = Math.abs((peakTrack[i]?.[0] || 0) - (dipTrack[i]?.[0] || 0));
    if (gap < 12) antiCross.push(peakTrack[i]);
  }
  const startPoint = peakTrack[0] || null;
  const trackFromApi = (relay?.track || []).map((p) => [Number(p.lambda_nm), Number(p.delta)]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return { peakTrack, dipTrack, highTrans, tOverOne, switchPoints, antiCross, startPoint, trackFromApi };
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
    state.supplementUI = { selectedSampleKeys: new Set(), focusedKey: "", expandedRuns: new Set(), step: 1, lastCreatedPackageId: "", openedFspPaths: {}, fspHistory: [], fspStatus: {} };
  }
  if (!(state.supplementUI.selectedSampleKeys instanceof Set)) state.supplementUI.selectedSampleKeys = new Set(state.supplementUI.selectedSampleKeys || []);
  if (!(state.supplementUI.expandedRuns instanceof Set)) state.supplementUI.expandedRuns = new Set(state.supplementUI.expandedRuns || []);
  if (!Number.isFinite(Number(state.supplementUI.step))) state.supplementUI.step = 1;
  if (!state.supplementUI.lastCreatedPackageId) state.supplementUI.lastCreatedPackageId = "";
  if (!state.supplementUI.openedFspPaths || typeof state.supplementUI.openedFspPaths !== "object") {
    try {
      state.supplementUI.openedFspPaths = JSON.parse(localStorage.getItem(SUPPLEMENT_OPENED_FSP_STORAGE_KEY) || "{}") || {};
    } catch {
      state.supplementUI.openedFspPaths = {};
    }
  }
  if (!Array.isArray(state.supplementUI.fspHistory)) state.supplementUI.fspHistory = [];
  if (!state.supplementUI.fspStatus || typeof state.supplementUI.fspStatus !== "object") state.supplementUI.fspStatus = {};
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
  const selected = ensureSupplementUIState().selectedSampleKeys || new Set();
  return (items || []).filter((item) => selected.has(supplementKey(item)));
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

function supplementMockItems() {
  return [
    {
      run_id: "run_20260428_230048_aadf6d53",
      run_name: "run_20260428_230048_aadf6d53",
      group: "C6",
      mother_structure: "六柱环",
      perturbation: "偏心孔扰动",
      sample_id: "sample_003",
      missing_evidence: ["Field", "Phase"],
      risk_level: "medium",
      risk_label: "中风险",
      source_run_dir: "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53",
      master_template_fsp_path: "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53\\05_work_fsp\\master_template.fsp",
      mother_fsp_candidates: [
        "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53\\05_work_fsp\\master_template.fsp",
      ],
      sample_fsp_candidates: [
        "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53\\01_supercell_fsp\\sample_003.fsp",
      ],
      has_master_template_fsp: true,
    },
    {
      run_id: "run_20260428_230048_aadf6d53",
      run_name: "run_20260428_230048_aadf6d53",
      group: "C6",
      mother_structure: "六柱环",
      perturbation: "偏心孔扰动",
      sample_id: "sample_004",
      missing_evidence: ["R"],
      risk_level: "low",
      risk_label: "低风险",
      source_run_dir: "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53",
      master_template_fsp_path: "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53\\05_work_fsp\\master_template.fsp",
      mother_fsp_candidates: [
        "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53\\05_work_fsp\\master_template.fsp",
      ],
      sample_fsp_candidates: [
        "C6对称结构\\六柱环\\results\\偏心孔扰动\\run_20260428_230048_aadf6d53\\01_supercell_fsp\\sample_004.fsp",
      ],
      has_master_template_fsp: true,
    },
    {
      run_id: "run_20260427_133012_9f3c1a2b",
      run_name: "run_20260427_133012_9f3c1a2b",
      group: "C4",
      mother_structure: "双圆盘",
      perturbation: "半径差扰动",
      sample_id: "sample_001",
      missing_evidence: ["Poynting"],
      risk_level: "high",
      risk_label: "高风险",
      source_run_dir: "C4对称结构\\双圆盘\\results\\半径差扰动\\run_20260427_133012_9f3c1a2b",
      master_template_fsp_path: "C4对称结构\\双圆盘\\results\\半径差扰动\\run_20260427_133012_9f3c1a2b\\05_work_fsp\\master_ring.fsp",
      mother_fsp_candidates: [
        "C4对称结构\\双圆盘\\results\\半径差扰动\\run_20260427_133012_9f3c1a2b\\05_work_fsp\\master_ring.fsp",
      ],
      sample_fsp_candidates: [
        "C4对称结构\\双圆盘\\results\\半径差扰动\\run_20260427_133012_9f3c1a2b\\01_supercell_fsp\\sample_001.fsp",
      ],
      has_master_template_fsp: true,
    },
  ];
}

function renderSupplement() {
  const allItems = (state.missing?.items && state.missing.items.length) ? state.missing.items : supplementMockItems();
  allItems.forEach((item, index) => { item.__sourceIndex = index; });
  const q = state.supplementSearch.trim().toLowerCase();
  const items = q ? allItems.filter((item) => JSON.stringify(item).toLowerCase().includes(q)) : allItems;
  const visibleItems = items.slice(0, state.supplementVisibleLimit);
  const packages = state.packages?.packages || state.supplements || [];
  const ui = ensureSupplementUIState();
  const selectedItems = supplementSelectedItems(allItems);
  const focusItem = selectedItems.find((item) => supplementKey(item) === ui.focusedKey) || selectedItems[0] || visibleItems[0] || items[0] || null;
  const treeSource = state.supplementTree?.tree || [];
  const treeModel = treeSource.length
    ? buildSupplementTreeModel(treeSource, allItems, q)
    : buildSupplementTreeFromItems(allItems, q);
  const selectedSampleCount = ensureSupplementUIState().selectedSampleKeys.size;
  const selectedRunCount = countSelectedRuns(treeModel, ensureSupplementUIState().selectedSampleKeys);
  const step2 = renderSupplementStep2(focusItem, allItems);
  const step3 = renderSupplementStep3(focusItem, selectedItems, packages, allItems);
  const hasSelection = selectedSampleCount > 0;
  return `<section class="page active">
    ${pageHead("补做实验", "三步流程：选择目标、确认 FSP、继承参数并运行。")}
    <div class="supp-v1-risk">仅允许修改 run 内工作副本，不修改源文件；补做结果回写原 run 的新增目录。</div>
    <div class="supp-v1-stepper">
      <button class="supp-v1-step ${ui.step === 1 ? "active" : ""}" data-supplement-step="1" type="button"><span>1</span><em>选择补做目标</em></button>
      <button class="supp-v1-step ${ui.step === 2 ? "active" : ""}" data-supplement-step="2" type="button"><span>2</span><em>确认母文件与监视器</em></button>
      <button class="supp-v1-step ${ui.step === 3 ? "active" : ""}" data-supplement-step="3" type="button"><span>3</span><em>继承参数并运行</em></button>
    </div>
    <div class="supp-v1-grid">
      <div class="card pad supp-v1-left">
        <div class="card-title">Step 1 目标树选择 <span class="muted">已选 run ${fmt(selectedRunCount, 0)} 个 · 样本 ${fmt(selectedSampleCount, 0)} 个</span></div>
        <div class="supp-v1-toolbar">
          <select class="select" id="supplement-type">
            <option value="field">Field</option>
            <option value="phase">Phase</option>
            <option value="poynting">Poynting</option>
            <option value="R">R</option>
            <option value="A">A</option>
            <option value="angle-resolved">angle-resolved</option>
            <option value="band sweep">band sweep</option>
          </select>
          <input class="input" id="supplement-search" placeholder="搜索 run、结构、扰动、样本" value="${esc(state.supplementSearch)}">
        </div>
        ${treeModel.length ? `<div class="supplement-tree supplement-tree-v2">${renderSupplementTreeV2(treeModel)}</div>` : emptySmall("暂无可选 run / sample")}
        <div class="toolbar" style="margin-top:12px;justify-content:space-between">
          <span class="muted">层级：对称性结果 → 结构类型 → 扰动方式 → run → 单次样本</span>
          <button class="btn danger" id="clear-supplement-selection" type="button">清空选择</button>
        </div>
      </div>
      <div class="supp-v1-right">
        <div class="card pad supp-v1-card">
          <div class="card-title">Step 2 FSP 解析与打开 <button class="btn secondary" id="open-fsp-picker" type="button" style="float:right">选择并打开 FSP</button></div>
          <div class="supp-v1-risk">建议先打开 <code>05_work_fsp</code> 的母文件；只选单样本时再打开 <code>01_supercell_fsp</code>。</div>
          ${step2}
        </div>
        <div class="card pad supp-v1-card">
          <div class="card-title">Step 3 继承参数与补做计划</div>
          <div class="supp-v1-kv">
            <div><span>start</span><b title="900 nm">900 nm</b></div>
            <div><span>end</span><b title="1700 nm">1700 nm</b></div>
            <div><span>step</span><b title="2.5 nm">2.5 nm</b></div>
            <div><span>mesh</span><b title="4">4</b></div>
            <div><span>runtime</span><b title="1000 fs">1000 fs</b></div>
            <div><span>auto shutoff</span><b title="1e-5">1e-5</b></div>
          </div>
          <div class="supp-v1-path" title="run_xxx\\06_反射excel 07_反射图 08_反射场图 09_反射场数据 10_补做fsp快照 11_补做记录">回写目录：06_反射excel / 07_反射图 / 08_反射场图 / 09_反射场数据 / 10_补做fsp快照 / 11_补做记录</div>
          <div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-top:10px">
            <button class="btn secondary" id="preview-supp-plan" type="button" ${hasSelection ? "" : "disabled"}>生成补做计划预览</button>
            <button class="btn secondary" id="create-package" type="button" ${hasSelection ? "" : "disabled"}>生成补做计划</button>
            <button class="btn primary" id="run-supplement" type="button" ${state.supplementPlanPreview?.can_run ? "" : "disabled"}>确认并运行补做</button>
            <button class="btn ghost" id="open-supp-output" type="button" ${state.supplementPlanPreview?.run_path ? "" : "disabled"}>打开补做输出目录</button>
            ${ui.lastCreatedPackageId ? `<button class="btn secondary" data-show-package="${esc(ui.lastCreatedPackageId)}" type="button">打开上次任务包</button>` : ""}
          </div>
          <div class="supp-v1-log">${renderSupplementRunLog()}</div>
          ${renderSupplementPlanPreview(state.supplementPlanPreview)}
          ${step3}
        </div>
      </div>
    </div>
  </section>`;
}

function collectSelectedEvidenceBySample(items) {
  const selected = ensureSupplementUIState().selectedSampleKeys || new Set();
  const map = new Map();
  (items || []).forEach((item) => {
    const sampleKey = supplementKey(item);
    if (selected.has(sampleKey)) map.set(sampleKey, Array.from(new Set(item.missing_evidence || [])));
  });
  return map;
}

function buildSupplementTreeModel(sourceTree, items, query = "") {
  const itemMap = new Map();
  (items || []).forEach((item) => itemMap.set(`${item.run_id || ""}|${item.sample_id || ""}`, item));
  const q = String(query || "").trim().toLowerCase();
  const cloneNode = (node, level = 0) => {
    const kindMap = { symmetry: "group", structure: "mother", perturbation: "perturb", run: "run", sample: "sample" };
    const kind = kindMap[node.type] || node.type || "node";
    const out = {
      kind,
      key: node.id || `${kind}|${safeDomKey(node.label || "")}`,
      label: node.label || "",
      run_id: node.run_id || "",
      sample_id: node.sample_id || "",
      children: [],
    };
    if (kind === "sample") {
      const ref = itemMap.get(`${node.run_id || ""}|${node.sample_id || ""}`);
      out.sampleKey = `${node.run_id || ""}|${node.sample_id || ""}`;
      out.sample = ref || {
        run_id: node.run_id || "",
        run_name: node.run_name || node.run_id || "",
        sample_id: node.sample_id || "",
        missing_evidence: [],
      };
    }
    const children = (node.children || []).map((c) => cloneNode(c, level + 1)).filter(Boolean);
    const labelMatch = out.label.toLowerCase().includes(q);
    const keep = !q || labelMatch || children.length > 0;
    if (!keep) return null;
    out.children = children;
    return out;
  };
  return (sourceTree || []).map((n) => cloneNode(n, 0)).filter(Boolean);
}

function buildSupplementTreeFromItems(items, query = "") {
  const q = String(query || "").trim().toLowerCase();
  const groups = new Map();
  (items || []).forEach((item) => {
    const group = item.group || "未分类";
    const mother = item.mother_structure || "未识别结构";
    const perturbation = item.perturbation || "未识别扰动";
    const runId = item.run_id || "unknown_run";
    const runName = item.run_name || runId;
    const sampleId = item.sample_id || "#1";
    const hay = `${group} ${mother} ${perturbation} ${runName} ${sampleId}`.toLowerCase();
    if (q && !hay.includes(q)) return;
    if (!groups.has(group)) groups.set(group, new Map());
    if (!groups.get(group).has(mother)) groups.get(group).set(mother, new Map());
    if (!groups.get(group).get(mother).has(perturbation)) groups.get(group).get(mother).set(perturbation, new Map());
    if (!groups.get(group).get(mother).get(perturbation).has(runId)) {
      groups.get(group).get(mother).get(perturbation).set(runId, { runName, samples: [] });
    }
    groups.get(group).get(mother).get(perturbation).get(runId).samples.push(item);
  });
  const tree = [];
  for (const [group, mothers] of groups.entries()) {
    const gNode = { kind: "group", key: `symmetry|${safeDomKey(group)}`, label: group, children: [] };
    for (const [mother, perts] of mothers.entries()) {
      const mNode = { kind: "mother", key: `structure|${safeDomKey(group)}|${safeDomKey(mother)}`, label: mother, children: [] };
      for (const [perturbation, runs] of perts.entries()) {
        const pNode = { kind: "perturb", key: `perturbation|${safeDomKey(group)}|${safeDomKey(mother)}|${safeDomKey(perturbation)}`, label: perturbation, children: [] };
        for (const [runId, runInfo] of runs.entries()) {
          const rNode = { kind: "run", key: `run|${safeDomKey(runId)}`, label: runInfo.runName, run_id: runId, children: [] };
          runInfo.samples.forEach((sample) => {
            rNode.children.push({
              kind: "sample",
              key: `sample|${safeDomKey(runId)}|${safeDomKey(sample.sample_id || "#1")}`,
              label: sample.sample_id || "#1",
              run_id: runId,
              sample_id: sample.sample_id || "#1",
              sample: sample,
            });
          });
          pNode.children.push(rNode);
        }
        mNode.children.push(pNode);
      }
      gNode.children.push(mNode);
    }
    tree.push(gNode);
  }
  return tree;
}

function collectLeafKeys(node) {
  if (!node) return [];
  if (node.kind === "sample") return [supplementKey(node.sample || { run_id: node.run_id, sample_id: node.sample_id })];
  return (node.children || []).flatMap((child) => collectLeafKeys(child));
}

function nodeSelectionState(node) {
  const selected = ensureSupplementUIState().selectedSampleKeys;
  const leaves = collectLeafKeys(node);
  const checkedCount = leaves.filter((k) => selected.has(k)).length;
  return {
    checked: leaves.length > 0 && checkedCount === leaves.length,
    indeterminate: checkedCount > 0 && checkedCount < leaves.length,
    total: leaves.length,
    checkedCount,
  };
}

function renderSupplementTreeV2(nodes, level = 0) {
  return (nodes || []).map((node) => renderSupplementTreeNode(node, level)).join("");
}

function renderSupplementTreeNode(node, level = 0) {
  const ui = ensureSupplementUIState();
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const selection = nodeSelectionState(node);
  const expanded = hasChildren && (ui.expandedRuns.has(node.key) || level <= 1);
  const css = node.kind === "sample" ? "supplement-leaf" : "supplement-branch";
  const tag = node.kind === "sample"
    ? `<span class="tag ${selection.checked ? "green" : "blue"}">${selection.checked ? "已选" : "未选"}</span>`
    : `<span class="tag blue">${fmt(selection.checkedCount, 0)}/${fmt(selection.total, 0)}</span>`;
  const label = node.kind === "run" ? `${node.label}` : node.label;
  return `<div class="supp-node ${css} level-${level}" data-supp-node="${esc(node.key)}">
    <div class="supp-node-row">
      ${hasChildren ? `<button class="icon-btn" data-supplement-toggle-run="${esc(node.key)}" type="button">${expanded ? "▾" : "▸"}</button>` : `<span class="structure-toggle-spacer"></span>`}
      <input type="checkbox" data-supp-node-check="${esc(node.key)}" data-indeterminate="${selection.indeterminate ? "1" : "0"}" ${selection.checked ? "checked" : ""}>
      <span class="supp-node-label">${esc(label)}</span>
      ${tag}
    </div>
    ${expanded && hasChildren ? `<div class="supp-node-children">${renderSupplementTreeV2(node.children, level + 1)}</div>` : ""}
  </div>`;
}

function countSelectedRuns(tree, selectedSamples) {
  const runKeys = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.kind === "run") {
      const leaves = collectLeafKeys(node);
      if (leaves.some((k) => selectedSamples.has(k))) runKeys.add(node.key);
    }
    (node.children || []).forEach(walk);
  };
  (tree || []).forEach(walk);
  return runKeys.size;
}

function renderSupplementStep2(focusItem, allItems) {
  const ui = ensureSupplementUIState();
  const selectedMap = collectSelectedEvidenceBySample(allItems || []);
  if (!selectedMap.size) return emptySmall("先在 Step 1 勾选样本。");
  const selectedItems = (allItems || []).filter((item) => selectedMap.has(supplementKey(item)));
  const runGrouped = new Map();
  selectedItems.forEach((item) => {
    const runId = item.run_id || "";
    if (!runGrouped.has(runId)) runGrouped.set(runId, []);
    runGrouped.get(runId).push(item);
  });
  const rows = [];
  runGrouped.forEach((rowsByRun, runId) => {
    const first = rowsByRun[0] || {};
    const motherPaths = Array.from(new Set(rowsByRun.flatMap((x) => x.mother_fsp_candidates || []).filter(Boolean)));
    rows.push(`<div class="supp-step2-block"><strong>${esc(first.group || "")} / ${esc(first.mother_structure || "")} / ${esc(first.perturbation || "")} / ${esc(first.run_name || runId)}</strong></div>`);
    rows.push(`<div class="muted mono">${esc(first.source_run_dir || "")}</div>`);
    if (motherPaths.length) {
      rows.push(`<div class="supp-fsp-list">${motherPaths.map((p) => renderFspActions(p, ui)).join("")}</div>`);
    } else {
      rows.push(`<div class="empty">未找到 05_work_fsp 母文件。</div>`);
    }
    rowsByRun.forEach((item) => {
      const sKey = supplementKey(item);
      const ev = selectedMap.get(sKey) || [];
      const sampleFsp = item.sample_fsp_candidates || [];
      rows.push(`<div class="supp-sample-hint">sample ${esc(item.sample_id || "")} · evidence: ${esc(ev.join(", "))}</div>`);
      if (sampleFsp.length) rows.push(`<div class="supp-fsp-list">${sampleFsp.slice(0, 8).map((p) => renderFspActions(p, ui)).join("")}</div>`);
    });
  });
  return rows.join("");
}

function renderFspActions(path, ui) {
  const opened = !!ui.openedFspPaths[path];
  return `<div class="supp-fsp-row">
    <span class="mono">${esc(path)}</span>
    ${opened ? `<span class="tag green">已打开过</span>` : ""}
    <button class="btn ghost" data-open-fsp="${esc(path)}" type="button">打开 FSP 文件</button>
    <button class="btn ghost" data-open-folder="${esc(path)}" type="button">打开所在文件夹</button>
    <button class="btn ghost" data-copy-path="${esc(path)}" type="button">复制路径</button>
  </div>`;
}

function supplementCurrentSelection(items) {
  const selected = ensureSupplementUIState().selectedSampleKeys || new Set();
  return (items || []).filter((it) => selected.has(supplementKey(it)));
}

function buildResolvePayloadFromSelection(items) {
  const selected = supplementCurrentSelection(items);
  const out = [];
  selected.forEach((item) => {
    out.push({
      type: "sample",
      run_id: item.run_id || "",
      run_path: item.source_run_dir || item.source_run_path || "",
      sample_id: item.sample_id || "",
      perturbation: item.perturbation || "",
    });
  });
  return { selection: out };
}

function groupResolvedByPerturbation(items) {
  const map = new Map();
  (items || []).forEach((row) => {
    const k = `${row.group || ""}|${row.mother_structure || ""}|${row.perturbation || ""}`;
    if (!map.has(k)) map.set(k, { key: k, label: `${row.group || ""} / ${row.mother_structure || ""} / ${row.perturbation || ""}`, runs: [] });
    map.get(k).runs.push(row);
  });
  return Array.from(map.values());
}

function renderFspPickerRows(rows, ui) {
  return (rows || []).map((row) => {
    const runPath = row.run_path || "";
    const workRows = (row.work_fsp || []).map((x) => {
      const path = x.path || "";
      const status = ui.fspStatus[path] || {};
      return `<tr>
        <td title="${esc(row.run_name || row.run_id || "")}">${esc(row.run_name || row.run_id || "")}</td>
        <td title="${esc(path)}" class="mono">${esc(path)}</td>
        <td><span class="tag ${status.monitor_confirmed ? "green" : status.opened_count ? "blue" : "orange"}">${status.monitor_confirmed ? "已确认" : status.opened_count ? "曾打开" : "未打开"}</span></td>
        <td>
          <button class="btn ghost" data-fsp-open="${esc(path)}" data-run-path="${esc(runPath)}" type="button">打开 FSP</button>
          <button class="btn ghost" data-fsp-confirm="${esc(path)}" data-run-path="${esc(runPath)}" type="button">确认监视器已修改</button>
        </td>
      </tr>`;
    }).join("");
    const sampleRows = (row.sample_fsp || []).map((s) => (s.paths || []).map((p) => {
      const status = ui.fspStatus[p] || {};
      return `<tr>
        <td title="${esc((row.run_name || row.run_id || "") + " / " + (s.sample_id || ""))}">${esc((row.run_name || row.run_id || "") + " / " + (s.sample_id || ""))}</td>
        <td title="${esc(p)}" class="mono">${esc(p)}</td>
        <td><span class="tag ${status.monitor_confirmed ? "green" : status.opened_count ? "blue" : "orange"}">${status.monitor_confirmed ? "已确认" : status.opened_count ? "曾打开" : "未打开"}</span></td>
        <td>
          <button class="btn ghost" data-fsp-open="${esc(p)}" data-run-path="${esc(runPath)}" type="button">打开 FSP</button>
          <button class="btn ghost" data-fsp-confirm="${esc(p)}" data-run-path="${esc(runPath)}" type="button">确认监视器已修改</button>
        </td>
      </tr>`;
    }).join("")).join("");
    return workRows + sampleRows;
  }).join("");
}

function openSupplementFspModal(items) {
  const ui = ensureSupplementUIState();
  const payload = buildResolvePayloadFromSelection(items);
  if (!(payload.selection || []).length) {
    toast("请先在 Step 1 选择至少一个样本。", "error");
    return;
  }
  const root = $("#modal-root");
  root.hidden = false;
  root.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="选择并打开 FSP 文件">
    <div class="modal-head"><strong>选择并打开 FSP 文件</strong><button class="icon-btn" data-modal-close type="button">×</button></div>
    <div class="modal-body">
      <div class="segmented" id="supp-fsp-tabs" style="margin-bottom:10px">
        <button class="active" data-tab="perturb" type="button">扰动方式选择</button>
        <button data-tab="run" type="button">Run 选择</button>
        <button data-tab="sample" type="button">单次仿真选择</button>
      </div>
      <div class="layout-2" style="grid-template-columns:minmax(0,1fr) 280px;gap:12px">
        <div>
          <div class="empty" id="supp-fsp-loading">正在解析 FSP...</div>
          <div id="supp-fsp-table-wrap" hidden>
            <table class="table"><thead><tr><th>目标</th><th>FSP 路径</th><th>状态</th><th>操作</th></tr></thead><tbody id="supp-fsp-rows"></tbody></table>
          </div>
        </div>
        <div class="card pad">
          <div class="card-title">最近打开记录</div>
          <div id="supp-fsp-history" class="resource-list">${(ui.fspHistory || []).length ? ui.fspHistory.slice(0, 20).map((h) => `<div class="resource-row"><strong title="${esc(h.path || "")}">${esc(h.path || "")}</strong><span>${esc(h.time || "")}</span></div>`).join("") : `<div class="empty">暂无记录</div>`}</div>
        </div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-modal-close type="button">关闭</button></div>
  </section>`;
  root.querySelectorAll("[data-modal-close]").forEach((btn) => btn.addEventListener("click", closeModal));
  const tabs = { current: "perturb", data: [] };
  const renderRows = () => {
    const rowsHost = $("#supp-fsp-rows", root);
    const tableWrap = $("#supp-fsp-table-wrap", root);
    const loading = $("#supp-fsp-loading", root);
    if (!rowsHost || !tableWrap || !loading) return;
    let rows = tabs.data;
    if (tabs.current === "perturb") {
      const groups = groupResolvedByPerturbation(tabs.data);
      rows = groups.flatMap((g) => g.runs);
    } else if (tabs.current === "run") {
      rows = tabs.data;
    } else {
      rows = tabs.data.map((x) => ({ ...x, work_fsp: [], sample_fsp: x.sample_fsp || [] }));
    }
    rowsHost.innerHTML = renderFspPickerRows(rows, ui) || `<tr><td colspan="4" class="muted">暂无可打开 FSP</td></tr>`;
    loading.hidden = true;
    tableWrap.hidden = false;
  };
  $("#supp-fsp-tabs", root)?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tab]");
    if (!btn) return;
    tabs.current = btn.dataset.tab || "perturb";
    $$("#supp-fsp-tabs [data-tab]", root).forEach((b) => b.classList.toggle("active", b === btn));
    renderRows();
  });
  root.addEventListener("click", async (event) => {
    const openBtn = event.target.closest("[data-fsp-open]");
    if (openBtn) {
      const path = openBtn.dataset.fspOpen || "";
      const runPath = openBtn.dataset.runPath || "";
      try {
        const out = await api.supplementOpenFsp({ path, run_path: runPath });
        ui.fspStatus[path] = { ...(ui.fspStatus[path] || {}), opened_count: Number((ui.fspStatus[path]?.opened_count || 0) + 1), last_opened_at: out?.item?.last_opened_at || nowIsoClient() };
        ui.fspHistory.unshift({ path, time: out?.item?.last_opened_at || nowIsoClient() });
        ui.fspHistory = ui.fspHistory.slice(0, 50);
        toast("已打开 FSP 文件。", "success");
        renderRows();
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    const markBtn = event.target.closest("[data-fsp-confirm]");
    if (markBtn) {
      const path = markBtn.dataset.fspConfirm || "";
      const runPath = markBtn.dataset.runPath || "";
      try {
        await api.supplementMarkFspStatus({ path, run_path: runPath, status: "monitor_confirmed" });
        ui.fspStatus[path] = { ...(ui.fspStatus[path] || {}), monitor_confirmed: true, confirmed_at: nowIsoClient() };
        toast("已标记监视器修改完成。", "success");
        renderRows();
      } catch (error) {
        toast(error.message, "error");
      }
    }
  });
  api.supplementResolveFsp(payload).then((data) => {
    tabs.data = data.items || [];
    renderRows();
  }).catch((error) => {
    $("#supp-fsp-loading", root).textContent = error.message || "解析失败";
  });
}

function nowIsoClient() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function renderSupplementStep3(focusItem, selectedItems, packages, allItems = []) {
  const selectedMap = collectSelectedEvidenceBySample(allItems);
  if (!selectedMap.size) return `<div class="muted" style="margin-top:8px">仅支持同一个 run；当前未选样本。</div><div class="package-list" style="margin-top:12px">${packages.length ? packages.slice(0, 40).map((p) => renderSupplementPackageRow(p)).join("") : emptySmall("暂无补做任务包")}</div>`;
  const selectedRows = allItems.filter((item) => selectedMap.has(supplementKey(item)));
  const previewRows = selectedRows.slice(0, 80).map((item) => {
    const ev = selectedMap.get(supplementKey(item)) || [];
    const runDir = item.source_run_dir || "";
    const out = `${runDir}\\补做实验\\patch_YYYYMMDD_HHMMSS_<type>`;
    return `<tr><td>${esc(item.run_id || "")}</td><td>${esc(item.sample_id || "")}</td><td>${esc(ev.join(", "))}</td><td class="mono">${esc(item.master_template_fsp_path || "")}</td><td class="mono">${esc((item.sample_fsp_candidates || [item.source_fsp || ""])[0] || "")}</td><td class="mono">${esc(out)}</td></tr>`;
  }).join("");
  return `<div class="muted" style="margin-top:8px">仅支持同一个 run；当前已选 ${fmt(selectedRows.length, 0)} 个样本。</div>
    <div class="sample-table-wrap" style="margin-top:10px"><table class="table"><thead><tr><th>run</th><th>sample</th><th>补做证据</th><th>母文件</th><th>sample fsp</th><th>预计输出目录</th></tr></thead><tbody>${previewRows}</tbody></table></div>
    <div class="package-list" style="margin-top:12px">${packages.length ? packages.slice(0, 40).map((p) => renderSupplementPackageRow(p)).join("") : emptySmall("暂无补做任务包")}</div>`;
}

function renderSupplementPlanPreview(plan) {
  if (!plan) return `<div class="muted" style="margin-top:10px">尚未生成补做计划预览。</div>`;
  const missing = plan.missing_required || [];
  const risk = plan.output_plan?.overwrite_risk;
  const riskText = risk ? `存在覆盖风险（目录已存在：${(plan.output_plan?.existing_dirs || []).join("、")}）` : "无覆盖风险";
  return `<div class="card" style="margin-top:10px;padding:10px">
    <div class="card-title" style="margin-bottom:6px">补做计划预览</div>
    <table class="table"><tbody>
      <tr><td>当前选择范围</td><td>run ${esc(plan.run_name || plan.run_id || "")}，样本 ${fmt(plan.selection_scope?.sample_count || 0, 0)} 个</td></tr>
      <tr><td>继承参数来源</td><td>${esc(Object.entries(plan.param_sources || {}).map(([k, v]) => `${k}:${v}`).join(" | ") || "-")}</td></tr>
      <tr><td>将运行样本</td><td>${esc((plan.selection_scope?.samples || []).map((s) => s.sample_id).join(", ") || "-")}</td></tr>
      <tr><td>将使用 FSP</td><td class="mono">${esc([plan.fsp_plan?.master_fsp, ...((plan.fsp_plan?.sample_fsps || []).slice(0, 5))].filter(Boolean).join(" ; "))}</td></tr>
      <tr><td>输出目录</td><td class="mono">${esc((plan.output_plan?.output_dirs || []).join(" / "))}</td></tr>
      <tr><td>reuse_run_folder</td><td>true</td></tr>
      <tr><td>create_new_run_folder</td><td>false</td></tr>
      <tr><td>覆盖风险</td><td>${esc(riskText)}</td></tr>
    </tbody></table>
    ${missing.length ? `<div class="notice warn">关键参数缺失：${esc(missing.join(", "))}。请补齐后再运行。</div>` : `<div class="notice">参数完整，可进入下一阶段运行。</div>`}
  </div>`;
}

function renderSupplementRunLog() {
  const s = state.supplementRunState || {};
  const lines = s.logs || [];
  if (!s.jobId) return "[ready] 页面为局部交互，按钮不会刷新整页。\n[ready] 生成计划后可运行补做。";
  const body = lines.slice(-16).map((x) => `[${x.time || ""}] ${x.text || ""}`).join("\n");
  return `[job] ${s.jobId} | ${s.status || "running"}\n${body || "等待日志..."}`;
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

function renderSupplementSampleNode(runKey, item, selectedKeys) { return ""; }

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
  $("#rebuild-index", root)?.addEventListener("click", () => refreshIndex(true));
  $$("[data-run-jump]", root).forEach((row) => row.addEventListener("click", () => {
    state.selectedRunId = row.dataset.runJump;
    navigate("diagnosis");
  }));
}

function activeValue(root, id) {
  return $(`#${id} .active`, root)?.dataset.value;
}

function collectRunPayload(root) {
  const defaultOverrides = {};
  $$("[data-override-scope='default']", root).forEach((input) => {
    const key = input.dataset.overrideKey;
    const raw = input.value;
    if (!key) return;
    if (raw !== "") defaultOverrides[key] = Number(raw);
    state.defaultOverrides[key] = raw === "" ? undefined : Number(raw);
  });
  const perScriptOverrides = {};
  $$("[data-override-scope='script']", root).forEach((input) => {
    const sid = input.dataset.overrideScriptId;
    const key = input.dataset.overrideKey;
    const raw = input.value;
    if (!sid || !key) return;
    if (!perScriptOverrides[sid]) perScriptOverrides[sid] = {};
    if (raw !== "") perScriptOverrides[sid][key] = Number(raw);
    state.perScriptOverrides[sid] = { ...(state.perScriptOverrides[sid] || {}), [key]: raw === "" ? undefined : Number(raw) };
  });
  Object.keys(perScriptOverrides).forEach((sid) => {
    const cleaned = {};
    Object.entries(perScriptOverrides[sid]).forEach(([k, v]) => { if (Number.isFinite(v)) cleaned[k] = v; });
    perScriptOverrides[sid] = cleaned;
  });
  return {
    mode: activeValue(root, "mode-control") || "preview",
    style: activeValue(root, "style-control") || "sequential",
    max_parallel: Number($("#max-parallel", root)?.value || 2),
    ids: Array.from(state.selectedScriptIds),
    default_overrides: defaultOverrides,
    per_script_overrides: perScriptOverrides,
    overrides: Object.keys(defaultOverrides).length ? { "*": defaultOverrides } : {},
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
    default_overrides: payload.default_overrides || {},
    per_script_overrides: payload.per_script_overrides || {},
    child_timeout_s: Number(payload.child_timeout_s || 3600),
  });
}

function runPreviewMatchesCurrent(root) {
  return state.runPreview?.valid && state.runPreview.payloadHash === runPayloadHash(collectRunPayload(root));
}

function updateRunPreviewControls(root) {
  const preview = state.runPreview || {};
  const startAllowed = !!state.runPreview?.valid;
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
  const scripts = state.scriptsPage?.scripts || [];
  const model = scriptTreeModel(scripts);
  const byKey = new Map();
  const walk = (node) => {
    byKey.set(node.key, node);
    (node.children || []).forEach(walk);
  };
  model.forEach(walk);
  const invalidate = () => invalidateRunPreview(root);
  const sortSelectedScriptIds = () => {
    state.selectedScriptIds = new Set(Array.from(state.selectedScriptIds).sort((a, b) => String(a).localeCompare(String(b), "zh-CN", { numeric: true })));
  };
  const rerenderRunPanel = () => {
    const scriptsNow = state.scriptsPage?.scripts || [];
    const selectedRows = scriptsNow.filter((s) => state.selectedScriptIds.has(String(s.id || s.script_id)));
    const treeHost = $(".script-tree", root);
    if (treeHost) treeHost.innerHTML = renderScriptTree(scriptsNow);
    const count = $("#selected-script-count", root);
    if (count) count.textContent = state.selectedScriptIds.size;
    const overrideHost = $(".run-override-card", root);
    if (overrideHost) {
      const cardTitle = $(".card-title .muted", overrideHost);
      if (cardTitle) cardTitle.textContent = `${state.selectedScriptIds.size} 个`;
      const body = $(".run-script-overrides", overrideHost) || $(".empty", overrideHost);
      if (body) body.outerHTML = renderSelectedScriptOverrides(selectedRows);
    }
    $$("[data-tree-check][data-indeterminate='1']", root).forEach((box) => { box.indeterminate = true; });
  };
  const setChecked = (node, checked) => {
    collectScriptIds(node).forEach((id) => {
      if (checked) state.selectedScriptIds.add(id);
      else state.selectedScriptIds.delete(id);
    });
  };
  if (root.__runClickHandler) root.removeEventListener("click", root.__runClickHandler);
  root.__runClickHandler = (event) => {
    const toggle = event.target.closest("[data-tree-toggle]");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const key = toggle.dataset.treeToggle;
      if (state.scriptTreeExpanded.has(key)) state.scriptTreeExpanded.delete(key);
      else state.scriptTreeExpanded.add(key);
      rerenderRunPanel();
      return;
    }
    const row = event.target.closest(".run-tree-row");
    if (row && !event.target.closest("input,button,a")) {
      const key = row.dataset.treeKey;
      const node = byKey.get(key);
      if (!node) return;
      const sel = scriptSelectionState(node);
      setChecked(node, !sel.checked);
      sortSelectedScriptIds();
      $("#selected-script-count", root).textContent = state.selectedScriptIds.size;
      invalidate();
      rerenderRunPanel();
      return;
    }
    const overrideToggle = event.target.closest("[data-override-toggle]");
    if (overrideToggle) {
      const sid = overrideToggle.dataset.overrideToggle;
      const key = `o:${sid}`;
      if (state.scriptTreeExpanded.has(key)) state.scriptTreeExpanded.delete(key);
      else state.scriptTreeExpanded.add(key);
      rerenderRunPanel();
      return;
    }
  };
  root.addEventListener("click", root.__runClickHandler);
  if (root.__runChangeHandler) root.removeEventListener("change", root.__runChangeHandler);
  root.__runChangeHandler = (event) => {
    const check = event.target.closest("[data-tree-check]");
    if (check) {
      event.stopPropagation();
      const key = check.dataset.treeCheck;
      const node = byKey.get(key);
      if (!node) return;
      setChecked(node, !!check.checked);
      sortSelectedScriptIds();
      $("#selected-script-count", root).textContent = state.selectedScriptIds.size;
      invalidate();
      rerenderRunPanel();
      return;
    }
    if (event.target.matches("[data-override-scope='script'],[data-override-scope='default']")) {
      invalidate();
    }
  };
  root.addEventListener("change", root.__runChangeHandler);
  $$("[data-tree-check][data-indeterminate='1']", root).forEach((box) => { box.indeterminate = true; });
  $$(".segmented", root).forEach((seg) => seg.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    $$("button", seg).forEach((b) => b.classList.toggle("active", b === btn));
    invalidate();
  }));
  root.__runPreviewDirtyHandler && root.removeEventListener("input", root.__runPreviewDirtyHandler);
  root.__runPreviewDirtyHandler = (event) => {
    if (!event.target.closest("#mode-control, #style-control, #max-parallel, #child-timeout,[data-override-scope='default'],[data-override-scope='script']")) return;
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
      updateFloatingLogPanel();
      updateRunPreviewControls(root);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  const start = () => {
    const payload = collectRunPayload(root);
    if (!payload.ids.length) return toast("请先选择至少一个脚本。", "error");
    if (!state.runPreview?.valid) {
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
        saveActiveJobId(state.activeJobId);
        state.jobLog.data = {
          text: `任务已启动：${job.job_id}\n${Array.isArray(job.command) ? job.command.join(" ") : job.command}`,
          raw_text: `任务已启动：${job.job_id}\n${Array.isArray(job.command) ? job.command.join(" ") : job.command}`,
          structured_lines: [],
          collapsed_count: 0,
          encoding_warning: "",
        };
        updateFloatingLogPanel();
        pollJob();
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
  updateRunPreviewControls(root);
}

function stopResultAutoplay() {
  if (state.resultAutoplayTimer) {
    clearInterval(state.resultAutoplayTimer);
    state.resultAutoplayTimer = null;
  }
}

async function pollJob() {
  if (jobPollTimer) {
    clearTimeout(jobPollTimer);
    jobPollTimer = null;
  }
  if (!state.activeJobId) return;
  try {
    const [log, job] = await Promise.all([api.jobLog(state.activeJobId), api.job(state.activeJobId)]);
    state.jobLog = {
      ...(ensureJobLogState()),
      jobId: state.activeJobId,
      data: log || {},
    };
    updateFloatingLogPanel(log);
    if (job.status === "running" || job.status === "stopping") {
      jobPollTimer = setTimeout(() => pollJob(), 1500);
    } else {
      const changes = await api.cacheChanges(job.created_at || "");
      toast(`任务结束，已增量索引 ${changes.changed_runs?.length || 0} 个 run。`, "success");
      state.activeJobId = "";
      saveActiveJobId("");
      updateFloatingLogPanel();
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
    updateFloatingLogPanel();
    jobPollTimer = setTimeout(() => pollJob(), 2000);
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
  const allowPatterns = [
    /02_transmission_excel/i,
    /06_reflection_excel/i,
    /07_absorption_excel/i,
    /03_transmission.*png/i,
    /08_field_data/i,
    /09_phase_data/i,
    /10_poynting_data/i,
    /12_analysis_summary/i,
    /05_work_fsp/i,
    /01_supercell_fsp/i,
  ];
  const wanted = (files || [])
    .filter((f) => allowPatterns.some((re) => re.test(String(f.relative_path || ""))))
    .slice(0, 80);
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
  const refreshNavigator = () => {
    const pane = $("#structure-navigator", root);
    if (!pane) return;
    const scrollHost = $(".structure-tree", pane);
    const scrollTop = scrollHost ? scrollHost.scrollTop : 0;
    pane.innerHTML = renderStructureNavigator();
    const nextHost = $(".structure-tree", pane);
    if (nextHost) {
      requestAnimationFrame(() => {
        nextHost.scrollTop = scrollTop;
      });
    }
  };
  root.__resultsInputHandler && root.removeEventListener("input", root.__resultsInputHandler);
  root.__resultsInputHandler = (event) => {
    const search = event.target.closest("#structure-search");
    if (!search) return;
    const nav = ensureStructureNavigatorState();
    nav.query = search.value || "";
    saveStructureNavigatorState();
    refreshNavigator();
    return;
  };
  root.addEventListener("input", root.__resultsInputHandler);
  $("#refresh-results-index", root)?.addEventListener("click", async () => {
    await refreshIndex(false);
    await renderRoute();
  });
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

  setRouteClickHandler(root, "results", async (event) => {
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
      const scrollY = window.scrollY;
      await renderRoute();
      window.scrollTo({ top: scrollY, left: 0, behavior: "auto" });
      return;
    }
    const toggleBtn = event.target.closest("[data-structure-toggle]");
    if (toggleBtn) {
      const key = toggleBtn.dataset.structureToggle;
      if (state.resultTreeExpanded.has(key)) state.resultTreeExpanded.delete(key);
      else state.resultTreeExpanded.add(key);
      refreshNavigator();
      return;
    }
    const favoriteBtn = event.target.closest("[data-structure-favorite]");
    if (favoriteBtn) {
      const record = recordFromStructureElement(favoriteBtn);
      if (record) toggleStructureFavorite(record);
      refreshNavigator();
      return;
    }
    const pinBtn = event.target.closest("[data-structure-pin]");
    if (pinBtn) {
      const record = recordFromStructureElement(pinBtn);
      if (record) {
        selectStructurePath(record, record.run_id || "");
        state.selectedRunId = record.run_id || state.selectedRunId;
        await loadRunInResults(root, state.selectedRunId || record.run_id || "");
        refreshNavigator();
      }
      return;
    }
    const selectBtn = event.target.closest("[data-structure-select]");
    if (selectBtn) {
      const record = recordFromStructureElement(selectBtn);
      if (record) {
        selectStructurePath(record, record.kind === "run" ? (selectBtn.dataset.structureRun || record.run_id || "") : "");
        if (selectBtn.dataset.structureRun) state.selectedRunId = selectBtn.dataset.structureRun;
        await loadRunInResults(root, state.selectedRunId || selectBtn.dataset.structureRun || record.run_id || "");
        refreshNavigator();
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
    const metricBtn = event.target.closest("[data-result-metric]");
    if (metricBtn) {
      state.resultAnalysisMetric = metricBtn.dataset.resultMetric || "lambda0_nm";
      loadResultResponseChart(root);
      $$("#result-metric-tabs [data-result-metric]", root).forEach((b) => b.classList.toggle("active", b === metricBtn));
    }
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
    const hasEffectiveData = files.length > 0 || samples.length > 0 || (detail.metrics || []).length > 0;
    if (hint) {
      hint.textContent = hasEffectiveData
        ? `${fmt(files.length)} 个文件，已隐藏完整文件表，只保留关键资源入口`
        : "该 run 在本地没有可用结果文件（可能已删除，或仅剩缓存索引）。";
    }
    await loadResultResponseChart(root, detail);
    const previewPane = $("#preview-pane", root);
    if (!hasEffectiveData) {
      removeRunFromStructureTree(runId);
      const navEl = $("#structure-navigator", root);
      if (navEl) navEl.innerHTML = renderStructureNavigator();
      if (previewPane) previewPane.innerHTML = `<div class="empty">本地未找到该 run 的结果文件，建议先刷新结果索引。</div>`;
      state.resultPreviewImages = [];
      state.resultPreviewIndex = 0;
      state.selectedSampleId = "";
      return;
    }
    if (samples.length) renderSamplePreview(root, detail, 0);
    else if (previewPane) previewPane.innerHTML = `<div class="empty">该 run 暂无样本可预览。</div>`;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadResultResponseChart(root, detailOverride = null) {
  const detail = detailOverride || state.runDetails.get(state.selectedRunId) || {};
  let rows = [];
  try {
    const trend = await api.diagnosticsTrend(state.selectedRunId);
    rows = trend.points || [];
  } catch {
    rows = detail.metrics || [];
  }
  const metricMap = {
    lambda0_nm: ["lambda0_nm", "中心波长 λ0 (nm)"],
    q: ["q", "品质因子 Q"],
    fwhm_nm: ["fwhm_nm", "半高宽 FWHM (nm)"],
    max_t: ["max_t", "峰值 max(T)"],
    score: ["score", "综合得分 score"],
  };
  const [metric, yLabel] = metricMap[state.resultAnalysisMetric] || metricMap.lambda0_nm;
  const sampleByDelta = new Map((detail.samples || []).map((s) => [String(s.delta ?? ""), s]));
  const data = (rows || []).map((r, idx) => {
    const sample = sampleByDelta.get(String(r.delta ?? "")) || {};
    return {
      delta: Number(r.delta ?? idx),
      value: Number(r[metric]),
      sample_id: sample.sample_id || `#${idx + 1}`,
      quality_flags: sample.quality_flags || [],
      missing_evidence: sample.missing_evidence || [],
    };
  }).filter((x) => Number.isFinite(x.delta) && Number.isFinite(x.value));
  const chartHost = $("#result-response-chart", root);
  if (!chartHost) return;
  if (!data.length) {
    chartHost.innerHTML = `<div class="empty" style="min-height:210px">暂无可绘制的样本参数—光谱响应数据。</div>`;
    return;
  }
  drawResponseAnalysis(chartHost, data, {
    metric,
    xLabel: "扰动参数 δ",
    yLabel,
  });
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
    state.diagnosisTrendRows = [];
    state.diagnosisSelectedPoint = null;
    await renderRoute();
  });
  $("#load-run-diagnostics", root)?.addEventListener("click", () => loadDiagnostics(root));
  $("#load-spectrum", root)?.addEventListener("click", () => loadSpectrum(root));
  $("#load-trend", root)?.addEventListener("click", () => loadTrend(root));
  $$("#diagnosis-metric-tabs [data-diagnosis-metric]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      state.diagnosisTrendMetric = btn.dataset.diagnosisMetric || "score";
      $$("#diagnosis-metric-tabs [data-diagnosis-metric]", root).forEach((b) => b.classList.toggle("active", b === btn));
      renderDiagnosisTrendMatrix(root);
    });
  });
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
    state.diagnosisTrendRows = buildDiagnosisTrendRows(state.runDetails.get(state.selectedRunId) || {}, state.trend.points || []);
    renderDiagnosisTrendMatrix(root);
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
  const detail = state.runDetails.get(state.selectedRunId) || await api.run(state.selectedRunId);
  state.runDetails.set(state.selectedRunId, detail);
  state.diagnosisTrendRows = buildDiagnosisTrendRows(detail, state.trend.points || []);
  state.diagnosisSelectedPoint = null;
  renderDiagnosisTrendMatrix(root);
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
    const ann = relayAnnotations(state.heatmap, state.relay || {});
    drawModeRelayHeatmap($("#mode-relay-heatmap", root), state.heatmap, ann);
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
  const ann = relayAnnotations(state.heatmap, state.relay || {});
  drawModeRelayHeatmap($("#mode-relay-heatmap", root), state.heatmap, ann);
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

function renderSupplementLocal(root) {
  const route = routeName();
  if (route !== "supplement") return;
  const host = document.getElementById("page-root");
  if (!host) return;
  host.innerHTML = renderSupplement();
  afterRender("supplement");
}

function bindSupplement(root) {
  const ui = ensureSupplementUIState();
  const allItems = (state.missing?.items && state.missing.items.length) ? state.missing.items : supplementMockItems();
  const q = state.supplementSearch.trim().toLowerCase();
  const filtered = q ? allItems.filter((item) => JSON.stringify(item).toLowerCase().includes(q)) : allItems;
  const visibleItems = filtered.slice(0, state.supplementVisibleLimit);
  const sourceTree = state.supplementTree?.tree || [];
  const tree = sourceTree.length
    ? buildSupplementTreeModel(sourceTree, allItems, q)
    : buildSupplementTreeFromItems(allItems, q);
  const nodeMap = new Map();
  const walk = (node) => { nodeMap.set(node.key, node); (node.children || []).forEach(walk); };
  tree.forEach(walk);
  $$("[data-supp-node-check][data-indeterminate='1']", root).forEach((el) => { el.indeterminate = true; });

  root.__supplementChangeHandler && root.removeEventListener("change", root.__supplementChangeHandler);
  root.__supplementChangeHandler = (event) => {
    const check = event.target.closest("[data-supp-node-check]");
    if (!check) return;
    event.preventDefault();
    event.stopPropagation();
    const node = nodeMap.get(check.dataset.suppNodeCheck || "");
    if (!node) return;
    const leaves = collectLeafKeys(node);
    leaves.forEach((leaf) => {
      if (check.checked) ui.selectedSampleKeys.add(leaf);
      else ui.selectedSampleKeys.delete(leaf);
    });
    if (node.sample) ui.focusedKey = supplementKey(node.sample);
    setSupplementStep(2);
    renderSupplementLocal(root);
  };
  root.addEventListener("change", root.__supplementChangeHandler);

  $("#supplement-search", root)?.addEventListener("input", (event) => {
    state.supplementSearch = event.target.value;
    state.supplementVisibleLimit = 420;
    renderSupplementLocal(root);
  });
  $("#supplement-type", root)?.addEventListener("change", () => renderSupplementLocal(root));
  $("#load-more-supplement", root)?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.supplementVisibleLimit += 420;
    renderSupplementLocal(root);
  });
  $("#clear-supplement-selection", root)?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    ui.selectedSampleKeys.clear();
    ui.focusedKey = "";
    renderSupplementLocal(root);
  });

  setRouteClickHandler(root, "supplement", (event) => {
    if (routeName() !== "supplement") return;
    const stepBtn = event.target.closest("[data-supplement-step]");
    if (stepBtn) {
      event.preventDefault();
      event.stopPropagation();
      setSupplementStep(stepBtn.dataset.supplementStep);
      renderSupplementLocal(root);
      return;
    }
    const openPicker = event.target.closest("#open-fsp-picker");
    if (openPicker) {
      event.preventDefault();
      event.stopPropagation();
      openSupplementFspModal(allItems);
      return;
    }
    const toggleRun = event.target.closest("[data-supplement-toggle-run]");
    if (toggleRun) {
      event.preventDefault();
      event.stopPropagation();
      const runKey = toggleRun.dataset.supplementToggleRun || "";
      if (ui.expandedRuns.has(runKey)) ui.expandedRuns.delete(runKey); else ui.expandedRuns.add(runKey);
      renderSupplementLocal(root);
      return;
    }
    const openFsp = event.target.closest("[data-open-fsp]");
    if (openFsp) {
      event.preventDefault();
      event.stopPropagation();
      const path = openFsp.dataset.openFsp || "";
      api.openFile(path).then(() => {
        ui.openedFspPaths[path] = true;
        localStorage.setItem(SUPPLEMENT_OPENED_FSP_STORAGE_KEY, JSON.stringify(ui.openedFspPaths));
        renderSupplementLocal(root);
      }).catch((error) => toast(error.message, "error"));
      return;
    }
    const openFolder = event.target.closest("[data-open-folder]");
    if (openFolder) {
      event.preventDefault();
      event.stopPropagation();
      api.openFolder(openFolder.dataset.openFolder || "").catch((error) => toast(error.message, "error"));
      return;
    }
    const copyPath = event.target.closest("[data-copy-path]");
    if (copyPath) {
      event.preventDefault();
      event.stopPropagation();
      const p = copyPath.dataset.copyPath || "";
      navigator.clipboard?.writeText(p).then(() => toast("路径已复制。", "success")).catch(() => toast(p, "success"));
      return;
    }
    const previewPlan = event.target.closest("#preview-supp-plan");
    if (previewPlan) {
      event.preventDefault();
      event.stopPropagation();
      runActionOnce("preview-supp-plan", () => previewSupplementPlan(root), 1200).catch((error) => toast(error.message, "error"));
      return;
    }
    const runSupp = event.target.closest("#run-supplement");
    if (runSupp) {
      event.preventDefault();
      event.stopPropagation();
      runActionOnce("run-supplement", () => startSupplementRun(root), 1500).catch((error) => toast(error.message, "error"));
      return;
    }
    const openOut = event.target.closest("#open-supp-output");
    if (openOut) {
      event.preventDefault();
      event.stopPropagation();
      const runPath = state.supplementPlanPreview?.run_path || "";
      if (runPath) {
        api.supplementOpenFolder({ run_path: runPath }).catch((error) => toast(error.message, "error"));
      }
      return;
    }
    const create = event.target.closest("#create-package");
    if (create) {
      event.preventDefault();
      event.stopPropagation();
      runActionOnce("create-supplement-package", () => createSupplementPackageFromSelection(root), 2000).catch((error) => toast(error.message, "error"));
      return;
    }
    const show = event.target.closest("[data-show-package]");
    if (show) {
      event.preventDefault();
      event.stopPropagation();
      showPackageModal(show.dataset.showPackage);
      return;
    }
    const del = event.target.closest("[data-delete-package]");
    if (!del) return;
    event.preventDefault();
    event.stopPropagation();
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
        const confirmBtn2 = $("#modal-root [data-confirm-modal]");
        const check = $("#modal-root #delete-patch-confirm");
        if (confirmBtn2 && check) {
          confirmBtn2.disabled = !check.checked;
          check.addEventListener("change", () => { confirmBtn2.disabled = !check.checked; });
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

async function previewSupplementPlan(root) {
  const items = (state.missing?.items && state.missing.items.length) ? state.missing.items : supplementMockItems();
  const selected = supplementCurrentSelection(items);
  if (!selected.length) return toast("请至少选择一个样本。", "error");
  const runIds = Array.from(new Set(selected.map((x) => x.run_id).filter(Boolean)));
  if (runIds.length !== 1) return toast("预览计划仅支持单个 run。", "error");
  const selection = selected.map((x) => ({
    type: "sample",
    run_id: x.run_id || "",
    run_path: x.source_run_dir || x.source_run_path || "",
    sample_id: x.sample_id || "",
  }));
  const plan = await api.supplementPreviewPlan({ selection });
  state.supplementPlanPreview = plan;
  if ((plan.missing_required || []).length) {
    toast(`关键参数缺失：${(plan.missing_required || []).join(", ")}`, "error");
  } else {
    toast("补做计划预览已生成。", "success");
  }
  renderSupplementLocal(root);
}

async function startSupplementRun(root) {
  const items = (state.missing?.items && state.missing.items.length) ? state.missing.items : supplementMockItems();
  const selected = supplementCurrentSelection(items);
  if (!selected.length) return toast("请先选择样本。", "error");
  const selection = selected.map((x) => ({
    type: "sample",
    run_id: x.run_id || "",
    run_path: x.source_run_dir || x.source_run_path || "",
    sample_id: x.sample_id || "",
  }));
  const plan = state.supplementPlanPreview || await api.supplementPreviewPlan({ selection });
  if ((plan.missing_required || []).length) {
    throw new Error(`关键参数缺失：${(plan.missing_required || []).join(", ")}`);
  }
  const confirmed = window.confirm("确认在原 run 目录内执行补做？不会创建新的 run 文件夹。");
  if (!confirmed) return;
  const job = await api.supplementRun({ selection, monitor_ack_skip: true });
  state.supplementRunState = { jobId: job.job_id, cursor: 0, logs: [], status: job.status || "queued", timer: null };
  localStorage.setItem("fdtd.supplement.jobid.v1", job.job_id || "");
  toast(`补做任务已启动：${job.job_id}`, "success");
  startSupplementLogPolling(root);
}

async function pollSupplementLogs(root) {
  const rs = state.supplementRunState || {};
  if (!rs.jobId) return;
  try {
    const data = await api.supplementJobEvents(rs.jobId, { cursor: rs.cursor || 0 });
    rs.cursor = Number(data.next_cursor || rs.cursor || 0);
    rs.logs = [...(rs.logs || []), ...(data.events || [])].slice(-800);
    rs.status = data.state?.status || rs.status;
    state.supplementRunState = rs;
    if (["success", "failed"].includes(rs.status)) stopSupplementLogPolling();
    if (routeName() === "supplement") renderSupplementLocal(root || $("#page-root"));
  } catch (error) {
    stopSupplementLogPolling();
    toast(error.message, "error");
  }
}

function startSupplementLogPolling(root) {
  stopSupplementLogPolling();
  state.supplementRunState.timer = setInterval(() => {
    pollSupplementLogs(root).catch(() => {});
  }, 1500);
}

function stopSupplementLogPolling() {
  const t = state.supplementRunState?.timer;
  if (t) clearInterval(t);
  if (state.supplementRunState) state.supplementRunState.timer = null;
}

function collectSupplementSelection(root, items) {
  const selectedMap = collectSelectedEvidenceBySample(items || []);
  return (items || [])
    .filter((item) => selectedMap.has(supplementKey(item)))
    .map((item) => ({
      ...item,
      selected_missing_evidence: Array.from(new Set(selectedMap.get(supplementKey(item)) || [])),
      sample_fsp_path: (item.sample_fsp_candidates || [item.source_fsp || ""])[0] || "",
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
  $("#refresh-index").setAttribute("title", "左键：增量刷新；右键：清空缓存重建");
  $("#refresh-index").addEventListener("click", () => refreshIndex(false));
  $("#refresh-index").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    toast("已请求清空缓存重建。", "info");
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



