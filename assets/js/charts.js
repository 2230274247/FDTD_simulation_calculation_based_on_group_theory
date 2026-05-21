const palette = {
  primary: "#0B7B6B",
  primary2: "#00746F",
  blue: "#2563EB",
  orange: "#D97706",
  red: "#D92D20",
  grid: "#E4ECEA",
  text: "#4B5563",
  muted: "#6B7280",
};

function prep(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function range(values, fallback = [0, 1]) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return fallback;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return [min, max];
}

function drawAxes(ctx, box, xLabel, yLabel) {
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(box.x, box.y);
  ctx.lineTo(box.x, box.y + box.h);
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.stroke();
  ctx.fillStyle = palette.text;
  ctx.font = "12px Microsoft YaHei, system-ui";
  ctx.textAlign = "right";
  ctx.fillText(xLabel, box.x + box.w, box.y + box.h + 34);
  ctx.save();
  ctx.translate(16, box.y + Math.min(92, box.h - 12));
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "left";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
  ctx.textAlign = "left";
}

function normalizeSeries(series) {
  return (series || [])
    .map((item) => {
      if (Array.isArray(item)) {
        return { x: Number(item[0]), y: Number(item[1]) };
      }
      return { x: Number(item?.x), y: Number(item?.y) };
    })
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .sort((a, b) => a.x - b.x);
}

function normalizeMarkerSet(markers) {
  const markerSet = markers || {};
  return {
    vertical: Array.isArray(markerSet.vertical)
      ? markerSet.vertical
          .filter((m) => Number.isFinite(Number(m?.x)))
          .map((m) => ({
            x: Number(m.x),
            label: String(m.label || ""),
            color: m.color || palette.orange,
            dashed: Array.isArray(m.dashed) ? m.dashed : (m.dashed ? [5, 5] : []),
            lineWidth: Number.isFinite(Number(m.lineWidth)) ? Number(m.lineWidth) : 1.5,
          }))
      : [],
    horizontal: Array.isArray(markerSet.horizontal)
      ? markerSet.horizontal
          .filter((m) => Number.isFinite(Number(m?.y)))
          .map((m) => ({
            y: Number(m.y),
            label: String(m.label || ""),
            color: m.color || palette.blue,
            dashed: Array.isArray(m.dashed) ? m.dashed : (m.dashed ? [5, 5] : []),
            lineWidth: Number.isFinite(Number(m.lineWidth)) ? Number(m.lineWidth) : 1.5,
          }))
      : [],
    selection:
      markerSet.selection && Number.isFinite(Number(markerSet.selection.min)) && Number.isFinite(Number(markerSet.selection.max))
        ? {
            min: Number(markerSet.selection.min),
            max: Number(markerSet.selection.max),
            color: markerSet.selection.color || "rgba(37, 99, 235, 0.16)",
            border: markerSet.selection.border || "rgba(37, 99, 235, 0.55)",
          }
        : null,
  };
}

