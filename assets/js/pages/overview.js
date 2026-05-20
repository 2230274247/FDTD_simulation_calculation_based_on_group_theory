import { api } from "../api.js";
import { drawDonut } from "../charts.js";
import { escapeHtml, fmtNumber, groups, pct, risks, runs, summary } from "../state.js";
import { toast } from "../ui.js";

function stat(label, value, note, tone = "") {
  return `
    <div class="card stat-card">
      <div class="stat-icon ${tone}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16l3-5 4 3 5-8"/></svg>
      </div>
      <div>
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        <div class="stat-note">${note}</div>
      </div>
    </div>`;
}

export async function render() {
  const s = summary();
  const latestRuns = runs().slice(0, 6);
  const groupRows = groups();
  const candidates = (s.high_value_candidates || latestRuns).slice(0, 6);
  const riskRows = risks().slice(0, 5);
  const coverage = Number(s.mother_coverage_rate || 0);
  return `
    <section class="page active">
      <div class="page-head">
        <div>
          <h1 class="page-title">研究总览</h1>
          <div class="page-subtitle">围绕群类别、母结构、扰动、降群路径、run、证据完整度和下一步补证组织结果。</div>
        </div>
        <button class="btn secondary" id="overview-refresh" type="button">后台刷新索引</button>
      </div>

      <div class="stat-grid">
        ${stat("有效 run", fmtNumber(s.valid_run_count), "可用于浏览和诊断的 run 数")}
        ${stat("异常 run", fmtNumber(s.bad_run_count), "含严重质量旗标或扫描异常", "red")}
        ${stat("已诊断谱线", fmtNumber(s.spectra_count), "T/R/A 或指标文件计数", "blue")}
        ${stat("缺失证据", fmtNumber(s.missing_evidence_count), "缺 R/A/Field/Phase/Poynting 等", "orange")}
        <div class="card stat-card">
          <canvas id="coverage-donut" width="68" height="68" style="width:68px;height:68px"></canvas>
          <div>
            <div class="stat-label">母结构覆盖率</div>
            <div class="stat-value" style="font-size:22px;color:var(--color-primary)">${pct(coverage, 0)}</div>
            <div class="stat-note">覆盖母结构 / 已识别母结构</div>
          </div>
        </div>
      </div>

      <div class="overview-grid">
        <div class="card pad coverage-card">
          <div class="card-title">群分类覆盖 <span class="muted">按缓存统计</span></div>
          ${groupRows.length ? groupRows.map((g) => `
            <div class="progress-row">
              <div class="progress-label">${escapeHtml(g.group || g.name)}</div>
              <div class="progress-track"><div class="progress-bar" style="width:${Math.max(3, Math.min(100, Number(g.coverage_rate || 0) * 100))}%"></div></div>
              <div class="progress-value">${fmtNumber(g.run_count || 0)}</div>
            </div>`).join("") : `<div class="empty">暂无群分类缓存。点击后台刷新后会补齐。</div>`}
        </div>

        <div class="card pad candidate-card">
          <div class="card-title">高价值候选 <button class="link" data-go="diagnosis" type="button">进入光谱诊断</button></div>
          <table class="table">
            <thead><tr><th>结构 / 扰动</th><th>降群路径</th><th>score</th><th>λ0 (nm)</th><th>Q</th></tr></thead>
            <tbody>
              ${candidates.length ? candidates.map((r) => `
                <tr data-go="diagnosis">
                  <td><strong>${escapeHtml(r.mother_structure || r.group || "未识别")}</strong><br><span class="muted">${escapeHtml(r.perturbation || r.run_name || "")}</span></td>
                  <td>${escapeHtml(r.reduction_path || "待识别")}</td>
                  <td>${fmtNumber(r.score, 2, "待算")}</td>
                  <td>${fmtNumber(r.lambda0_nm, 2, "待算")}</td>
                  <td>${fmtNumber(r.q, 2, "待算")}</td>
                </tr>`).join("") : `<tr><td colspan="5"><div class="empty">暂无候选排序。后台刷新会优先从 spectral_metrics.csv 建立候选。</div></td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="card pad advice-card">
          <div class="card-title">下一步建议 <button class="link" data-go="supplement" type="button">补做实验</button></div>
          <div class="advice-list">
            <button class="advice-item hot" data-go="supplement" type="button"><span class="dot red"></span><span><strong>补齐缺失证据</strong><br><span class="muted">${fmtNumber(s.missing_evidence_count)} 个证据缺口需要建立任务包</span></span><span class="tag red">优先</span></button>
            <button class="advice-item warn" data-go="quality" type="button"><span class="dot orange"></span><span><strong>复核 T &gt; 1 与 FWHM</strong><br><span class="muted">质量旗标会影响 score 与 Q 判断</span></span><span class="tag orange">审计</span></button>
            <button class="advice-item ok" data-go="topology" type="button"><span class="dot green"></span><span><strong>只筛选候选，不写成证明</strong><br><span class="muted">拓扑候选需 k-space、相位连续性和缠绕数补证</span></span><span class="tag green">候选</span></button>
          </div>
        </div>

        <div class="card pad recent-card">
          <div class="card-title">最近活跃 run <button class="link" data-go="results" type="button">查看结果浏览</button></div>
          <table class="table">
            <thead><tr><th>run</th><th>群类别</th><th>母结构</th><th>扰动</th><th>谱线</th><th>风险</th><th>操作</th></tr></thead>
            <tbody>
              ${latestRuns.length ? latestRuns.map((r) => `
                <tr>
                  <td>${escapeHtml(r.run_name || r.run_id)}</td>
                  <td>${escapeHtml(r.group || "未识别")}</td>
                  <td>${escapeHtml(r.mother_structure || "")}</td>
                  <td>${escapeHtml(r.perturbation || "")}</td>
                  <td>${fmtNumber(r.spectra_count || 0)}</td>
                  <td><span class="tag ${r.risk_level === "high" ? "red" : r.risk_level === "medium" ? "orange" : "green"}">${escapeHtml(r.risk_label || "低")}</span></td>
                  <td><button class="link" data-run-id="${escapeHtml(r.run_id)}" data-action="inspect-run" type="button">诊断</button></td>
                </tr>`).join("") : `<tr><td colspan="7"><div class="empty">暂无 run 缓存。首屏不会扫描目录，请点击后台刷新。</div></td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="card pad risk-card">
          <div class="card-title">风险提醒 <button class="link" data-go="quality" type="button">质量审计</button></div>
          <div class="risk-list">
            ${riskRows.length ? riskRows.map((risk) => `
              <div class="risk-item"><span class="dot ${risk.level === "high" ? "red" : "orange"}"></span><span><strong>${escapeHtml(risk.title)}</strong><br><span class="muted">${escapeHtml(risk.detail || "")}</span></span><span class="muted">${escapeHtml(risk.when || "")}</span></div>
            `).join("") : `<div class="empty">暂无风险缓存。质量旗标会在后台刷新后生成。</div>`}
          </div>
        </div>
      </div>
    </section>`;
}

export async function afterRender(root) {
  drawDonut(root.querySelector("#coverage-donut"), Number(summary().mother_coverage_rate || 0));
  root.querySelector("#overview-refresh")?.addEventListener("click", async () => {
    try {
      await api.refreshIndex();
      toast("后台刷新已启动，当前页继续使用已有缓存。", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  root.querySelectorAll("[data-action='inspect-run']").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.sessionStorage.setItem("fdtd:selectedRunId", btn.dataset.runId);
      window.location.hash = "diagnosis";
    });
  });
}
