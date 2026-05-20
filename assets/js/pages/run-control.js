import { api } from "../api.js";
import { escapeHtml, filteredScripts, fmtNumber, groupBy } from "../state.js";
import { openModal, toast } from "../ui.js";

let selectedIds = new Set();
let latestPreview = null;
let currentJobId = "";

function scriptTree(scripts) {
  const byGroup = groupBy(scripts, "group");
  const statusLabel = (status) => ({
    has_full: "已有 full",
    has_test: "已有 test",
    missing_result: "缺结果",
    failed: "异常",
    unknown: "未知",
  }[status] || status || "未知");
  const statusTone = (status) => ({
    has_full: "green",
    has_test: "blue",
    missing_result: "orange",
    failed: "red",
  }[status] || "orange");
  return Object.entries(byGroup).map(([group, rows]) => `
    <div class="tree-group">
      <div class="tree-group-title">${escapeHtml(group)} <span class="tag blue">${rows.length}</span></div>
      ${rows.map((s) => `
        <button class="tree-row ${selectedIds.has(String(s.id || s.script_id)) ? "active" : ""}" data-script-id="${escapeHtml(s.id || s.script_id)}" type="button">
          <span class="dot ${statusTone(s.status) === "red" ? "red" : statusTone(s.status) === "green" ? "green" : "orange"}"></span>
          <span>${escapeHtml(s.mother_structure || "")} / ${escapeHtml(s.perturbation || s.relative_path)}</span>
          <span class="tag ${statusTone(s.status)}">${escapeHtml(statusLabel(s.status))}</span>
        </button>`).join("")}
    </div>`).join("");
}

export async function render(state) {
  const scripts = filteredScripts();
  const selectedCount = selectedIds.size;
  return `
    <section class="page active">
      <div class="page-head">
        <div>
          <h1 class="page-title">运行控制</h1>
          <div class="page-subtitle">只在用户二次确认后通过 subprocess 调用 fdtd_master_controller.py；overrides 写入临时 JSON，不改原脚本。</div>
        </div>
        <button class="btn secondary" id="refresh-scripts" type="button">刷新脚本缓存</button>
      </div>

      <div class="layout-3">
        <div class="card pad">
          <div class="card-title">结构与脚本树 <span class="muted">${fmtNumber(scripts.length)} 个脚本</span></div>
          <div class="script-tree">${scripts.length ? scriptTree(scripts) : `<div class="empty">暂无脚本缓存。点击刷新脚本缓存或后台刷新索引。</div>`}</div>
        </div>

        <div class="card pad">
          <div class="card-title">运行参数 <span class="muted">已选择 ${selectedCount} 个脚本</span></div>
          <div class="field">
            <label>运行模式</label>
            <div class="segmented" id="mode-control">
              <button class="active" data-value="preview" type="button">preview</button>
              <button data-value="test" type="button">test</button>
              <button data-value="full" type="button">full</button>
            </div>
          </div>
          <div class="field" style="margin-top:12px">
            <label>执行策略</label>
            <div class="segmented" id="style-control">
              <button class="active" data-value="sequential" type="button">sequential</button>
              <button data-value="parallel" type="button">parallel</button>
            </div>
          </div>
          <div class="form-grid" style="margin-top:12px">
            <div class="field unit-field"><label>并发数</label><input class="input" id="max-parallel" type="number" min="1" max="16" value="2"><span class="unit">个</span></div>
            <div class="field unit-field"><label>start</label><input class="input" id="start-value" type="number" value=""><span class="unit">nm</span></div>
            <div class="field unit-field"><label>end</label><input class="input" id="end-value" type="number" value=""><span class="unit">nm</span></div>
            <div class="field unit-field"><label>step</label><input class="input" id="step-value" type="number" value=""><span class="unit">nm</span></div>
            <div class="field unit-field"><label>mesh accuracy</label><input class="input" id="mesh-accuracy" type="number" min="1" max="8" value=""><span class="unit">级</span></div>
            <div class="field unit-field"><label>dt 稳定性阈值</label><input class="input" id="dt-factor" type="number" step="0.01" value=""><span class="unit">CFL</span></div>
          </div>
          <div class="form-grid" style="margin-top:12px">
            <div class="field unit-field"><label>runtime</label><input class="input" id="runtime-fs" type="number" value=""><span class="unit">fs</span></div>
            <div class="field unit-field"><label>auto shutoff</label><input class="input" id="auto-shutoff" type="number" step="0.0001" value=""><span class="unit">min</span></div>
            <div class="field unit-field"><label>子任务超时</label><input class="input" id="child-timeout" type="number" value="3600"><span class="unit">s</span></div>
          </div>
          <div class="notice" style="margin-top:14px">full + parallel 会触发高风险二次确认；页面加载时绝不运行脚本。</div>
        </div>

        <div>
          <div class="card pad">
            <div class="card-title">启动摘要</div>
            <table class="table"><tbody>
              <tr><td>扫描点数估算</td><td id="point-estimate">待预览</td></tr>
              <tr><td>预计时长估算</td><td id="duration-estimate">待预览</td></tr>
              <tr><td>总控参数</td><td>--mode / --style / --ids / --overrides-json / --yes</td></tr>
              <tr><td>安全状态</td><td>未启动</td></tr>
            </tbody></table>
            <div style="display:flex;gap:10px;margin-top:14px">
              <button class="btn secondary" id="preview-run" type="button">生成预览</button>
              <button class="btn primary" id="start-run" type="button">启动</button>
            </div>
          </div>
          <div class="terminal-head" style="margin-top:12px"><span>实时日志</span><button class="link" id="stop-job" type="button">停止任务</button></div>
          <pre class="terminal" id="job-log">尚未启动任务。</pre>
        </div>
      </div>

      <div class="bottom-actions">
        <span class="muted">底部操作栏：所有启动操作都需要确认；停止任务会结束子进程树。</span>
        <div class="toolbar"><button class="btn ghost" id="clear-selected" type="button">清空选择</button><button class="btn primary" id="bottom-start" type="button">确认启动</button></div>
      </div>
    </section>`;
}

