self.onmessage = (event) => {
  const { q, items } = event.data || {};
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) {
    self.postMessage({ items });
    return;
  }
  const matched = (items || []).filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  self.postMessage({ items: matched });
};
