import { api } from "../api.js";
import { escapeHtml, fmtNumber } from "../state.js";
import { openModal, toast } from "../ui.js";

let missingRows = [];
let selectedKeys = new Set();

export async function render() {
  return `
    <section class="page active">
      <div class="page-head">
        <div><h1 class="page-title">补做实验</h1><div class="page-subtitle">为内存受限的单 monitor 仿真生成补证任务包，关联原 run，但不覆盖原 run。</div></div>
        <button class="btn secondary" id="load-missing" type="button">读取缺失证据</button>
      </div>
      <div class="layout-3">
        <div class="card pad">
          <div class="card-title">证据类型</div>
          <div class="field"><label>缺失证据类型</label><select class="select" id="supplement-type"><option value="R">R</option><option value="A">A</option><option value="field">Field</option><option value="phase">Phase</option><option value="poynting">Poynting</option><option value="angle-resolved">angle-resolved</option><option value="band sweep">band sweep</option></select></div>
          <div class="field" style="margin-top:12px"><label>波长点策略</label><select class="select" id="lambda-policy"><option value="peak_triplet">λ0 ± 半线宽三点</option><option value="peak_only">只补 λ0</option><option value="manual">手动输入</option></select></div>
          <div class="field" style="margin-top:12px"><label>手动波长 nm</label><input class="input" id="manual-lambdas" placeholder="例如 1286.34,1285.65,1287.03"></div>
          <div class="field" style="margin-top:12px"><label>monitor 策略</label><select class="select" id="monitor-policy"><option value="single_monitor_only">single_monitor_only</option><option value="separate_runs">separate_runs</option><option value="reuse_existing_fsp">reuse_existing_fsp</option></select></div>
          <div class="notice" style="margin-top:14px">任务包会生成到 results\\扰动名\\补做实验\\patch_YYYYMMDD_HHMMSS_type，不覆盖原 run。</div>
        </div>
        <div class="card pad">
          <div class="card-title">待补做样本 <span id="missing-count" class="muted">未载入</span></div>
          <div id="missing-list" class="empty">点击读取缺失证据。</div>
        </div>
        <div class="card pad">
          <div class="card-title">生成任务包</div>
          <table class="table"><tbody>
            <tr><td>已选样本</td><td id="selected-count">0</td></tr>
            <tr><td>source run</td><td>从样本自动关联</td></tr>
            <tr><td>输出目录</td><td>补做实验\\patch_时间戳_type</td></tr>
            <tr><td>状态</td><td>planned</td></tr>
          </tbody></table>
          <button class="btn primary" id="create-package" type="button" style="margin-top:14px;width:100%">生成补做任务包</button>
          <div class="card-title" style="margin-top:18px">已有任务包</div>
          <div id="package-list" class="resource-list"></div>
        </div>
      </div>
    </section>`;
}

function renderMissing(root) {
  root.querySelector("#missing-count").textContent = `${fmtNumber(missingRows.length)} 个缺口`;
  root.querySelector("#missing-list").innerHTML = missingRows.length ? `
    <table class="table"><thead><tr><th>选择</th><th>run</th><th>sample</th><th>delta</th><th>缺失证据</th><th>λ0</th></tr></thead><tbody>
      ${missingRows.slice(0, 180).map((row, idx) => {
        const key = `${row.run_id}:${row.sample_id || idx}`;
        return `<tr><td><input type="checkbox" data-missing-key="${escapeHtml(key)}" ${selectedKeys.has(key) ? "checked" : ""}></td><td>${escapeHtml(row.run_name || row.run_id)}</td><td>${escapeHtml(row.sample_id || "")}</td><td>${escapeHtml(row.delta ?? "")}</td><td>${escapeHtml((row.missing_evidence || []).join(", "))}</td><td>${escapeHtml(row.lambda0_nm ?? "")}</td></tr>`;
      }).join("")}
    </tbody></table>` : `<div class="empty">未发现缺失证据。后台刷新后可重新读取。</div>`;
  root.querySelector("#selected-count").textContent = fmtNumber(selectedKeys.size);
}

async function loadPackages(root) {
  try {
    const data = await api.supplementPackages();
    root.querySelector("#package-list").innerHTML = (data.packages || []).length ? (data.packages || []).slice(0, 12).map((p) => `
      <div class="resource-row"><strong>${escapeHtml(p.package_id)}</strong><span>${escapeHtml(p.supplement_type || "")}</span><span>${escapeHtml(p.status || "")}</span></div>`).join("") : `<div class="empty">暂无补做任务包。</div>`;
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function afterRender(root) {
  root.querySelector("#load-missing").addEventListener("click", async () => {
    try {
      const data = await api.supplementMissing();
      missingRows = data.items || [];
      renderMissing(root);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  root.addEventListener("change", (event) => {
    const box = event.target.closest("[data-missing-key]");
    if (!box) return;
    if (box.checked) selectedKeys.add(box.dataset.missingKey);
    else selectedKeys.delete(box.dataset.missingKey);
    root.querySelector("#selected-count").textContent = fmtNumber(selectedKeys.size);
  });
  root.querySelector("#create-package").addEventListener("click", () => {
    const selected = missingRows.filter((row, idx) => selectedKeys.has(`${row.run_id}:${row.sample_id || idx}`));
    if (!selected.length) {
      toast("请先选择至少一个待补做样本。", "error");
      return;
    }
    const payload = {
      supplement_type: root.querySelector("#supplement-type").value,
      lambda_policy: root.querySelector("#lambda-policy").value,
      manual_lambdas_nm: root.querySelector("#manual-lambdas").value,
      monitor_policy: root.querySelector("#monitor-policy").value,
      samples: selected,
    };
    openModal({
      title: "生成补做任务包",
      confirmText: "确认生成",
      body: `<p>将创建 patch_request.json、source_links.json 与 00_patch_plan\\patch_points.csv。</p><pre class="mono">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`,
      onConfirm: async () => {
        try {
          const data = await api.createSupplementPackage(payload);
          toast(`任务包已生成：${data.package_id}`, "success");
          selectedKeys = new Set();
          renderMissing(root);
          loadPackages(root);
        } catch (error) {
          toast(error.message, "error");
        }
      },
    });
  });
  await loadPackages(root);
}
