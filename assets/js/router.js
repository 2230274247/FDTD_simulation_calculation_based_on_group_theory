import { state, updateState } from "./state.js";
import { closeDrawer } from "./ui.js";
import * as overview from "./pages/overview.js";
import * as runControl from "./pages/run-control.js";
import * as resultBrowser from "./pages/result-browser.js";
import * as diagnostics from "./pages/spectral-diagnostics.js";
import * as modeRelay from "./pages/mode-relay.js";
import * as qualityAudit from "./pages/quality-audit.js";
import * as supplement from "./pages/supplement.js";
import * as resources from "./pages/resources.js";

const routes = {
  overview: { title: "研究总览", module: overview },
  run: { title: "运行控制", module: runControl },
  results: { title: "结果浏览", module: resultBrowser },
  diagnosis: { title: "光谱诊断", module: diagnostics },
  topology: { title: "模式接力 / 拓扑候选", module: modeRelay },
  quality: { title: "质量审计", module: qualityAudit },
  supplement: { title: "补做实验", module: supplement },
  resources: { title: "资源浏览", module: resources },
};

function routeFromHash() {
  const raw = window.location.hash.replace(/^#/, "");
  return routes[raw] ? raw : "overview";
}

export async function renderRoute() {
  const route = routeFromHash();
  closeDrawer();
  updateState({ route });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === route);
  });
  document.getElementById("crumb-title").textContent = routes[route].title;
  const root = document.getElementById("page-root");
  const mod = routes[route].module;
  root.innerHTML = await mod.render(state);
  if (typeof mod.afterRender === "function") {
    await mod.afterRender(root, state);
  }
}

export function navigate(route) {
  if (!routes[route]) return;
  if (window.location.hash === `#${route}`) {
    renderRoute();
  } else {
    window.location.hash = route;
  }
}

export function initRouter() {
  document.getElementById("nav").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-route]");
    if (btn) navigate(btn.dataset.route);
  });
  document.body.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-go]");
    if (btn) navigate(btn.dataset.go);
  });
  window.addEventListener("hashchange", renderRoute);
  if (!window.location.hash) window.location.hash = "overview";
  renderRoute();
}
