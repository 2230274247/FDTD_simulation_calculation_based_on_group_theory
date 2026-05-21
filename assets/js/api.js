const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
let localToken = "";

function setLocalToken(token) {
  localToken = typeof token === "string" ? token : "";
}

async function request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (localToken && ["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    headers["X-FDTD-Workbench-Token"] = localToken;
  }
  if (options.body) {
    Object.assign(headers, JSON_HEADERS);
  }
  const response = await fetch(path, {
    ...options,
    method,
    headers,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error || data?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export const api = {
  setLocalToken,
  bootstrap: () => request("/api/v2/bootstrap"),
  refreshIndex: (payload = {}) => request("/api/v2/index/refresh", { method: "POST", body: JSON.stringify(payload) }),
  refreshDelta: (payload = {}) => request("/api/v2/index/refresh-delta", { method: "POST", body: JSON.stringify(payload) }),
  indexStatus: () => request("/api/v2/index/status"),
  summary: () => request("/api/v2/summary"),
  runs: (params = {}) => request(`/api/v2/runs?${new URLSearchParams(params).toString()}`),
  run: (runId) => request(`/api/v2/runs/${encodeURIComponent(runId)}`),
  runFiles: (runId) => request(`/api/v2/runs/${encodeURIComponent(runId)}/files`),
  runSamples: (runId) => request(`/api/v2/runs/${encodeURIComponent(runId)}/samples`),
  previewFile: (path) => request(`/api/v2/files/preview?path=${encodeURIComponent(path)}`),
  openFile: (path) => request("/api/v2/files/open", { method: "POST", body: JSON.stringify({ path }) }),
  openFolder: (path) => request("/api/v2/files/open-folder", { method: "POST", body: JSON.stringify({ path }) }),
  files: (params = {}) => request(`/api/v2/files?${new URLSearchParams(params).toString()}`),
  resources: (params = {}) => request(`/api/v2/resources?${new URLSearchParams(params).toString()}`),
  scripts: (params = {}) => request(`/api/v2/scripts?${new URLSearchParams(params).toString()}`),
  refreshScripts: () => request("/api/v2/scripts/refresh", { method: "POST", body: "{}" }),
  structureTree: (scope = "current") => request(`/api/v2/structure-tree?scope=${encodeURIComponent(scope || "current")}`),
  controllerPreview: (payload) => request("/api/v2/controller/preview", { method: "POST", body: JSON.stringify(payload) }),
  controllerStart: (payload) => request("/api/v2/controller/start", { method: "POST", body: JSON.stringify(payload) }),
  peakCalc: (payload) => request("/api/v2/diagnostics/peak-calc", { method: "POST", body: JSON.stringify(payload) }),
  jobs: () => request("/api/v2/jobs"),
  job: (jobId) => request(`/api/v2/jobs/${encodeURIComponent(jobId)}`),
  jobLog: (jobId, params = {}) => {
    const query = new URLSearchParams(params || {}).toString();
    return request(`/api/v2/jobs/${encodeURIComponent(jobId)}/log${query ? `?${query}` : ""}`);
  },
  stopJob: (jobId) => request(`/api/v2/jobs/${encodeURIComponent(jobId)}/stop`, { method: "POST", body: "{}" }),
  diagnosticsRun: (runId) => request(`/api/v2/diagnostics/run/${encodeURIComponent(runId)}`),
  diagnosticsSpectrum: (runId, sampleId = "", kind = "T") => request(`/api/v2/diagnostics/spectrum?run_id=${encodeURIComponent(runId)}&sample_id=${encodeURIComponent(sampleId)}&kind=${encodeURIComponent(kind)}`),
  savePeakSelection: (payload) => request("/api/v2/diagnostics/peak-selection", { method: "POST", body: JSON.stringify(payload) }),
  diagnosticsTrend: (runId) => request(`/api/v2/diagnostics/trend?run_id=${encodeURIComponent(runId)}`),
  diagnosticsQuality: (runId) => request(`/api/v2/diagnostics/quality?run_id=${encodeURIComponent(runId)}`),
  modeRelay: (runId = "") => request(`/api/v2/mode-relay?run_id=${encodeURIComponent(runId)}`),
  modeRelayHeatmap: (runId = "") => request(`/api/v2/mode-relay/heatmap?run_id=${encodeURIComponent(runId)}`),
  modeRelayCandidates: (group = "C6") => request(`/api/v2/mode-relay/candidates?group=${encodeURIComponent(group)}`),
  supplementMissing: () => request("/api/v2/supplement/missing"),
  createSupplementPackage: (payload) => request("/api/v2/supplement/create-package", { method: "POST", body: JSON.stringify(payload) }),
  deleteSupplementPackage: (packageId, payload = {}) => request(`/api/v2/supplement/packages/${encodeURIComponent(packageId)}/delete`, { method: "POST", body: JSON.stringify(payload) }),
  supplementPackages: () => request("/api/v2/supplement/packages"),
  supplementPackage: (packageId) => request(`/api/v2/supplement/packages/${encodeURIComponent(packageId)}`),
  resultManagerDryRun: () => request("/api/v2/results-manager/dry-run", { method: "POST", body: "{}" }),
  preloadStart: (payload = {}) => request("/api/v2/preload/start", { method: "POST", body: JSON.stringify(payload) }),
  preloadStatus: () => request("/api/v2/preload/status"),
  preloadNext: (kind, limit = 10) => request(`/api/v2/preload/next?kind=${encodeURIComponent(kind)}&limit=${encodeURIComponent(limit)}`),
  cacheChunk: (name, params = {}) => request(`/api/v2/cache/chunk?${new URLSearchParams({ name, ...params }).toString()}`),
  cacheChanges: (since = "") => request(`/api/v2/cache/changes?since=${encodeURIComponent(since)}`),
};
