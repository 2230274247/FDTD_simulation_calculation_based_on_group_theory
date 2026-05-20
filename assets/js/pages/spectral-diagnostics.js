import { api } from "../api.js";
import { drawLine, drawTrend } from "../charts.js";
import { escapeHtml, fmtNumber, filteredRuns } from "../state.js";
import { toast } from "../ui.js";

let selectedRunId = "";
let allRuns = [];

export async function render() {
  const runs = allRuns.length ? allRuns : filteredRuns();
  selectedRunId = window.sessionStorage.getItem("fdtd:selectedRunId") || selectedRunId || runs[0]?.run_id || "";
  return `
    <section class="page active">
      <div class="page-head">
        <div><h1 class="page-title">光谱诊断</h1><div class="page-subtitle">展示目标函数、证据完整度、λ0、Q、FWHM、T(λ)、参数趋势、质量旗标和下一步建议。</div></div>
        <select class="select" id="diagnosis-run" style="max-width:440px">
          ${runs.map((r) => `<option value="${escapeHtml(r.run_id)}" ${r.run_id === selectedRunId ? "selected" : ""}>${escapeHtml(r.group || "")} / ${escapeHtml(r.mother_structure || "")} / ${escapeHtml(r.run_name || r.run_id)}</option>`).join("")}
        </select>
      </div>
      <div class="metric-grid" id="diagnosis-metrics">
        <div class="metric"><label>最佳评分 score</label><strong>待载入</strong></div>
        <div class="metric"><label>λ0</label><strong>待载入</strong></div>
        <div class="metric"><label>Q</label><strong>待载入</strong></div>
        <div class="metric"><label>FWHM</label><strong>待载入</strong></div>
      </div>
      <div class="layout-2">
        <div>
          <div class="card chart-card">
            <div class="chart-head"><strong>T(λ) 曲线</strong><select class="select" id="spectrum-kind" style="width:130px"><option>T</option><option>R</option><option>A</option></select></div>
            <div class="chart-box"><canvas id="spectrum-chart"></canvas></div>
          </div>
          <div class="card chart-card" style="margin-top:16px">
            <div class="chart-head"><strong>参数趋势</strong><span class="muted">来自 spectral_metrics.csv 或实时摘要</span></div>
            <div class="chart-box"><canvas id="trend-chart"></canvas></div>
          </div>
        </div>
        <div class="card pad">
          <div class="card-title">当前研究对象</div>
          <div id="diagnosis-context" class="empty">请选择 run。</div>
          <div class="card-title" style="margin-top:16px">质量旗标</div>
          <div id="quality-flags" class="flag-list"></div>
          <div class="card-title" style="margin-top:16px">下一步建议</div>
          <div id="diagnosis-advice" class="advice-list"></div>
        </div>
      </div>
    </section>`;
}

function flagsHtml(flags) {
  const required = ["T > 1", "采样不足", "FWHM 不可靠", "主特征靠边界", "缺 R", "缺 A", "缺 Field", "缺 Phase", "缺 Poynting"];
  const set = new Set(flags || []);
  return required.map((f) => `<div class="flag-item"><span class="dot ${set.has(f) ? "red" : "green"}"></span><span>${escapeHtml(f)}</span><span class="tag ${set.has(f) ? "red" : "green"}">${set.has(f) ? "触发" : "通过"}</span></div>`).join("");
}

async function load(root, runId) {
  if (!runId) return;
  selectedRunId = runId;
  window.sessionStorage.setItem("fdtd:selectedRunId", runId);
  try {
    const [diag, spectrum, trend, quality] = await Promise.all([
      api.diagnosticsRun(runId),
      api.diagnosticsSpectrum(runId, "", root.querySelector("#spectrum-kind")?.value || "T"),
      api.diagnosticsTrend(runId),
      api.diagnosticsQuality(runId),
    ]);
    root.querySelector("#diagnosis-metrics").innerHTML = `
      <div class="metric"><label>最佳评分 score</label><strong>${fmtNumber(diag.best_score, 2, "待算")}</strong></div>
      <div class="metric"><label>λ0</label><strong>${fmtNumber(diag.lambda0_nm, 2, "待算")} nm</strong></div>
      <div class="metric"><label>Q</label><strong>${fmtNumber(diag.q, 2, "待算")}</strong></div>
      <div class="metric"><label>FWHM</label><strong>${fmtNumber(diag.fwhm_nm, 3, "待算")} nm</strong></div>`;
    root.querySelector("#diagnosis-context").innerHTML = `
      <table class="table"><tbody>
        <tr><td>群类别</td><td>${escapeHtml(diag.group || "")}</td></tr>
        <tr><td>母结构</td><td>${escapeHtml(diag.mother_structure || "")}</td></tr>
        <tr><td>扰动方式</td><td>${escapeHtml(diag.perturbation || "")}</td></tr>
        <tr><td>降群路径</td><td>${escapeHtml(diag.reduction_path || "待识别")}</td></tr>
        <tr><td>目标函数</td><td>${escapeHtml(diag.objective || "score/Q/FWHM 综合评分")}</td></tr>
        <tr><td>证据完整度</td><td>${fmtNumber((diag.evidence_completeness || 0) * 100, 1)}%</td></tr>
        <tr><td>质量状态</td><td>${escapeHtml(diag.quality_status || "待审计")}</td></tr>
      </tbody></table>`;
    root.querySelector("#quality-flags").innerHTML = flagsHtml(quality.flags);
    root.querySelector("#diagnosis-advice").innerHTML = (diag.next_actions || ["若缺少 R/A/Field/Phase/Poynting，请进入补做实验生成任务包。"]).map((a) => `<div class="advice-item warn"><span class="dot orange"></span><span>${escapeHtml(a)}</span><button class="link" data-go="supplement" type="button">补做</button></div>`).join("");
    drawLine(root.querySelector("#spectrum-chart"), (spectrum.points || []).map((p) => ({ x: p[0], y: p[1] })), { yLabel: spectrum.kind || "T" });
    drawTrend(root.querySelector("#trend-chart"), trend.points || [], "delta", "score");
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
  root.querySelector("#diagnosis-run")?.addEventListener("change", (event) => load(root, event.target.value));
  root.querySelector("#spectrum-kind")?.addEventListener("change", () => load(root, selectedRunId));
  if (selectedRunId) load(root, selectedRunId);
}