export function drawLine(canvas, series, options = {}) {
  const state = {
    canvas,
    options,
    data: normalizeSeries(series),
    markers: normalizeMarkerSet(options.markers),
    selection:
      options.selection && Number.isFinite(Number(options.selection.min)) && Number.isFinite(Number(options.selection.max))
        ? { min: Number(options.selection.min), max: Number(options.selection.max) }
        : null,
    drag: null,
    destroyed: false,
    box: null,
    xmin: 0,
    xmax: 1,
    ymin: 0,
    ymax: 1,
  };

  function updateRanges() {
    if (!state.data.length) {
      state.xmin = 0;
      state.xmax = 1;
      state.ymin = 0;
      state.ymax = 1;
      return;
    }
    const [xmin, xmax] = range(state.data.map((d) => d.x));
    const [ymin, ymax] = range(state.data.map((d) => d.y));
    state.xmin = xmin;
    state.xmax = xmax;
    state.ymin = ymin;
    state.ymax = ymax;
  }

  function getBox() {
    if (!canvas) return null;
    const p = prep(canvas);
    if (!p) return null;
    const { ctx, width, height } = p;
    return { ctx, width, height, box: { x: 54, y: 22, w: width - 76, h: height - 68 } };
  }

  function dataToPixel(point) {
    const box = state.box;
    if (!box) return { x: 0, y: 0 };
    const x = Number(point?.x);
    const y = Number(point?.y);
    return {
      x: box.x + ((x - state.xmin) / (state.xmax - state.xmin)) * box.w,
      y: box.y + box.h - ((y - state.ymin) / (state.ymax - state.ymin)) * box.h,
    };
  }

  function pixelToData(point) {
    const box = state.box;
    if (!box) return { x: 0, y: 0 };
    const px = Number(point?.x);
    const py = Number(point?.y);
    return {
      x: state.xmin + ((px - box.x) / box.w) * (state.xmax - state.xmin),
      y: state.ymin + ((box.y + box.h - py) / box.h) * (state.ymax - state.ymin),
    };
  }

  function renderSelection(ctx) {
    const selection = state.drag || state.selection;
    if (!selection) return;
    const left = dataToPixel({ x: Math.min(selection.min, selection.max), y: state.ymin });
    const right = dataToPixel({ x: Math.max(selection.min, selection.max), y: state.ymin });
    ctx.save();
    ctx.fillStyle = "rgba(37, 99, 235, 0.14)";
    ctx.strokeStyle = "rgba(37, 99, 235, 0.55)";
    ctx.lineWidth = 1;
    ctx.fillRect(left.x, state.box.y, Math.max(1, right.x - left.x), state.box.h);
    ctx.strokeRect(left.x, state.box.y, Math.max(1, right.x - left.x), state.box.h);
    ctx.restore();
  }

  function renderMarkers(ctx) {
    const markers = state.markers || {};
    ctx.save();
    ctx.font = "11px Microsoft YaHei, system-ui";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const marker of markers.horizontal || []) {
      const y = dataToPixel({ x: state.xmin, y: marker.y }).y;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = marker.lineWidth || 1.5;
      ctx.setLineDash(marker.dashed || []);
      ctx.beginPath();
      ctx.moveTo(state.box.x, y);
      ctx.lineTo(state.box.x + state.box.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (marker.label) {
        ctx.fillStyle = marker.color;
        ctx.fillText(marker.label, state.box.x + 6, y - 10);
      }
    }
    for (const marker of markers.vertical || []) {
      const x = dataToPixel({ x: marker.x, y: state.ymin }).x;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = marker.lineWidth || 1.5;
      ctx.setLineDash(marker.dashed || []);
      ctx.beginPath();
      ctx.moveTo(x, state.box.y);
      ctx.lineTo(x, state.box.y + state.box.h);
      ctx.stroke();
      ctx.setLineDash([]);
      if (marker.label) {
        ctx.fillStyle = marker.color;
        ctx.fillText(marker.label, x + 4, state.box.y + 12);
      }
    }
    ctx.restore();
  }

  function render() {
    if (state.destroyed || !canvas) return null;
    const frame = getBox();
    if (!frame) return null;
    const { ctx, box } = frame;
    state.box = box;
    updateRanges();
    drawAxes(ctx, box, options.xLabel || "λ (nm)", options.yLabel || "T");
    if (!state.data.length) {
      ctx.fillStyle = palette.text;
      ctx.fillText("暂无可绘制谱线", box.x + 20, box.y + 42);
      return null;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.strokeStyle = options.color || palette.primary;
    ctx.lineWidth = 2;
    ctx.beginPath();
    state.data.forEach((d, idx) => {
      const point = dataToPixel(d);
      if (idx) ctx.lineTo(point.x, point.y);
      else ctx.moveTo(point.x, point.y);
    });
    ctx.stroke();
    renderSelection(ctx);
    renderMarkers(ctx);
    ctx.restore();
    ctx.fillStyle = palette.text;
    ctx.fillText(`${state.xmin.toFixed(0)}-${state.xmax.toFixed(0)} nm`, box.x, box.y + box.h + 32);
    return null;
  }

  function setSelection(selection, silent = false) {
    if (!selection) {
      state.selection = null;
      state.drag = null;
      render();
      return null;
    }
    const min = Math.min(Number(selection.min), Number(selection.max));
    const max = Math.max(Number(selection.min), Number(selection.max));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    state.selection = { min, max };
    state.drag = null;
    render();
    if (!silent && typeof options.onSelectionChange === "function") {
      options.onSelectionChange({ min, max });
    }
    return state.selection;
  }

  function clearSelection() {
    state.selection = null;
    state.drag = null;
    render();
  }

  function drawMarkers(nextMarkers) {
    state.markers = normalizeMarkerSet(nextMarkers);
    render();
    return state.markers;
  }

  function getEventPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    return { x, y };
  }

  function withinPlot(point) {
    const box = state.box;
    if (!box) return false;
    return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
  }

  function handleMouseDown(event) {
    if (state.destroyed || !options.interactive) return;
    if (event.button !== 0) return;
    const point = getEventPoint(event);
    if (!withinPlot(point)) return;
    const dataPoint = pixelToData(point);
    state.drag = { min: dataPoint.x, max: dataPoint.x };
    event.preventDefault();
    render();
  }

  function handleMouseMove(event) {
    if (state.destroyed || !options.interactive || !state.drag) return;
    const point = getEventPoint(event);
    const dataPoint = pixelToData(point);
    state.drag.max = dataPoint.x;
    render();
  }

  function handleMouseUp(event) {
    if (state.destroyed || !options.interactive || !state.drag) return;
    const point = getEventPoint(event);
    const dataPoint = pixelToData(point);
    const start = state.drag.min;
    const end = dataPoint.x;
    state.drag = null;
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    if (Math.abs(max - min) < (state.xmax - state.xmin) / 1000) {
      state.selection = null;
      render();
      if (typeof options.onSelectionChange === "function") options.onSelectionChange(null);
      return;
    }
    state.selection = { min, max };
    render();
    if (typeof options.onSelectionChange === "function") options.onSelectionChange({ min, max });
  }

  function handleMouseLeave() {
    if (state.destroyed || !options.interactive || !state.drag) return;
    state.drag = null;
    render();
  }

  if (canvas && options.interactive) {
    canvas.style.touchAction = "none";
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseLeave);
  }

  render();

  return {
    dataToPixel,
    pixelToData,
    setSelection,
    clearSelection,
    drawMarkers,
    destroy() {
      state.destroyed = true;
      if (canvas && options.interactive) {
        canvas.removeEventListener("mousedown", handleMouseDown);
        canvas.removeEventListener("mousemove", handleMouseMove);
        canvas.removeEventListener("mouseup", handleMouseUp);
        canvas.removeEventListener("mouseleave", handleMouseLeave);
      }
    },
  };
}

