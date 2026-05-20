const palette = {
  primary: "#0B7B6B",
  primary2: "#00746F",
  blue: "#2563EB",
  orange: "#D97706",
  red: "#D92D20",
  grid: "#E4ECEA",
  text: "#4B5563",
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
  ctx.beginPath();
  ctx.moveTo(box.x, box.y);
  ctx.lineTo(box.x, box.y + box.h);
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.stroke();
  ctx.fillStyle = palette.text;
  ctx.font = "12px Microsoft YaHei, system-ui";
  ctx.fillText(xLabel, box.x + box.w - 74, box.y + box.h + 32);
  ctx.save();
  ctx.translate(12, box.y + 78);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

export function drawLine(canvas, series, options = {}) {
  const p = prep(canvas);
  if (!p) return;
  const { ctx, width, height } = p;
  const box = { x: 54, y: 22, w: width - 76, h: height - 68 };
  const data = (series || []).filter((d) => Number.isFinite(Number(d.x)) && Number.isFinite(Number(d.y)));
  drawAxes(ctx, box, options.xLabel || "λ (nm)", options.yLabel || "T");
  if (!data.length) {
    ctx.fillStyle = palette.text;
    ctx.fillText("暂无可绘制谱线", box.x + 20, box.y + 42);
    return;
  }
  const [xmin, xmax] = range(data.map((d) => d.x));
  const [ymin, ymax] = range(data.map((d) => d.y));
  const sx = (v) => box.x + ((v - xmin) / (xmax - xmin)) * box.w;
  const sy = (v) => box.y + box.h - ((v - ymin) / (ymax - ymin)) * box.h;
  ctx.strokeStyle = options.color || palette.primary;
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, idx) => {
    const x = sx(Number(d.x));
    const y = sy(Number(d.y));
    if (idx) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = palette.text;
  ctx.fillText(`${xmin.toFixed(0)}-${xmax.toFixed(0)} nm`, box.x, box.y + box.h + 32);
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
  const box = { x: 52, y: 24, w: width - 86, h: height - 66 };
  drawAxes(ctx, box, "扰动 δ", "λ (nm)");
  const rows = matrix?.values || [];
  if (!rows.length) {
    ctx.fillStyle = palette.text;
    ctx.fillText("暂无热图数据", box.x + 20, box.y + 42);
    return;
  }
  const rCount = rows.length;
  const cCount = Math.max(...rows.map((r) => r.length));
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      const hue = 178 - v * 160;
      ctx.fillStyle = `hsl(${hue} 72% ${58 - v * 12}%)`;
      ctx.fillRect(box.x + (c / cCount) * box.w, box.y + (r / rCount) * box.h, Math.ceil(box.w / cCount) + 1, Math.ceil(box.h / rCount) + 1);
    });
  });
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
