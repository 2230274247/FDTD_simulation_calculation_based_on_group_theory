import { api } from "../api.js";
import { drawHeatmap, drawLine } from "../charts.js";
import { escapeHtml, filteredRuns, fmtNumber } from "../state.js";
import { toast } from "../ui.js";

let selectedRunId = "";
let allRuns = [];

export async function render() {
  const runs = allRuns.length ? allRuns : filteredRuns();
  selectedRunId = selectedRunId || runs[0]?.run_id || "";
  return `
    <section class="page active">
      <div class="page-head">
        <div><h1 class="page-title">模式接力 / 拓扑候选</h1><div class="page-subtitle">基于 T(λ,δ)、λ_peak/λ_dip 轨迹、临界区间和证据缺口筛选候选。</div></div>
        <select class="select" id="relay-run" style="max-width:440px">${runs.map((r) => `<option value="${escapeHtml(r.run_id)}" ${r.run_id === selectedRunId ? "selected" : ""}>${escapeHtml(r.group || "")} / ${escapeHtml(r.mother_structure || "")} / ${escapeHtml(r.run_name || r.run_id)}</option>`).join("")}</select>
      </div>
      <div class="notice">本页仅为候选筛选；严格证明仍需 k-space 扫描、带隙演化、相位连续性与缠绕数验证。</div>
      <div class="metric-grid" id="relay-metrics">
        <div class="metric"><label>候选强度</label><strong>待载入</strong></div>
        <div class="metric"><label>临界区间</label><strong>待载入</strong></div>
        <div class="metric"><label>代表样本数</label><strong>待载入</strong></div>
        <div class="metric"><label>证据缺口</label><strong>待载入</strong></div>
      </div>
      <div class="layout-2">
        <div>
          <div class="card chart-card">
            <div class="chart-head"><strong>T(λ,δ) 热图</strong><span class="muted">只绘制当前可见图表</span></div>
            <div class="chart-box"><canvas id="relay-heatmap"></canvas></div>
          </div>
          <div class="card chart-card" style="margin-top:16px">
            <div class="chart-head"><strong>λ_peak / λ_dip 轨迹</strong></div>
            <div class="chart-box"><canvas id="relay-track"></canvas></div>
          </div>
        </div>
        <div class="card pad">
          <div class="card-title">候选概览表</div>
          <div id="relay-candidates" class="empty">待载入。</div>
          <div class="card-title" style="margin-top:16px">证据缺口列表</div>
          <div id="relay-gaps" class="flag-list"></div>
          <div class="card-title" style="margin-top:16px">下一步 Todo</div>
          <div id="relay-todo" class="advice-list"></div>
        </div>
      </div>
    </section>`;
}

async function load(root, runId) {
  try {
    const [relay, heatmap, candidates] = await Promise.all([api.modeRelay(runId), api.modeRelayHeatmap(runId), api.modeRelayCandidates("")]);
    root.querySelector("#relay-metrics").innerHTML = `
      <div class="metric"><label>候选强度</label><strong>${fmtNumber(relay.candidate_strength, 2, "待算")}</strong></div>
      <div class="metric"><label>临界区间</label><strong>${escapeHtml(relay.critical_interval || "待识别")}</strong></div>
      <div class="metric"><label>代表样本数</label><strong>${fmtNumber(relay.representative_sample_count || 0)}</strong></div>
      <div class="metric"><label>证据缺口</label><strong>${fmtNumber((relay.evidence_gaps || []).length)}</strong></div>`;
    root.querySelector("#relay-candidates").innerHTML = (candidates.candidates || []).length ? `
      <table class="table"><thead><tr><th>群</th><th>母结构</th><th>扰动</th><th>强度</th></tr></thead><tbody>
      ${(candidates.candidates || []).slice(0, 10).map((c) => `<tr><td>${escapeHtml(c.group)}</td><td>${escapeHtml(c.mother_structure)}</td><td>${escapeHtml(c.perturbation)}</td><td>${fmtNumber(c.candidate_strength, 2, "待算")}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">暂无候选。</div>`;
    root.querySelector("#relay-gaps").innerHTML = (relay.evidence_gaps || ["k-space 扫描", "相位连续性", "缠绕数验证"]).map((gap) => `<div class="flag-item"><span class="dot orange"></span><span>${escapeHtml(gap)}</span><span class="tag orange">待补</span></div>`).join("");
    root.querySelector("#relay-todo").innerHTML = (relay.todo || ["进入补做实验生成 angle-resolved / band sweep 任务包。"]).map((todo) => `<button class="advice-item warn" data-go="supplement" type="button"><span class="dot orange"></span><span>${escapeHtml(todo)}</span><span class="tag orange">补证</span></button>`).join("");
    drawHeatmap(root.querySelector("#relay-heatmap"), heatmap);
    drawLine(root.querySelector("#relay-track"), (relay.track || []).map((p) => ({ x: p.delta, y: p.lambda_nm })), { xLabel: "δ", yLabel: "λ_peak" });
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
  root.querySelector("#relay-run")?.addEventListener("change", (event) => {
    selectedRunId = event.target.value;
    load(root, selectedRunId);
  });
  if (selectedRunId) load(root, selectedRunId);
}
