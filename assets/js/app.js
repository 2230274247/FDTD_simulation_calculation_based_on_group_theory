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
  resultFilters: { scope: "current", group: "", mother: "", perturbation: "", risk: "" },
  selectedSampleId: "",
  resultPreviewImages: [],
  resultPreviewIndex: 0,
  resultAutoplayTimer: null,
  indexStatus: { running: false, progress: 0 },
  preloadStatus: null,
  warmupStarted: false,
  warmupDone: false,
  search: "",
};

let warmupPausedUntil = 0;
let renderSeq = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const fmt = (value, digits = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const tagTone = (risk) => risk === "high" ? "red" : risk === "medium" ? "orange" : "green";

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
    state.runsPage = await api.runs({ page: 1, page_size: route === "results" ? 500 : 50, query: q, ...filters });
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
  const groups = overview.groups || [];
  const candidates = overview.top_candidates || [];
  const recent = overview.recent_runs || [];
  const risks = overview.risks || [];
  const noCache = !state.meta?.built_at;
  return `<section class="page active">
    ${pageHead("研究总览", "首屏只读取轻量缓存；目录扫描必须由后台刷新显式触发。", `<button class="btn secondary" id="first-index" type="button">${noCache ? "开始首次索引" : "后台刷新索引"}</button>`)}
    <div class="stat-grid">
      ${statCard("有效 run", s.valid_run_count, "存在 T 谱、manifest 或扫描点")}
      ${statCard("异常 run", s.bad_run_count, "严重质量旗标")}
      ${statCard("已诊断谱线", s.spectra_count, "T/R/A 谱线索引")}
      ${statCard("缺失证据", s.missing_evidence_count, "R/A/Field/Phase/Poynting")}
      ${statCard("母结构覆盖率", pct(s.mother_coverage_rate), "按脚本与有效结果估算")}
    </div>
    ${noCache ? `<div class="empty">尚未建立索引。页面不会自动扫描真实目录，请点击“开始首次索引”。</div>` : ""}
    <div class="overview-grid">
      <div class="card pad coverage-card"><div class="card-title">群分类覆盖</div>${groups.length ? groups.map(groupProgress).join("") : emptySmall("暂无群分类缓存")}</div>
      <div class="card pad candidate-card"><div class="card-title">高价值候选 <button class="link" data-go="diagnosis" type="button">进入诊断</button></div>${candidateTable(candidates)}</div>
      <div class="card pad advice-card"><div class="card-title">下一步建议</div>${adviceList(overview.next_actions || [])}</div>
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
      <div><div class="card pad"><div class="card-title">启动摘要</div><table class="table"><tbody><tr><td>选择脚本</td><td id="selected-script-count">${state.selectedScriptIds.size}</td></tr><tr><td>扫描点数估算</td><td id="point-estimate">待预览</td></tr><tr><td>预计时长</td><td id="duration-estimate">待预览</td></tr><tr><td>安全状态</td><td>未启动</td></tr></tbody></table><div class="toolbar" style="margin-top:14px"><button class="btn secondary" id="preview-run" type="button">预览命令</button><button class="btn primary" id="start-run" type="button">启动</button></div></div><div class="terminal-head" style="margin-top:12px"><span>实时日志</span><button class="link" id="stop-job" type="button">停止任务</button></div><pre class="terminal" id="job-log">尚未启动任务。</pre></div>
    </div>
    <div class="bottom-actions"><span class="muted">危险操作都需要二次确认；full + parallel 会触发高风险确认。</span><div class="toolbar"><button class="btn ghost" id="clear-selected" type="button">清空选择</button><button class="btn primary" id="bottom-start" type="button">确认启动</button></div></div>
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
  const filters = state.resultFilters;
  const groupOptions = uniqueValues(runs, "group");
  const motherOptions = uniqueValues(runs, "mother_structure");
  const perturbOptions = uniqueValues(runs, "perturbation").slice(0, 80);
  return `<section class="page active">
    ${pageHead("结果浏览", "按当前结果 / 旧文件分域加载；run 树使用 群类别 → 母结构 → 扰动 → run 的层级，点击样本后预览对应谱图。")}
    <div class="results-layout">
      <div class="card pad">
        <div class="card-title">run 树 <span class="muted">${fmt(state.runsPage?.total || runs.length)} 个</span></div>
        <div class="filter-stack">
          <select class="select" id="scope-filter"><option value="current" ${filters.scope === "current" ? "selected" : ""}>当前 results</option><option value="old" ${filters.scope === "old" ? "selected" : ""}>旧文件结果</option><option value="" ${!filters.scope ? "selected" : ""}>全部结果</option></select>
          <select class="select" id="group-filter"><option value="">全部群类别</option>${groupOptions.map((x) => `<option ${x === filters.group ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
          <select class="select" id="mother-filter"><option value="">全部母结构</option>${motherOptions.map((x) => `<option ${x === filters.mother ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
          <select class="select" id="perturbation-filter"><option value="">全部扰动</option>${perturbOptions.map((x) => `<option ${x === filters.perturbation ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
          <select class="select" id="risk-filter"><option value="">全部风险</option><option value="high" ${filters.risk === "high" ? "selected" : ""}>高风险</option><option value="medium" ${filters.risk === "medium" ? "selected" : ""}>中风险</option><option value="low" ${filters.risk === "low" ? "selected" : ""}>低风险</option></select>
        </div>
        <div class="run-tree hierarchical">${runs.length ? renderRunTree(runs) : emptySmall("暂无 run 缓存")}</div>
      </div>
      <div class="results-main">
        <div class="card pad">
          <div class="card-title">样本点 / 输出文件 <span id="run-title" class="muted">${esc(state.selectedRunId || "未选择")}</span></div>
          <div id="sample-table" class="empty">请选择 run。</div>
        </div>
        <div class="card chart-card" style="margin-top:16px">
          <div class="chart-head"><strong>参数趋势 / 相关资源</strong><span id="resource-hint" class="muted">选择 run 后按需加载</span></div>
          <div class="trend-resource-grid">
            <div class="chart-box small"><canvas id="result-trend-chart"></canvas></div>
            <div id="resource-strip" class="resource-strip">请选择 run。</div>
          </div>
        </div>
      </div>
      <div class="card pad">
        <div class="card-title">谱图预览 <span class="muted">样本点联动</span></div>
        <div id="preview-pane" class="preview-pane spectrum-preview">点击“样本点 / 输出文件”中的样本后显示透射谱图。</div>
      </div>
    </div>
  </section>`;
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
  return `<div class="toolbar" style="margin-bottom:16px"><select class="select" id="run-select" style="max-width:520px">${runs.map((r) => `<option value="${esc(r.run_id)}" ${r.run_id === state.selectedRunId ? "selected" : ""}>${esc(r.group || "")} / ${esc(r.mother_structure || "")} / ${esc(r.run_name || r.run_id)}</option>`).join("")}</select><button class="btn secondary" id="load-run-diagnostics" type="button">加载当前 run</button></div>`;
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

function renderSupplement() {
  const items = state.missing?.items || [];
  const packages = state.packages?.packages || state.supplements || [];
  return `<section class="page active">
    ${pageHead("补做实验", "从缺失证据和质量旗标生成 patch_request.json 与 patch_points.csv，不覆盖原 run。")}
    <div class="notice">缺 Field/Phase/Poynting 时，建议打开对应 source_fsp 添加场、相位或能流监视器；缺 R/A 时补反射或吸收输出。任务包只记录计划，不覆盖原 run。</div>
    <div class="layout-2"><div class="card pad"><div class="card-title">待补做样本 <span class="muted">${fmt(items.length)} 条</span></div><div class="toolbar" style="margin-bottom:12px"><select class="select" id="supplement-type" style="max-width:240px"><option value="field">Field</option><option value="phase">Phase</option><option value="poynting">Poynting</option><option value="R">R</option><option value="A">A</option><option value="angle-resolved">angle-resolved</option><option value="band sweep">band sweep</option></select><button class="btn primary" id="create-package" type="button">生成任务包</button></div>${items.length ? `<table class="table supplement-table"><thead><tr><th>选择</th><th>样本</th><th>缺失与建议</th><th>指标</th><th>操作</th></tr></thead><tbody>${items.slice(0, 120).map((s, i) => `<tr><td><input type="checkbox" data-missing-index="${i}" ${i < 5 ? "checked" : ""}></td><td>${esc(s.group || "")} / ${esc(s.mother_structure || "")}<br><span class="muted">${esc(s.run_id || "")} ${esc(s.sample_id || "")}</span></td><td>${evidenceAdvice(s.missing_evidence || [])}<br><span class="muted">${esc(s.reason || "")}</span></td><td>λ0 ${fmt(s.lambda0_nm, 2)}<br>Q ${fmt(s.Q, 1)} / FWHM ${fmt(s.FWHM_nm, 3)}</td><td>${s.source_fsp ? `<button class="link" data-open-fsp="${esc(s.source_fsp)}" type="button">打开 FSP</button>` : `<span class="muted">无 FSP</span>`}</td></tr>`).join("")}</tbody></table>` : emptySmall("暂无待补做样本")}</div><div class="card pad"><div class="card-title">已有任务包</div>${packages.length ? `<div class="package-list">${packages.slice(0, 40).map((p) => `<div class="package-row"><div><strong>${esc(p.package_id)}</strong><br><span class="muted">${esc(p.relative_path || p.output_root || "")}</span></div><span>${esc(p.status || "")}</span><span>${esc(p.created_at || "")}</span><button class="btn danger" data-delete-package="${esc(p.package_id)}" type="button">删除</button></div>`).join("")}</div>` : emptySmall("暂无补做任务包")}</div></div>
  </section>`;
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

function bindRun(root) {
  $$(".tree-row[data-script-id]", root).forEach((row) => row.addEventListener("click", () => {
    const id = row.dataset.scriptId;
    if (state.selectedScriptIds.has(id)) state.selectedScriptIds.delete(id);
    else state.selectedScriptIds.add(id);
    row.classList.toggle("active");
    $("#selected-script-count", root).textContent = state.selectedScriptIds.size;
  }));
  $$(".segmented", root).forEach((seg) => seg.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    $$("button", seg).forEach((b) => b.classList.toggle("active", b === btn));
  }));
  $("#refresh-scripts", root)?.addEventListener("click", async () => {
    await api.refreshScripts();
    state.scriptsPage = null;
    toast("脚本缓存已刷新。", "success");
    await renderRoute();
  });
  $("#preview-run", root)?.addEventListener("click", async () => {
    try {
      const preview = await api.controllerPreview(collectRunPayload(root));
      $("#point-estimate", root).textContent = preview.estimated_points || preview.job_preview?.estimated_points || "按脚本默认";
      $("#duration-estimate", root).textContent = preview.estimated_duration || preview.job_preview?.estimated_runtime || "无法估算";
      $("#job-log", root).textContent = Array.isArray(preview.command) ? preview.command.join(" ") : preview.command;
    } catch (error) {
      toast(error.message, "error");
    }
  });
  const start = () => {
    const payload = collectRunPayload(root);
    if (!payload.ids.length) return toast("请先选择至少一个脚本。", "error");
    const highRisk = payload.mode === "full" && payload.style === "parallel";
    openModal({
      title: highRisk ? "高风险启动确认" : "启动确认",
      danger: highRisk,
      confirmText: highRisk ? "确认 full 并行启动" : "确认启动",
      body: `<p>${highRisk ? "full + parallel 可能占用大量内存。" : "将通过 fdtd_master_controller.py 启动任务。"}</p><pre class="mono">${esc(JSON.stringify(payload, null, 2))}</pre>`,
      onConfirm: async () => {
        const job = await api.controllerStart({ ...payload, confirm: true, risk_ack: highRisk });
        state.activeJobId = job.job_id;
        $("#job-log", root).textContent = `任务已启动：${job.job_id}\n${Array.isArray(job.command) ? job.command.join(" ") : job.command}`;
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
  });
  $("#stop-job", root)?.addEventListener("click", async () => {
    if (!state.activeJobId) return toast("当前没有可停止任务。", "error");
    await api.stopJob(state.activeJobId);
    toast("已发送停止请求。", "success");
  });
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
    $("#job-log", root).textContent = log.text || `任务状态：${job.status}`;
    if (job.status === "running" || job.status === "stopping") {
      setTimeout(() => pollJob(root), 1500);
    } else {
      const changes = await api.cacheChanges(job.created_at || "");
      toast(`任务结束，已增量索引 ${changes.changed_runs?.length || 0} 个 run。`, "success");
      await bootstrap();
    }
  } catch (error) {
    $("#job-log", root).textContent = error.message;
  }
}

function sampleRiskTone(sample) {
  const flags = sample.quality_flags || [];
  const maxT = Number(sample.max_T ?? sample.max_t);
  if (flags.includes("T > 1") || (Number.isFinite(maxT) && maxT > 1)) return "bad";
  if (flags.some((x) => String(x).includes("FWHM")) || (sample.missing_evidence || []).length) return "warn";
  return "ok";
}

function sampleRow(sample, index) {
  const tone = sampleRiskTone(sample);
  const flags = sample.quality_flags || [];
  const missing = sample.missing_evidence || [];
  const maxT = Number(sample.max_T ?? sample.max_t);
  const convergence = flags.includes("T > 1") || (Number.isFinite(maxT) && maxT > 1)
    ? `<span class="flag-text bad">不收敛：T &gt; 1</span>`
    : `<span class="flag-text ${tone}">${tone === "ok" ? "质量正常" : "需复核"}</span>`;
  return `<tr class="sample-row ${state.selectedSampleId === String(sample.sample_id) ? "active" : ""}" data-sample-index="${index}" data-sample-id="${esc(sample.sample_id)}">
    <td><button class="link" data-sample-index="${index}" type="button">${esc(sample.sample_id)}</button></td>
    <td>${esc(sample.delta ?? "")}</td>
    <td>${fmt(sample.lambda0_nm, 2)}</td>
    <td>${fmt(sample.Q ?? sample.q, 1)}</td>
    <td>${fmt(sample.FWHM_nm ?? sample.fwhm_nm, 3)}</td>
    <td>${fmt(sample.max_T ?? sample.max_t, 3)}</td>
    <td>${fmt(sample.score, 3)}</td>
    <td>${convergence}<br><span class="muted">${esc([...missing, ...flags].slice(0, 5).join(", "))}</span></td>
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

function renderSamplePreview(root, detail, sampleIndex) {
  const samples = detail.samples || [];
  const sample = samples[sampleIndex] || samples[0] || {};
  state.selectedSampleId = String(sample.sample_id || "");
  state.resultPreviewImages = getRunImages(detail);
  state.resultPreviewIndex = Math.min(Math.max(sampleIndex, 0), Math.max(0, state.resultPreviewImages.length - 1));
  const image = state.resultPreviewImages[state.resultPreviewIndex];
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
    <div class="peak-tools">
      <input class="input" id="peak-min" type="number" step="0.001" placeholder="λ min nm" value="${esc(sample.lambda0_nm ? Number(sample.lambda0_nm).toFixed(3) : "")}">
      <input class="input" id="peak-max" type="number" step="0.001" placeholder="λ max nm" value="${esc(sample.lambda0_nm ? (Number(sample.lambda0_nm) + 1).toFixed(3) : "")}">
      <button class="btn primary" id="save-peak-selection" type="button">记录峰值区间</button>
    </div>
    <div class="chart-box small" style="margin-top:10px"><canvas id="sample-spectrum-canvas"></canvas></div>
    <div id="peak-result" class="muted">框选峰区后会写入当前 run 的 12_analysis_summary/v2_peak_selections.json。</div>
  `;
  loadSampleSpectrum(root, sample.sample_id);
}

async function loadSampleSpectrum(root, sampleId = "") {
  if (!state.selectedRunId) return;
  try {
    const data = await api.diagnosticsSpectrum(state.selectedRunId, sampleId || "", "T");
    const points = (data.points || []).map((p) => ({ x: Number(p[0]), y: Number(p[1]) }));
    drawLine($("#sample-spectrum-canvas", root), points, { xLabel: "λ (nm)", yLabel: "T" });
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
  $$(".tree-row[data-run-id]", root).forEach((btn) => btn.addEventListener("click", () => loadRunInResults(root, btn.dataset.runId)));
  [
    ["scope-filter", "scope"],
    ["group-filter", "group"],
    ["mother-filter", "mother"],
    ["perturbation-filter", "perturbation"],
    ["risk-filter", "risk"],
  ].forEach(([id, key]) => {
    $(`#${id}`, root)?.addEventListener("change", async (event) => {
      state.resultFilters[key] = event.target.value;
      await renderRoute();
    });
  });
  root.addEventListener("click", (event) => {
    if (routeName() !== "results") return;
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
      api.openFolder(openFolder.dataset.openFolder).then(() => toast("已请求打开文件夹。", "success")).catch((error) => toast(error.message, "error"));
      return;
    }
    if (event.target.closest("#save-peak-selection")) {
      api.savePeakSelection({
        run_id: state.selectedRunId,
        sample_id: state.selectedSampleId,
        kind: "T",
        lambda_min: $("#peak-min", root)?.value,
        lambda_max: $("#peak-max", root)?.value,
      }).then((result) => {
        const m = result.selection?.metrics || {};
        $("#peak-result", root).innerHTML = `已记录：λ0 ${fmt(m.lambda0_nm, 3)} nm，FWHM ${fmt(m.FWHM_nm, 4)} nm，Q ${fmt(m.Q, 2)}。<br><span class="muted">${esc(result.relative_path || "")}</span>`;
        toast("峰值区间已写入 run 的分析摘要。", "success");
      }).catch((error) => toast(error.message, "error"));
      return;
    }
    const btn = event.target.closest("[data-file-path]");
    const pane = $("#preview-pane", root);
    if (btn && pane) previewFile(btn.dataset.filePath, pane);
  });
  if (state.selectedRunId) loadRunInResults(root, state.selectedRunId);
}

async function loadRunInResults(root, runId) {
  state.selectedRunId = runId;
  stopResultAutoplay();
  $$(".tree-row[data-run-id]", root).forEach((row) => row.classList.toggle("active", row.dataset.runId === runId));
  try {
    const detail = await api.run(runId);
    state.runDetails.set(runId, detail);
    $("#run-title", root).textContent = detail.run?.run_name || detail.run_name || runId;
    const samples = detail.samples || [];
    const files = detail.files || [];
    const samplePane = $("#sample-table", root);
    samplePane.className = samples.length ? "" : "empty";
    samplePane.innerHTML = samples.length ? `<div class="sample-table-wrap"><table class="table sample-table"><thead><tr><th>sample</th><th>δ / 参数</th><th>λ0 nm</th><th>Q</th><th>FWHM nm</th><th>max(T)</th><th>score</th><th>状态</th></tr></thead><tbody>${samples.slice(0, 160).map(sampleRow).join("")}</tbody></table></div>` : "未发现 scan_points / manifest 样本摘要。";
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
  $("#run-select", root)?.addEventListener("change", (event) => {
    state.selectedRunId = event.target.value;
    state.diagnostics = null;
    state.spectrum = null;
    state.trend = null;
    renderRoute();
  });
  $("#load-run-diagnostics", root)?.addEventListener("click", () => loadDiagnostics(root));
  $("#load-spectrum", root)?.addEventListener("click", () => loadSpectrum(root));
  $("#load-trend", root)?.addEventListener("click", () => loadTrend(root));
  root.addEventListener("click", (event) => {
    const img = event.target.closest("[data-diagnosis-image]");
    if (img) openDrawer("谱图预览", `<img src="/api/v2/files/raw?path=${encodeURIComponent(img.dataset.diagnosisImage.replaceAll("\\", "/"))}" alt="${esc(img.dataset.diagnosisImage)}" style="width:100%;height:auto;border-radius:8px"><p class="muted">${esc(img.dataset.diagnosisImage)}</p>`);
  });
  if (state.spectrum?.run_id === state.selectedRunId) {
    const points = (state.spectrum.points || []).map((p) => ({ x: Number(p[0]), y: Number(p[1]) }));
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
  const points = (data.points || []).map((p) => ({ x: Number(p[0]), y: Number(p[1]) }));
  drawLine($("#spectrum-chart", root), points, { xLabel: "λ (nm)", yLabel: "T" });
}

async function loadTrend(root) {
  if (!state.selectedRunId) return;
  state.trend = await api.diagnosticsTrend(state.selectedRunId);
  drawTrend($("#trend-chart", root), state.trend.points || [], "delta", "score");
}

function bindTopology(root) {
  $("#run-select", root)?.addEventListener("change", (event) => {
    state.selectedRunId = event.target.value;
    state.relay = null;
    state.heatmap = null;
    renderRoute();
  });
  $("#load-run-diagnostics", root)?.addEventListener("click", () => loadRelay(root));
  $("#load-heatmap", root)?.addEventListener("click", () => loadHeatmap(root));
  root.addEventListener("click", (event) => {
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
  root.addEventListener("click", (event) => {
    const del = event.target.closest("[data-delete-package]");
    if (!del) return;
    const packageId = del.dataset.deletePackage;
    openModal({
      title: "删除补做任务包",
      danger: true,
      confirmText: "确认删除任务包",
      body: `<p>只会删除 V2 生成的 patch 任务包目录和 supplement_index 条目，不会删除原始 run。</p><pre class="mono">${esc(packageId)}</pre>`,
      onConfirm: async () => {
        await api.deleteSupplementPackage(packageId);
        toast("补做任务包已删除。", "success");
        state.packages = await api.supplementPackages();
        await renderRoute();
      },
    });
  });
  $("#create-package", root)?.addEventListener("click", async () => {
    const items = state.missing?.items || [];
    const selected = $$("[data-missing-index]:checked", root).map((box) => items[Number(box.dataset.missingIndex)]).filter(Boolean);
    if (!selected.length) return toast("请至少选择一个待补做样本。", "error");
    const supplementType = $("#supplement-type", root).value;
    const item = await api.createSupplementPackage({ supplement_type: supplementType, monitor_policy: "single_monitor_only", samples: selected });
    toast(`已生成任务包：${item.package_id}`, "success");
    state.packages = await api.supplementPackages();
    await renderRoute();
  });
}

function bindResources(root) {
  root.addEventListener("click", (event) => {
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
      api.openFile(openFsp.dataset.openFsp).then(() => toast("已请求打开 FSP。", "success")).catch((error) => toast(error.message, "error"));
    }
    const openFolder = event.target.closest("[data-open-folder]");
    if (openFolder?.dataset.openFolder && routeName() !== "results") {
      event.preventDefault();
      api.openFolder(openFolder.dataset.openFolder).then(() => toast("已请求打开文件夹。", "success")).catch((error) => toast(error.message, "error"));
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