export function drawTrend(canvas, rows, xKey = "delta", yKey = "score") {
  const data = (rows || []).map((row, index) => ({
    x: Number(row[xKey] ?? index),
    y: Number(row[yKey] ?? row.score ?? row.q ?? row.max_t),
  }));
  drawLine(canvas, data, { xLabel: xKey, yLabel: yKey, color: palette.blue });
}

export function drawHeatmap(canvas, matrix) {
  const p = prep(canvas);
  if (!p) return;
  const { ctx, width, height } = p;
  const box = { x: 72, y: 30, w: width - 148, h: height - 94 };
  const rows = matrix?.values || [];
  if (!rows.length) {
    drawAxes(ctx, box, "位 (nm)", "扰动");
    ctx.fillStyle = palette.text;
    ctx.fillText("暂无热图数据", box.x + 20, box.y + 42);
    return;
  }
  const rCount = rows.length;
  const cCount = Math.max(...rows.map((r) => r.length));
  const cellW = box.w / Math.max(1, cCount);
  const cellH = box.h / Math.max(1, rCount);
  ctx.fillStyle = "#F8FAFB";
  ctx.fillRect(box.x, box.y, box.w, box.h);
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const raw = Number(value);
      const v = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0));
      const hue = 188 - v * 178;
      ctx.fillStyle = `hsl(${hue} 76% ${62 - v * 16}%)`;
      ctx.fillRect(box.x + c * cellW, box.y + r * cellH, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
    });
  });
  ctx.strokeStyle = "rgba(16, 24, 40, 0.08)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  for (let i = 1; i < 4; i += 1) {
    const x = box.x + (box.w * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
    ctx.stroke();
    const y = box.y + (box.h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  drawAxes(ctx, box, matrix?.x_axis_label || matrix?.x_label || "位 (nm)", matrix?.y_axis_label || matrix?.y_label || "扰动");
  const lambdas = (matrix?.lambda_grid || []).map(Number).filter(Number.isFinite);
  const deltas = (matrix?.deltas || []).map(Number).filter(Number.isFinite);
  ctx.fillStyle = palette.text;
  ctx.font = "11px Microsoft YaHei, system-ui";
  if (lambdas.length) {
    ctx.textAlign = "left";
    ctx.fillText(lambdas[0].toFixed(0), box.x, box.y + box.h + 18);
    ctx.textAlign = "center";
    ctx.fillText(lambdas[Math.floor(lambdas.length / 2)].toFixed(0), box.x + box.w / 2, box.y + box.h + 18);
    ctx.textAlign = "right";
    ctx.fillText(lambdas[lambdas.length - 1].toFixed(0), box.x + box.w, box.y + box.h + 18);
    ctx.textAlign = "left";
  }
  if (deltas.length) {
    ctx.textAlign = "right";
    ctx.fillText(deltas[0].toPrecision(3), box.x - 8, box.y + 12);
    ctx.fillText(deltas[Math.floor(deltas.length / 2)].toPrecision(3), box.x - 8, box.y + box.h / 2 + 4);
    ctx.fillText(deltas[deltas.length - 1].toPrecision(3), box.x - 8, box.y + box.h);
    ctx.textAlign = "left";
  }
  const legendX = box.x + box.w + 20;
  const legendY = box.y;
  const legendH = Math.min(150, box.h);
  for (let i = 0; i < legendH; i += 2) {
    const v = 1 - i / legendH;
    const hue = 188 - v * 178;
    ctx.fillStyle = `hsl(${hue} 76% ${62 - v * 16}%)`;
    ctx.fillRect(legendX, legendY + i, 12, 2);
  }
  ctx.fillStyle = palette.text;
  ctx.fillText("T 高", legendX + 18, legendY + 10);
  ctx.fillText("T 低", legendX + 18, legendY + legendH);
  if (Number.isFinite(Number(matrix?.raw_min)) && Number.isFinite(Number(matrix?.raw_max))) {
    ctx.fillStyle = palette.muted;
    ctx.fillText(`${Number(matrix.raw_max).toPrecision(3)}`, legendX + 18, legendY + 26);
    ctx.fillText(`${Number(matrix.raw_min).toPrecision(3)}`, legendX + 18, legendY + legendH - 16);
  }
}

export function drawDonut(canvas, value) {
  const p = prep(canvas);
  if (!p) return;
  const { ctx, width, height } = p;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 6;
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#E6F4F1";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = palette.primary;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v);
  ctx.stroke();
  ctx.fillStyle = palette.primary;
  ctx.font = "700 13px Microsoft YaHei, system-ui";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(v * 100)}%`, cx, cy + 5);
}
