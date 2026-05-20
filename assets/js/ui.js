import { escapeHtml } from "./state.js";

export function toast(message, type = "info", timeout = 3600) {
  const host = document.getElementById("toast-host");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = escapeHtml(message);
  host.appendChild(node);
  window.setTimeout(() => node.remove(), timeout);
}

export function openDrawer(title, html) {
  document.getElementById("drawer-title").textContent = title;
  document.getElementById("drawer-body").innerHTML = html;
  document.getElementById("drawer-mask").hidden = false;
  document.getElementById("drawer").hidden = false;
}

export function closeDrawer() {
  const mask = document.getElementById("drawer-mask");
  const drawer = document.getElementById("drawer");
  if (mask) mask.hidden = true;
  if (drawer) drawer.hidden = true;
}

export function openModal({ title, body, confirmText = "确认", danger = false, onConfirm }) {
  const root = document.getElementById("modal-root");
  root.hidden = false;
  root.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head"><strong>${escapeHtml(title)}</strong><button class="icon-btn" data-modal-close type="button" aria-label="关闭">×</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button class="btn ghost" data-modal-close type="button">取消</button>
        <button class="btn ${danger ? "danger" : "primary"}" data-modal-confirm type="button">${escapeHtml(confirmText)}</button>
      </div>
    </section>`;
  root.querySelectorAll("[data-modal-close]").forEach((btn) => btn.addEventListener("click", closeModal));
  root.querySelector("[data-modal-confirm]").addEventListener("click", async () => {
    if (onConfirm) await onConfirm();
    closeModal();
  });
}

export function closeModal() {
  const root = document.getElementById("modal-root");
  root.hidden = true;
  root.innerHTML = "";
}

export function initUiChrome() {
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer-mask").addEventListener("click", closeDrawer);
  document.getElementById("modal-root").addEventListener("click", (event) => {
    if (event.target.id === "modal-root") closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
      closeModal();
    }
  });
}