function activeValue(root, id) {
  return root.querySelector(`#${id} .active`)?.dataset.value;
}

function collectPayload(root) {
  const overrides = {};
  const wildcard = {};
  const map = [
    ["start-value", "START_NM"],
    ["end-value", "END_NM"],
    ["step-value", "STEP_NM"],
    ["mesh-accuracy", "MESH_ACCURACY"],
    ["dt-factor", "DT_STABILITY_FACTOR"],
    ["runtime-fs", "SIMULATION_TIME_FS"],
    ["auto-shutoff", "AUTO_SHUTOFF_MIN"],
  ];
  map.forEach(([id, key]) => {
    const raw = root.querySelector(`#${id}`)?.value;
    if (raw !== "") wildcard[key] = Number(raw);
  });
  if (Object.keys(wildcard).length) overrides["*"] = wildcard;
  return {
    mode: activeValue(root, "mode-control") || "preview",
    style: activeValue(root, "style-control") || "sequential",
    max_parallel: Number(root.querySelector("#max-parallel").value || 2),
    ids: Array.from(selectedIds),
    overrides,
    child_timeout_s: Number(root.querySelector("#child-timeout").value || 3600),
  };
}

async function refreshLog(root) {
  if (!currentJobId) return;
  try {
    const log = await api.jobLog(currentJobId);
    root.querySelector("#job-log").textContent = log.text || "暂无日志。";
    const job = await api.job(currentJobId);
    if (job.status === "running") window.setTimeout(() => refreshLog(root), 1400);
  } catch (error) {
    root.querySelector("#job-log").textContent = error.message;
  }
}

export async function afterRender(root) {
  root.querySelectorAll(".tree-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = String(row.dataset.scriptId);
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      row.classList.toggle("active");
    });
  });
  root.querySelectorAll(".segmented").forEach((seg) => {
    seg.addEventListener("click", (event) => {
      const btn = event.target.closest("button");
      if (!btn) return;
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  root.querySelector("#refresh-scripts").addEventListener("click", async () => {
    try {
      await api.refreshScripts();
      toast("脚本缓存刷新完成。", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  root.querySelector("#preview-run").addEventListener("click", async () => {
    try {
      latestPreview = await api.controllerPreview(collectPayload(root));
      root.querySelector("#point-estimate").textContent = latestPreview.estimated_points || "待估算";
      root.querySelector("#duration-estimate").textContent = latestPreview.estimated_duration || "待估算";
      root.querySelector("#job-log").textContent = (latestPreview.command || []).join(" ");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  async function start() {
    const payload = collectPayload(root);
    if (!payload.ids.length) {
      toast("请先选择至少一个脚本。", "error");
      return;
    }
    const highRisk = payload.mode === "full" && payload.style === "parallel";
    openModal({
      title: highRisk ? "高风险启动确认" : "启动确认",
      danger: highRisk,
      confirmText: highRisk ? "确认 full 并行启动" : "确认启动",
      body: `<p>${highRisk ? "full + parallel 很占内存，请确认当前机器资源允许。" : "将通过 fdtd_master_controller.py 启动任务。"}</p><pre class="mono">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`,
      onConfirm: async () => {
        try {
          const job = await api.controllerStart({ ...payload, confirm: true, risk_ack: highRisk });
          currentJobId = job.job_id;
          root.querySelector("#job-log").textContent = `任务已启动：${job.job_id}\n${(job.command || []).join(" ")}`;
          refreshLog(root);
        } catch (error) {
          toast(error.message, "error");
        }
      },
    });
  }
  root.querySelector("#start-run").addEventListener("click", start);
  root.querySelector("#bottom-start").addEventListener("click", start);
  root.querySelector("#clear-selected").addEventListener("click", () => {
    selectedIds = new Set();
    root.querySelectorAll(".tree-row.active").forEach((row) => row.classList.remove("active"));
  });
  root.querySelector("#stop-job").addEventListener("click", async () => {
    if (!currentJobId) return toast("当前没有任务可停止。", "error");
    try {
      await api.stopJob(currentJobId);
      toast("已发送停止任务请求。", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}
