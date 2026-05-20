import { api } from "../api.js";
import { escapeHtml, filteredRuns, fmtNumber } from "../state.js";
import { toast } from "../ui.js";

let selectedRunId = "";
let allRuns = [];

export async function render() {
  const runs = allRuns.length ? allRuns : filteredRuns();
  if (!selectedRunId && runs[0]) selectedRunId = runs[0].run_id;
  return `
    <section class="page active">
      <div class="page-head">
        <div><h1 class="page-title">结果浏览</h1><div class="page-subtitle">左侧 run 树，中间样本与文件列表，右侧按类型安全预览；fsp 只展示元信息。</div></div>
      </div>
      <div class="layout-3">
        <div class="card pad">
          <div class="card-title">run 树 <span class="muted">${fmtNumber(runs.length)} 个</span></div>
          <div class="filter-grid" style="margin-bottom:12px">
            <select class="select" id="group-filter"><option value="">全部群类别</option><option>C2</option><option>C3</option><option>C4</option><option>C6</option><option>近径向</option></select>
            <select class="select" id="risk-filter"><option value="">全部风险</option><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option></select>
          </div>
          <div class="run-tree">
            ${runs.length ? runs.slice(0, 220).map((r) => `
              <button class="tree-row ${r.run_id === selectedRunId ? "active" : ""}" data-run-id="${escapeHtml(r.run_id)}" data-group="${escapeHtml(r.group || "")}" data-risk="${escapeHtml(r.risk_level || "")}" type="button">
                <span class="dot ${r.risk_level === "high" ? "red" : r.risk_level === "medium" ? "orange" : "green"}"></span>
                <span>${escapeHtml(r.group || "未识别")} / ${escapeHtml(r.mother_structure || "")} / ${escapeHtml(r.run_name || r.run_id)}</span>
                <span class="tag blue">${fmtNumber(r.sample_count || 0)}</span>
              </button>`).join("") : `<div class="empty">暂无 run 缓存。</div>`}
          </div>
        </div>
        <div class="card pad">
          <div class="card-title">样本点 / 输出文件 <span id="run-title" class="muted">未选择</span></div>
          <div id="sample-table" class="empty">请选择 run。</div>
          <div class="card-title" style="margin-top:16px">文件列表</div>
          <div id="file-table" class="empty">请选择 run。</div>
        </div>
        <div class="card pad">
          <div class="card-title">文件预览 <span class="muted">限制读取大小</span></div>
          <div id="preview-pane" class="preview-pane">选择文件后显示预览。</div>
        </div>
      </div>
    </section>`;
}

async function loadRun(root, runId) {
  selectedRunId = runId;
  root.querySelectorAll(".tree-row").forEach((row) => row.classList.toggle("active", row.dataset.runId === runId));
  try {
    const [run, samples, files] = await Promise.all([api.run(runId), api.runSamples(runId), api.runFiles(runId)]);
    root.querySelector("#run-title").textContent = run.run_name || runId;
    root.querySelector("#sample-table").innerHTML = (samples.samples || []).length ? `
      <table class="table"><thead><tr><th>sample_id</th><th>delta</th><th>λ0</th><th>score</th><th>缺失证据</th></tr></thead><tbody>
      ${(samples.samples || []).slice(0, 80).map((s) => `<tr><td>${escapeHtml(s.sample_id)}</td><td>${escapeHtml(s.delta ?? "")}</td><td>${escapeHtml(s.lambda0_nm ?? "")}</td><td>${escapeHtml(s.score ?? "")}</td><td>${escapeHtml((s.missing_evidence || []).join(", "))}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">未发现 scan_points / manifest 样本摘要。</div>`;
    root.querySelector("#file-table").innerHTML = (files.files || []).length ? `
      <table class="table"><thead><tr><th>文件</th><th>类型</th><th>大小</th><th>预览</th></tr></thead><tbody>
      ${(files.files || []).slice(0, 160).map((f) => `<tr><td>${escapeHtml(f.relative_path)}</td><td>${escapeHtml(f.kind)}</td><td>${fmtNumber(f.size || 0)}</td><td><button class="link" data-file-path="${escapeHtml(f.relative_path)}" type="button">预览</button></td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">该 run 下未登记文件。</div>`;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function preview(root, path) {
  try {
    const data = await api.previewFile(path);
    const pane = root.querySelector("#preview-pane");
    if (data.kind === "image") {
      pane.innerHTML = `<img src="${escapeHtml(data.url)}" alt="${escapeHtml(path)}"><p class="muted">${escapeHtml(path)}</p>`;
    } else if (data.kind === "xlsx") {
      pane.innerHTML = `<strong>工作表摘要</strong><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    } else if (data.kind === "fsp") {
      pane.innerHTML = `<table class="table"><tbody><tr><td>路径</td><td>${escapeHtml(data.relative_path)}</td></tr><tr><td>大小</td><td>${fmtNumber(data.size)} bytes</td></tr><tr><td>mtime</td><td>${escapeHtml(data.mtime)}</td></tr></tbody></table>`;
    } else {
      pane.innerHTML = `<pre>${escapeHtml(data.text || JSON.stringify(data, null, 2))}</pre>`;
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function afterRender(root) {
  if (!allRuns.length) {
    try {
      const data = await api.runs();
      allRuns = data.runs || [];
      root.innerHTML = await render();
      return afterRender(root);
    } catch (error) {
      toast(error.message, "error");
    }
  }
  root.querySelectorAll("[data-run-id]").forEach((btn) => btn.addEventListener("click", () => loadRun(root, btn.dataset.runId)));
  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-file-path]");
    if (btn) preview(root, btn.dataset.filePath);
  });
  root.querySelector("#group-filter").addEventListener("change", (event) => {
    const value = event.target.value;
    root.querySelectorAll("[data-run-id]").forEach((row) => { row.hidden = value && !row.dataset.group.includes(value); });
  });
  root.querySelector("#risk-filter").addEventListener("change", (event) => {
    const value = event.target.value;
    root.querySelectorAll("[data-run-id]").forEach((row) => { row.hidden = value && row.dataset.risk !== value; });
  });
  if (selectedRunId) loadRun(root, selectedRunId);
}
