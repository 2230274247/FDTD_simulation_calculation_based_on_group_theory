import { api } from "../api.js";
import { escapeHtml, fmtNumber } from "../state.js";
import { toast } from "../ui.js";

let kindFilter = "";
let cachedFiles = [];

export async function render() {
  const all = cachedFiles;
  const list = kindFilter ? all.filter((f) => f.kind === kindFilter || f.extension === kindFilter) : all;
  return `
    <section class="page active">
      <div class="page-head">
        <div><h1 class="page-title">资源浏览</h1><div class="page-subtitle">浏览 FSP、脚本、CSV/JSON/MD、PNG/JPG、XLSX 等缓存资源；搜索不触发全盘扫描。</div></div>
        <select class="select" id="resource-kind" style="max-width:210px">
          <option value="">全部类型</option>
          <option value="fsp">fsp</option><option value="py">py</option><option value="xlsx">xlsx</option><option value="csv">csv</option><option value="json">json</option><option value="md">md</option><option value="image">image</option>
        </select>
      </div>
      <div class="layout-2">
        <div class="card pad">
          <div class="card-title">资源列表 <span class="muted">${fmtNumber(list.length)} 个</span></div>
          <div class="resource-list">
            ${list.length ? list.slice(0, 500).map((f) => `
              <button class="resource-row" data-file-path="${escapeHtml(f.relative_path)}" type="button">
                <strong>${escapeHtml(f.relative_path)}</strong><span>${escapeHtml(f.kind || f.extension || "")}</span><span>${fmtNumber(f.size || 0)} bytes</span>
              </button>`).join("") : `<div class="empty">暂无资源缓存。后台刷新后会登记路径。</div>`}
          </div>
        </div>
        <div class="card pad">
          <div class="card-title">预览</div>
          <div id="resource-preview" class="preview-pane">选择资源后显示安全预览。</div>
        </div>
      </div>
    </section>`;
}

async function preview(root, path) {
  try {
    const data = await api.previewFile(path);
    const pane = root.querySelector("#resource-preview");
    if (data.kind === "image") pane.innerHTML = `<img src="${escapeHtml(data.url)}" alt="${escapeHtml(path)}"><p class="muted">${escapeHtml(path)}</p>`;
    else if (data.kind === "fsp") pane.innerHTML = `<table class="table"><tbody><tr><td>路径</td><td>${escapeHtml(data.relative_path)}</td></tr><tr><td>大小</td><td>${fmtNumber(data.size)} bytes</td></tr><tr><td>mtime</td><td>${escapeHtml(data.mtime)}</td></tr><tr><td>说明</td><td>FSP 不读取内容，只登记路径、大小、mtime。</td></tr></tbody></table>`;
    else pane.innerHTML = `<pre>${escapeHtml(data.text || JSON.stringify(data, null, 2))}</pre>`;
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function afterRender(root) {
  if (!cachedFiles.length) {
    try {
      const data = await api.files();
      cachedFiles = data.files || [];
      const page = await render();
      root.innerHTML = page.match(/<section[\s\S]*<\/section>/)?.[0] || page;
      return afterRender(root);
    } catch (error) {
      toast(error.message, "error");
    }
  }
  root.querySelector("#resource-kind").value = kindFilter;
  root.querySelector("#resource-kind").addEventListener("change", (event) => {
    kindFilter = event.target.value;
    window.location.hash = "resources";
  });
  root.addEventListener("click", (event) => {
    const row = event.target.closest("[data-file-path]");
    if (row) preview(root, row.dataset.filePath);
  });
}
