import { api } from "../api.js";
import { escapeHtml, fmtNumber, risks, summary } from "../state.js";
import { toast } from "../ui.js";

export async function render() {
  const s = summary();
  const riskRows = risks();
  return `
    <section class="page active">
      <div class="page-head">
        <div><h1 class="page-title">质量审计</h1><div class="page-subtitle">汇总严重问题、警告、缺失证据、通过样本、待复跑数量，并提供结果整理 dry-run。</div></div>
        <button class="btn secondary" id="manager-dry-run" type="button">结果整理 dry-run</button>
      </div>
      <div class="stat-grid">
        <div class="card stat-card"><div class="stat-icon red"></div><div><div class="stat-label">严重问题数量</div><div class="stat-value">${fmtNumber(s.severe_issue_count || 0)}</div><div class="stat-note">T&gt;1、FWHM 失真、崩溃等</div></div></div>
        <div class="card stat-card"><div class="stat-icon orange"></div><div><div class="stat-label">警告数量</div><div class="stat-value">${fmtNumber(s.warning_count || 0)}</div><div class="stat-note">采样不足、靠边界等</div></div></div>
        <div class="card stat-card"><div class="stat-icon orange"></div><div><div class="stat-label">缺失证据数量</div><div class="stat-value">${fmtNumber(s.missing_evidence_count || 0)}</div><div class="stat-note">R/A/Field/Phase/Poynting</div></div></div>
        <div class="card stat-card"><div class="stat-icon"></div><div><div class="stat-label">通过样本数量</div><div class="stat-value">${fmtNumber(s.pass_sample_count || 0)}</div><div class="stat-note">无严重旗标</div></div></div>
        <div class="card stat-card"><div class="stat-icon blue"></div><div><div class="stat-label">待复跑数量</div><div class="stat-value">${fmtNumber(s.rerun_count || 0)}</div><div class="stat-note">建议 preview/test 复核</div></div></div>
      </div>
      <div class="layout-2">
        <div class="card pad">
          <div class="card-title">异常列表</div>
          ${riskRows.length ? `<table class="table"><thead><tr><th>级别</th><th>对象</th><th>详情</th><th>建议</th></tr></thead><tbody>
            ${riskRows.map((r) => `<tr><td><span class="tag ${r.level === "high" ? "red" : "orange"}">${escapeHtml(r.level || "")}</span></td><td>${escapeHtml(r.title || "")}</td><td>${escapeHtml(r.detail || "")}</td><td>${escapeHtml(r.suggestion || "复核谱线并补证")}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty">暂无异常缓存。后台刷新会重新计算质量旗标。</div>`}
        </div>
        <div class="card pad">
          <div class="card-title">复跑建议</div>
          <div class="advice-list">
            <div class="advice-item warn"><span class="dot orange"></span><span><strong>默认 dry-run</strong><br><span class="muted">结果整理不会删除原始数据；真正移动旧 run 需二次确认。</span></span><span class="tag orange">安全</span></div>
            <div class="advice-item warn"><span class="dot orange"></span><span><strong>不得移动 coding 源脚本</strong><br><span class="muted">fdtd_results_manager.py 只面向 results/run_*。</span></span><span class="tag orange">边界</span></div>
          </div>
          <div class="terminal-head" style="margin-top:14px"><span>dry-run 输出</span></div>
          <pre class="terminal" id="dry-run-log">未执行。</pre>
        </div>
      </div>
    </section>`;
}

export async function afterRender(root) {
  root.querySelector("#manager-dry-run").addEventListener("click", async () => {
    try {
      const data = await api.resultManagerDryRun();
      root.querySelector("#dry-run-log").textContent = data.text || "dry-run 已完成，无输出。";
    } catch (error) {
      toast(error.message, "error");
    }
  });
}
