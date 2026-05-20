# -*- coding: utf-8 -*-
"""
FDTD Spectrum Workbench V2 local server.

This server intentionally uses only Python standard-library modules.
Homepage bootstrap reads cached JSON only; directory scanning is started
explicitly through POST /api/v2/index/refresh and runs in a background thread.
"""
from __future__ import print_function

import argparse
import csv
import datetime as _dt
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import zipfile
from collections import defaultdict
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, quote, unquote, urlparse
import xml.etree.ElementTree as ET


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


WEB_DIR = Path(__file__).resolve().parent
STATE_DIR = WEB_DIR / "runtime_state"
LOG_DIR = WEB_DIR / "logs"
JOBS_DIR = STATE_DIR / "jobs"
RUN_DETAILS_DIR = STATE_DIR / "run_details"
SPECTRUM_CACHE_DIR = STATE_DIR / "spectrum_cache"
GENERATED_DIR = WEB_DIR / "generated"
TEMPLATE_DIR = WEB_DIR / "templates"

TEXT_PREVIEW_LIMIT = 128 * 1024
CSV_PREVIEW_ROWS = 20
XLSX_PREVIEW_ROWS = 12
SPECTRUM_MAX_POINTS = 1200

STANDARD_EVIDENCE = [
    ("R", "06_reflection_excel"),
    ("A", "07_absorption_excel"),
    ("Field", "08_field_data"),
    ("Phase", "09_phase_data"),
    ("Poynting", "10_poynting_data"),
]


def now_iso():
    return _dt.datetime.now().replace(microsecond=0).isoformat()


def now_stamp():
    return _dt.datetime.now().strftime("%Y%m%d_%H%M%S")


def ensure_dirs():
    for folder in [
        STATE_DIR,
        LOG_DIR,
        JOBS_DIR,
        RUN_DETAILS_DIR,
        SPECTRUM_CACHE_DIR,
        GENERATED_DIR / "reports",
        GENERATED_DIR / "exports",
        GENERATED_DIR / "supplement_requests",
        TEMPLATE_DIR,
    ]:
        folder.mkdir(parents=True, exist_ok=True)


def rel_to(root, path):
    try:
        return str(Path(path).resolve().relative_to(Path(root).resolve()))
    except Exception:
        return os.path.relpath(str(path), str(root))


def slash(path):
    return str(path).replace("/", "\\")


def iso_mtime(path):
    try:
        return _dt.datetime.fromtimestamp(Path(path).stat().st_mtime).replace(microsecond=0).isoformat()
    except Exception:
        return ""


def file_kind(path):
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in ("png", "jpg", "jpeg", "webp", "gif"):
        return "image"
    if ext in ("xlsx", "xlsm"):
        return "xlsx"
    if ext == "fsp":
        return "fsp"
    if ext == "py":
        return "py"
    if ext in ("csv", "json", "md", "txt", "log"):
        return ext
    return ext or "file"


def safe_token(text):
    cleaned = []
    for ch in str(text):
        cleaned.append(ch if ch.isalnum() or ch in "_-." else "_")
    return "".join(cleaned).strip("_") or "item"


def read_json(path, default):
    try:
        if Path(path).exists():
            with open(str(path), "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default


def atomic_write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(str(tmp), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(str(tmp), str(path))


def load_json_safe(path, default):
    """Public scanner helper: load JSON without raising into page/API code."""
    return read_json(path, default)


def save_json_atomic(path, data):
    """Public scanner helper: atomic JSON write used by runtime_state caches."""
    return atomic_write_json(path, data)


def safe_join(root, relative_path):
    """Join a project-relative path and block path traversal."""
    root_abs = os.path.abspath(str(root))
    full = os.path.abspath(os.path.join(root_abs, str(relative_path or "")))
    if os.path.commonpath([root_abs, full]) != root_abs:
        raise ValueError("path traversal blocked")
    return full


def append_log(path, text):
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(str(path), "a", encoding="utf-8", errors="replace") as f:
            f.write(text.rstrip("\n") + "\n")
    except Exception:
        pass


def decode_mixed_log(data):
    """Decode redirected subprocess logs written by UTF-8 or Windows GBK tools."""
    if not data:
        return ""
    candidates = []
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "cp936", "latin-1"):
        try:
            text = data.decode(encoding, errors="replace")
            score = text.count("\ufffd") * 10 + text.count("锟") * 3 + text.count("Ã")
            candidates.append((score, text))
        except Exception:
            continue
    if not candidates:
        return data.decode("utf-8", errors="replace")
    return min(candidates, key=lambda item: item[0])[1]


def count_csv_rows(path):
    try:
        with open(str(path), "r", encoding="utf-8-sig", errors="replace", newline="") as f:
            reader = csv.reader(f)
            rows = list(reader)
        return max(0, len(rows) - 1)
    except Exception:
        return 0


def read_csv_dicts(path, max_rows=2000):
    rows = []
    try:
        with open(str(path), "r", encoding="utf-8-sig", errors="replace", newline="") as f:
            reader = csv.DictReader(f)
            for idx, row in enumerate(reader):
                if idx >= max_rows:
                    break
                rows.append(dict(row))
    except Exception:
        pass
    return rows


def numeric(value):
    try:
        if value is None or value == "":
            return None
        return float(str(value).strip())
    except Exception:
        return None


def detect_group(parts):
    if not parts:
        return ""
    first = parts[0]
    if "C2" in first:
        return "C2"
    if "C3" in first:
        return "C3"
    if "C4" in first:
        return "C4"
    if "C6" in first:
        return "C6"
    if "近径向" in first or "圆环" in first or "圆盘" in first:
        return "近径向"
    return first


def detect_mode(name):
    low = name.lower()
    if re.match(r"^run[_-]preview", low) or "preview" in low:
        return "preview"
    if re.match(r"^run[_-]test", low) or "test" in low:
        return "test"
    if re.match(r"^run[_-]full", low) or "full" in low:
        return "full"
    return "unknown"


def context_from_rel(rel_path):
    parts = Path(rel_path).parts
    group = detect_group(parts)
    mother = ""
    perturbation = ""
    archive_state = ""
    reduction_path = ""
    if "results" in parts:
        idx = parts.index("results")
        if idx >= 1:
            mother = parts[idx - 1]
        if idx + 1 < len(parts):
            perturbation = parts[idx + 1]
        if "旧文件" in parts:
            old_idx = parts.index("旧文件")
            archive_state = "\\".join(parts[old_idx:-1])
    elif "coding" in [p.lower() for p in parts]:
        low = [p.lower() for p in parts]
        idx = low.index("coding")
        if idx >= 1:
            mother = parts[idx - 1]
        if idx + 1 < len(parts):
            perturbation = parts[idx + 1]
    if group in ("C2", "C3", "C4", "C6"):
        reduction_path = group + " -> 待识别"
    elif group == "近径向":
        reduction_path = "近径向 -> Cn"
    return group, mother, perturbation, reduction_path, archive_state


def run_id_for(rel_path):
    digest = hashlib.sha1(rel_path.encode("utf-8", errors="replace")).hexdigest()[:12]
    return "run_" + digest


def ext_count(folder, exts):
    if not folder.exists():
        return 0
    count = 0
    lowered = tuple(exts)
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix.lower() in lowered:
            count += 1
    return count


def first_existing(*paths):
    for p in paths:
        if p.exists():
            return p
    return None


def is_run_script_candidate(path):
    """Recognize executable FDTD run/sweep scripts without importing them."""
    name = Path(path).name.lower()
    if not name.endswith(".py"):
        return False
    if "__pycache__" in [p.lower() for p in Path(path).parts]:
        return False
    if "controller" in name or "manager" in name or "common" in name:
        return False
    return (
        name.startswith("run_")
        or "_sweep" in name
        or "sweep_" in name
        or "fdtd" in name
    )


def candidate_script_status(script, runs):
    has_full = False
    has_test = False
    has_failed = False
    key = (script.get("group"), script.get("mother_structure"), script.get("perturbation"))
    for run in runs:
        rkey = (run.get("group"), run.get("mother_structure"), run.get("perturbation"))
        if rkey != key:
            continue
        if run.get("risk_level") == "high":
            has_failed = True
        if run.get("mode") == "full" and run.get("spectra_count", 0) > 0:
            has_full = True
        if run.get("mode") == "test" and run.get("spectra_count", 0) > 0:
            has_test = True
    if has_failed:
        return "failed", "test"
    if has_full:
        return "has_full", "preview"
    if has_test:
        return "has_test", "full"
    return "missing_result", "test"


def file_fingerprint(path):
    try:
        stat = Path(path).stat()
        return "%s-%s" % (stat.st_mtime, stat.st_size)
    except Exception:
        return ""


def build_file_fingerprint(path):
    path = Path(path)
    try:
        stat = path.stat()
        return {
            "relative_path": "",
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "kind": file_kind(path),
            "fingerprint": "%s-%s" % (stat.st_mtime, stat.st_size),
        }
    except Exception:
        return {"mtime": 0, "size": 0, "kind": file_kind(path), "fingerprint": "missing"}


def build_dir_fingerprint(path):
    path = Path(path)
    mtime_max = 0.0
    total_size = 0
    file_count = 0
    dir_count = 0
    if not path.exists():
        return {"mtime_max": 0, "total_size": 0, "file_count": 0, "dir_count": 0, "fingerprint": "missing"}
    for item in path.rglob("*"):
        try:
            stat = item.stat()
        except Exception:
            continue
        if item.is_dir():
            dir_count += 1
            mtime_max = max(mtime_max, stat.st_mtime)
        elif item.is_file():
            file_count += 1
            total_size += stat.st_size
            mtime_max = max(mtime_max, stat.st_mtime)
    fp = "%s-%s-%s-%s" % (mtime_max, total_size, file_count, dir_count)
    return {
        "mtime_max": mtime_max,
        "total_size": total_size,
        "file_count": file_count,
        "dir_count": dir_count,
        "fingerprint": fp,
    }


def run_fingerprint(run_path):
    """Fast fingerprint for a run using mtime+size of known result files."""
    parts = []
    keep_exts = {".csv", ".json", ".md", ".xlsx", ".png", ".jpg", ".jpeg", ".fsp"}
    for p in Path(run_path).rglob("*"):
        if not p.is_file() or p.suffix.lower() not in keep_exts:
            continue
        rel = str(p.relative_to(run_path))
        parts.append("%s:%s" % (rel, file_fingerprint(p)))
    return hashlib.sha1("|".join(sorted(parts)).encode("utf-8", errors="replace")).hexdigest()


def find_spectrum_files(run_path, kind="T"):
    run_path = Path(run_path)
    folder_map = {
        "T": ["02_transmission_excel", "02_transmission", "data"],
        "R": ["06_reflection_excel"],
        "A": ["07_absorption_excel"],
    }
    folders = folder_map.get(str(kind).upper(), folder_map["T"])
    files = []
    for folder in folders:
        candidate = run_path / folder
        if not candidate.exists():
            continue
        files.extend(sorted(candidate.glob("*.csv")))
        files.extend(sorted(candidate.glob("*.xlsx")))
    if str(kind).upper() == "T":
        files.extend(sorted(run_path.glob("*trans*.csv")))
        files.extend(sorted(run_path.glob("*T*.csv")))
    seen = set()
    out = []
    for f in files:
        key = str(f.resolve()).lower()
        if key not in seen and f.is_file():
            seen.add(key)
            out.append(f)
    return out


def normalize_header(text):
    return re.sub(r"[^a-z0-9λ]+", "", str(text or "").strip().lower())


def choose_spectrum_columns(rows):
    if not rows:
        return None, None, 0
    lambda_names = {"lambda", "wavelength", "wavelengthnm", "lambdanm", "λ", "wl", "nm"}
    t_names = {"t", "transmission", "trans", "transmissionabs2", "abs2", "tabs2"}
    header = [normalize_header(x) for x in rows[0]]
    lambda_idx = next((i for i, h in enumerate(header) if h in lambda_names), None)
    t_idx = next((i for i, h in enumerate(header) if h in t_names), None)
    start_row = 1 if lambda_idx is not None or t_idx is not None else 0
    if lambda_idx is not None and t_idx is not None:
        return lambda_idx, t_idx, start_row
    numeric_counts = defaultdict(int)
    for row in rows[start_row:start_row + 30]:
        for i, value in enumerate(row):
            if numeric(value) is not None:
                numeric_counts[i] += 1
    numeric_cols = [i for i, _ in sorted(numeric_counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    if len(numeric_cols) >= 2:
        return numeric_cols[0], numeric_cols[1], start_row
    return None, None, start_row


def scan_spectrum_file(path):
    """Read one CSV/XLSX spectrum file and return lambda/T arrays plus metrics."""
    path = Path(path)
    rows = []
    if path.suffix.lower() == ".csv":
        try:
            with open(str(path), "r", encoding="utf-8-sig", errors="replace", newline="") as f:
                rows = list(csv.reader(f))
        except Exception:
            rows = []
    elif path.suffix.lower() in (".xlsx", ".xlsm"):
        rows = xlsx_first_sheet_rows(path, max_rows=10000)
    lambda_idx, t_idx, start_row = choose_spectrum_columns(rows)
    lambda_nm = []
    values = []
    if lambda_idx is not None and t_idx is not None:
        for row in rows[start_row:]:
            if max(lambda_idx, t_idx) >= len(row):
                continue
            lam = numeric(row[lambda_idx])
            val = numeric(row[t_idx])
            if lam is None or val is None:
                continue
            if lam < 10:
                lam *= 1000.0
            lambda_nm.append(lam)
            values.append(val)
    metrics = extract_metrics_from_spectrum(lambda_nm, values)
    return {
        "relative_source": str(path),
        "lambda_nm": lambda_nm,
        "T": values,
        "point_count": len(values),
        "metrics": metrics,
    }


def extract_metrics_from_spectrum(lambda_nm, T):
    """Estimate lambda0, max/min T, FWHM, Q and a compact score."""
    pairs = sorted(
        [(float(l), float(v)) for l, v in zip(lambda_nm or [], T or []) if numeric(l) is not None and numeric(v) is not None],
        key=lambda item: item[0],
    )
    if len(pairs) < 3:
        return {
            "lambda0_nm": None,
            "max_T": None,
            "min_T": None,
            "FWHM_nm": None,
            "Q": None,
            "score": 0,
            "feature_type": "unknown",
            "fwhm_points": 0,
            "point_count": len(pairs),
        }
    lam = [p[0] for p in pairs]
    vals = [p[1] for p in pairs]
    max_t = max(vals)
    min_t = min(vals)
    max_i = vals.index(max_t)
    min_i = vals.index(min_t)
    median = sorted(vals)[len(vals) // 2]
    peak_contrast = abs(max_t - median)
    dip_contrast = abs(median - min_t)
    is_peak = peak_contrast >= dip_contrast
    idx = max_i if is_peak else min_i
    lambda0 = lam[idx]
    feature_value = vals[idx]
    contrast = max_t - min_t
    half = min_t + contrast / 2.0 if is_peak else max_t - contrast / 2.0
    predicate = (lambda y: y >= half) if is_peak else (lambda y: y <= half)
    left = idx
    while left > 0 and predicate(vals[left]):
        left -= 1
    right = idx
    while right < len(vals) - 1 and predicate(vals[right]):
        right += 1

    def interp_x(i0, i1):
        x0, y0 = lam[i0], vals[i0]
        x1, y1 = lam[i1], vals[i1]
        if y1 == y0:
            return x0
        return x0 + (half - y0) * (x1 - x0) / (y1 - y0)

    fwhm = None
    if left < idx < right:
        left_x = interp_x(left, min(left + 1, len(vals) - 1))
        right_x = interp_x(max(right - 1, 0), right)
        fwhm = abs(right_x - left_x)
    q = lambda0 / fwhm if fwhm and fwhm > 0 else None
    fwhm_points = max(0, right - left - 1)
    score = (q or 0) * max(0.0, contrast) / (1.0 + max(0.0, max_t - 1.0) * 10.0)
    return {
        "lambda0_nm": lambda0,
        "max_T": max_t,
        "min_T": min_t,
        "FWHM_nm": fwhm,
        "Q": q,
        "score": score,
        "feature_type": "peak" if is_peak else "dip",
        "feature_value": feature_value,
        "fwhm_points": fwhm_points,
        "point_count": len(pairs),
        "lambda_min_nm": lam[0],
        "lambda_max_nm": lam[-1],
        "feature_index": idx,
    }


def build_missing_evidence(run_detail):
    evidence = run_detail.get("evidence") or {}
    return [name for name in ("R", "A", "Field", "Phase", "Poynting") if not evidence.get(name)]


def build_quality_flags(run_detail):
    flags = []
    run_id = run_detail.get("run_id")
    metrics = run_detail.get("metrics") or {}
    max_t = metrics.get("max_T") if metrics.get("max_T") is not None else run_detail.get("max_t")
    fwhm = metrics.get("FWHM_nm") if metrics.get("FWHM_nm") is not None else run_detail.get("fwhm_nm")
    lambda0 = metrics.get("lambda0_nm") if metrics.get("lambda0_nm") is not None else run_detail.get("lambda0_nm")
    if max_t is not None and max_t > 1.0:
        flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "T > 1", "severity": "fail", "detail": "max(T)=%.4g" % max_t, "suggestion": "复跑并检查归一化、monitor、mesh、simulation time"})
    if (metrics.get("point_count") or run_detail.get("sample_count") or 0) < 15:
        flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "采样不足", "severity": "warning", "detail": "主特征附近或谱线采样点不足", "suggestion": "缩小区间并加密扫描"})
    if not fwhm or (metrics.get("fwhm_points") is not None and metrics.get("fwhm_points") <= 4):
        flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "FWHM 不可靠", "severity": "warning", "detail": "半高宽点数不足或无法闭合", "suggestion": "加密 λ 或参数采样后复算"})
    if lambda0 is not None and metrics.get("lambda_min_nm") is not None:
        edge = min(abs(lambda0 - metrics.get("lambda_min_nm")), abs(metrics.get("lambda_max_nm") - lambda0))
        if edge < 100:
            flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "主特征靠边界", "severity": "warning", "detail": "lambda0 距离扫描边界 %.2f nm" % edge, "suggestion": "扩大波长扫描范围"})
    for missing in build_missing_evidence(run_detail):
        flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "缺 " + missing, "severity": "warning", "detail": "缺少 %s 补证数据" % missing, "suggestion": "进入补做实验生成任务包"})
    return flags


def read_metrics(run_path):
    metrics_path = first_existing(
        run_path / "12_analysis_summary" / "spectral_metrics.csv",
        run_path / "spectral_metrics.csv",
        run_path / "04_logs" / "spectral_metrics.csv",
    )
    rows = read_csv_dicts(metrics_path, max_rows=1000) if metrics_path else []
    best = {}
    best_score = None
    for row in rows:
        score = numeric(row.get("score") or row.get("Score"))
        q = numeric(row.get("Q") or row.get("q"))
        fwhm = numeric(row.get("FWHM") or row.get("fwhm_nm") or row.get("FWHM_nm"))
        max_t = numeric(row.get("max_T") or row.get("maxT") or row.get("max(T)") or row.get("T_max"))
        lam = numeric(row.get("lambda0_nm") or row.get("lambda_peak_nm") or row.get("peak_nm") or row.get("lambda_nm"))
        if score is None:
            score = (q or 0) / max(fwhm or 1.0, 1e-6)
        if best_score is None or score > best_score:
            best_score = score
            best = {
                "score": score,
                "q": q,
                "fwhm_nm": fwhm,
                "max_t": max_t,
                "lambda0_nm": lam,
                "delta": numeric(row.get("delta") or row.get("Delta")),
                "sample_id": row.get("sample_id") or row.get("id") or row.get("sample"),
            }
    return best, rows


def read_missing_report(run_path):
    report = first_existing(run_path / "missing_data_report.json", run_path / "12_analysis_summary" / "missing_data_report.json")
    if report:
        data = read_json(report, {})
        if isinstance(data, dict):
            return data
    return {}


def scan_run(root, run_path):
    rel = slash(rel_to(root, run_path))
    group, mother, perturbation, reduction_path, archive_state = context_from_rel(rel)
    run_name = Path(run_path).name
    mode = detect_mode(run_name)
    plan = first_existing(run_path / "00_scan_plan" / "scan_points.csv", run_path / "scan_points.csv")
    manifest = first_existing(run_path / "04_logs" / "manifest.csv", run_path / "05_logs" / "manifest.csv", run_path / "manifest.csv")
    sample_count = max(count_csv_rows(plan) if plan else 0, count_csv_rows(manifest) if manifest else 0)
    t_count = ext_count(run_path / "02_transmission_excel", (".xlsx", ".csv")) + ext_count(run_path / "data", (".csv",))
    if t_count == 0:
        t_count = ext_count(run_path, (".xlsx", ".csv"))
    png_count = ext_count(run_path / "03_transmission_abs2_png", (".png", ".jpg", ".jpeg")) + ext_count(run_path / "03_transmission_png_abs2", (".png", ".jpg", ".jpeg"))
    evidence = {
        "T": t_count > 0,
        "R": ext_count(run_path / "06_reflection_excel", (".xlsx", ".csv")) > 0,
        "A": ext_count(run_path / "07_absorption_excel", (".xlsx", ".csv")) > 0,
        "Field": ext_count(run_path / "08_field_data", (".mat", ".csv", ".json", ".png", ".jpg", ".npy", ".npz")) > 0,
        "Phase": ext_count(run_path / "09_phase_data", (".mat", ".csv", ".json", ".png", ".jpg", ".npy", ".npz")) > 0,
        "Poynting": ext_count(run_path / "10_poynting_data", (".mat", ".csv", ".json", ".png", ".jpg", ".npy", ".npz")) > 0,
    }
    missing_evidence = [name for name, ok in evidence.items() if name != "T" and not ok]
    missing_report = read_missing_report(run_path)
    for item in missing_report.get("missing_evidence", []) if isinstance(missing_report, dict) else []:
        if item not in missing_evidence:
            missing_evidence.append(str(item))
    best, metric_rows = read_metrics(run_path)
    flags = []
    if best.get("max_t") is not None and best.get("max_t") > 1:
        flags.append("T > 1")
    if sample_count and sample_count < 5:
        flags.append("采样不足")
    if not best.get("fwhm_nm"):
        flags.append("FWHM 不可靠")
    for name in missing_evidence:
        flags.append("缺 " + name)
    risk_level = "high" if any(f in flags for f in ("T > 1", "FWHM 不可靠")) else ("medium" if missing_evidence else "low")
    risk_label = {"high": "高", "medium": "中", "low": "低"}[risk_level]
    stat = Path(run_path).stat()
    return {
        "run_id": run_id_for(rel),
        "run_name": run_name,
        "relative_path": rel,
        "group": group,
        "mother_structure": mother,
        "perturbation": perturbation,
        "reduction_path": reduction_path,
        "mode": mode,
        "archive_state": archive_state,
        "sample_count": sample_count,
        "spectra_count": t_count,
        "png_count": png_count,
        "evidence": evidence,
        "missing_evidence": missing_evidence,
        "quality_flags": flags,
        "risk_level": risk_level,
        "risk_label": risk_label,
        "score": best.get("score"),
        "lambda0_nm": best.get("lambda0_nm"),
        "q": best.get("q"),
        "fwhm_nm": best.get("fwhm_nm"),
        "max_t": best.get("max_t"),
        "best_sample_id": best.get("sample_id"),
        "metric_rows": metric_rows[:200],
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "mtime_iso": iso_mtime(run_path),
    }


def scan_run_detail(run_path, root=None, previous_detail=None):
    """Build one run detail record from local files and cached fingerprints."""
    root = Path(root or Path(run_path).parents[0]).resolve()
    run_path = Path(run_path)
    fingerprint = run_fingerprint(run_path)
    if previous_detail and previous_detail.get("_fingerprint") == fingerprint:
        reused = dict(previous_detail)
        reused["_reused_from_cache"] = True
        return reused

    detail = scan_run(root, run_path)
    detail["trend_points"] = trend_points_from_rows(detail.get("metric_rows") or [])[:240]
    detail.pop("metric_rows", None)
    rel = slash(rel_to(root, run_path))
    detail["run_id"] = safe_token(run_path.name) + "_" + hashlib.sha1(rel.encode("utf-8", errors="replace")).hexdigest()[:8]
    detail["_fingerprint"] = fingerprint

    spectra_files = find_spectrum_files(run_path, "T")
    detail["spectra_files"] = [slash(rel_to(root, p)) for p in spectra_files]
    if spectra_files:
        # Only parse the first changed/representative T spectrum during indexing.
        spectrum = scan_spectrum_file(spectra_files[0])
        metrics = spectrum.get("metrics") or {}
        detail["metrics"] = metrics
        detail["lambda0_nm"] = detail.get("lambda0_nm") if detail.get("lambda0_nm") is not None else metrics.get("lambda0_nm")
        detail["q"] = detail.get("q") if detail.get("q") is not None else metrics.get("Q")
        detail["fwhm_nm"] = detail.get("fwhm_nm") if detail.get("fwhm_nm") is not None else metrics.get("FWHM_nm")
        detail["max_t"] = detail.get("max_t") if detail.get("max_t") is not None else metrics.get("max_T")
        detail["score"] = detail.get("score") if detail.get("score") is not None else metrics.get("score")
        detail["spectra_count"] = max(detail.get("spectra_count", 0), len(spectra_files))
    else:
        detail["metrics"] = {}

    detail["missing_evidence"] = build_missing_evidence(detail)
    flag_records = build_quality_flags(detail)
    detail["quality_flag_records"] = flag_records
    detail["quality_flags"] = [f.get("flag") for f in flag_records]
    if any(f.get("severity") in ("fail", "serious") for f in flag_records):
        detail["risk_level"] = "high"
    elif flag_records:
        detail["risk_level"] = "medium"
    else:
        detail["risk_level"] = "low"
    detail["risk_label"] = {"high": "高", "medium": "中", "low": "低"}[detail["risk_level"]]
    return detail


def scan_runs(root, previous_index=None):
    """Incrementally scan run directories using previous run fingerprints."""
    previous_index = previous_index or {}
    prev_by_path = {
        item.get("relative_path"): item
        for item in previous_index.get("runs", [])
        if item.get("relative_path")
    }
    root = Path(root)
    runs = []
    for dirpath, dirnames, filenames in os.walk(str(root)):
        p = Path(dirpath)
        try:
            resolved = p.resolve()
            if resolved == WEB_DIR.resolve() or WEB_DIR.resolve() in resolved.parents:
                dirnames[:] = []
                continue
        except Exception:
            pass
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        if p.name.lower().startswith("run_"):
            rel = slash(rel_to(root, p))
            try:
                runs.append(scan_run_detail(p, root=root, previous_detail=prev_by_path.get(rel)))
            except Exception as exc:
                append_log(STATE_DIR / "scan_errors.log", "scan_run_detail failed %s: %s" % (p, exc))
    runs.sort(key=lambda x: x.get("mtime", 0), reverse=True)
    return runs


def parse_script_defaults(path):
    defaults = {}
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return defaults
    keys = (
        "START_NM", "END_NM", "STEP_NM", "RUN_MODE_DEFAULT", "TEST_POINT_COUNT",
        "MESH_ACCURACY", "SIMULATION_TIME_FS", "AUTO_SHUTOFF_MIN", "DT_STABILITY_FACTOR",
        "start_nm", "end_nm", "step_nm", "START", "END", "STEP",
        "scan_start", "scan_end", "scan_step",
    )
    for key in keys:
        m = re.search(r"^\s*%s\s*=\s*([^\n#]+)" % re.escape(key), text, flags=re.M)
        if m:
            raw = m.group(1).strip().strip("'\"")
            defaults[key] = numeric(raw) if numeric(raw) is not None else raw
    return defaults


def scan_scripts(root, previous_registry=None, runs=None):
    """Scan runnable script metadata into script_registry.json records.

    The scanner reads Python files as text only. It never imports or executes
    project scripts.
    """
    if isinstance(previous_registry, list) and runs is None:
        runs = previous_registry
        previous_registry = None
    runs = runs or []
    records = []
    root = Path(root)
    for dirpath, dirnames, filenames in os.walk(str(root)):
        p = Path(dirpath)
        if WEB_DIR in p.resolve().parents or p.resolve() == WEB_DIR.resolve():
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            path = p / name
            if not is_run_script_candidate(path):
                continue
            rel = slash(rel_to(root, path))
            group, mother, perturbation, reduction_path, _ = context_from_rel(rel)
            if not mother:
                parts = Path(rel).parts
                mother = parts[-3] if len(parts) >= 3 else p.parent.name
            if not perturbation:
                perturbation = p.name if p.name not in ("coding", "scripts") else path.stem
            defaults = parse_script_defaults(path)
            draft = {
                "group": group,
                "mother_structure": mother,
                "perturbation": perturbation,
            }
            status, recommended = candidate_script_status(draft, runs)
            start = defaults.get("START_NM") or defaults.get("start_nm") or defaults.get("START") or defaults.get("scan_start") or ""
            end = defaults.get("END_NM") or defaults.get("end_nm") or defaults.get("END") or defaults.get("scan_end") or ""
            step = defaults.get("STEP_NM") or defaults.get("step_nm") or defaults.get("STEP") or defaults.get("scan_step") or ""
            estimated = ""
            if numeric(start) is not None and numeric(end) is not None and numeric(step) not in (None, 0):
                estimated = int(abs(numeric(end) - numeric(start)) / abs(numeric(step))) + 1
            records.append({
                "id": len(records) + 1,
                "script_id": safe_token(Path(rel).with_suffix("").name + "_" + hashlib.sha1(rel.encode("utf-8", errors="replace")).hexdigest()[:8]),
                "relative_path": rel,
                "group": group,
                "mother_structure": mother,
                "perturbation": perturbation,
                "reduction_path": reduction_path,
                "status": status,
                "recommended_mode": recommended,
                "default_start_nm": start,
                "default_end_nm": end,
                "default_step_nm": step,
                "estimated_points": estimated or defaults.get("TEST_POINT_COUNT", ""),
            })
    records.sort(key=lambda x: (x["group"], x["mother_structure"], x["perturbation"], x["relative_path"]))
    for idx, item in enumerate(records, 1):
        item["id"] = idx
    return records


def build_samples_for_run(root, run):
    run_path = Path(root) / run["relative_path"]
    rows = []
    fsp_files = sorted((run_path / "01_fsp").glob("*.fsp")) if (run_path / "01_fsp").exists() else sorted(run_path.rglob("*.fsp"))
    plan = first_existing(run_path / "00_scan_plan" / "scan_points.csv", run_path / "scan_points.csv")
    manifest = first_existing(run_path / "04_logs" / "manifest.csv", run_path / "05_logs" / "manifest.csv", run_path / "manifest.csv")
    source_rows = read_csv_dicts(plan, 2000) or read_csv_dicts(manifest, 2000)
    metric_rows = run.get("metric_rows") or []
    metric_by_sample = {}
    metric_by_index = {}
    for row in metric_rows:
        sid = row.get("sample_id") or row.get("id") or row.get("sample")
        if sid:
            metric_by_sample[str(sid)] = row
        idx = numeric(row.get("index") or row.get("sample_index") or row.get("idx"))
        if idx is not None:
            metric_by_index[int(idx)] = row
    flag_records = run.get("quality_flag_records") or []
    flag_names = run.get("quality_flags") or [f.get("flag") for f in flag_records if isinstance(f, dict)]
    for idx, row in enumerate(source_rows):
        sid = row.get("sample_id") or row.get("id") or row.get("index") or row.get("sample") or "#%d" % (idx + 1)
        metric = metric_by_sample.get(str(sid)) or metric_by_index.get(idx) or metric_by_index.get(idx + 1) or {}
        max_t = numeric(metric.get("max_T") or metric.get("maxT") or metric.get("T_max") or metric.get("max_t") or run.get("max_t"))
        sample_flags = []
        if max_t is not None and max_t > 1:
            sample_flags.append("T > 1")
        sample_flags.extend(flag_names or [])
        sample_flags = list(dict.fromkeys([str(x) for x in sample_flags if x]))
        rows.append({
            "sample_id": sid,
            "delta": row.get("delta") or row.get("Delta") or row.get("value") or row.get("scan_value"),
            "lambda0_nm": metric.get("lambda0_nm") or metric.get("lambda_peak_nm") or run.get("lambda0_nm"),
            "Q": metric.get("Q") or metric.get("q") or run.get("q"),
            "q": metric.get("Q") or metric.get("q") or run.get("q"),
            "FWHM_nm": metric.get("FWHM_nm") or metric.get("FWHM") or metric.get("fwhm_nm") or run.get("fwhm_nm"),
            "fwhm_nm": metric.get("FWHM_nm") or metric.get("FWHM") or metric.get("fwhm_nm") or run.get("fwhm_nm"),
            "max_T": max_t,
            "max_t": max_t,
            "score": metric.get("score") or metric.get("quality_score") or run.get("score"),
            "quality_flags": sample_flags,
            "missing_evidence": run.get("missing_evidence", []),
            "source_fsp": row.get("source_fsp") or row.get("fsp") or (slash(rel_to(root, fsp_files[min(idx, len(fsp_files) - 1)])) if fsp_files else ""),
        })
    if not rows:
        rows.append({
            "sample_id": run.get("best_sample_id") or "#1",
            "delta": run.get("delta", ""),
            "lambda0_nm": run.get("lambda0_nm", ""),
            "Q": run.get("q", ""),
            "q": run.get("q", ""),
            "FWHM_nm": run.get("fwhm_nm", ""),
            "fwhm_nm": run.get("fwhm_nm", ""),
            "max_T": run.get("max_t", ""),
            "max_t": run.get("max_t", ""),
            "score": run.get("score", ""),
            "quality_flags": flag_names,
            "missing_evidence": run.get("missing_evidence", []),
            "source_fsp": slash(rel_to(root, fsp_files[0])) if fsp_files else "",
        })
    return rows


def list_run_files(root, run):
    run_path = Path(root) / run["relative_path"]
    items = []
    if not run_path.exists():
        return items
    for p in run_path.rglob("*"):
        if not p.is_file() or p.suffix.lower() in (".pyc",):
            continue
        try:
            stat = p.stat()
        except Exception:
            continue
        items.append({
            "relative_path": slash(rel_to(root, p)),
            "name": p.name,
            "extension": p.suffix.lower().lstrip("."),
            "kind": file_kind(p),
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "mtime_iso": iso_mtime(p),
        })
    items.sort(key=lambda x: (x["kind"], x["relative_path"]))
    return items


def scan_file_index(root):
    items = []
    fingerprints = {}
    root = Path(root)
    for dirpath, dirnames, filenames in os.walk(str(root)):
        p = Path(dirpath)
        try:
            resolved = p.resolve()
            if resolved == WEB_DIR.resolve() or WEB_DIR.resolve() in resolved.parents:
                dirnames[:] = []
                continue
        except Exception:
            pass
        if "__pycache__" in dirnames:
            dirnames.remove("__pycache__")
        for name in filenames:
            path = p / name
            if path.suffix.lower() in (".pyc", ".tmp"):
                continue
            try:
                stat = path.stat()
            except Exception:
                continue
            rel = slash(rel_to(root, path))
            kind = file_kind(path)
            item = {
                "relative_path": rel,
                "name": name,
                "extension": path.suffix.lower().lstrip("."),
                "kind": kind,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "mtime_iso": iso_mtime(path),
                "fingerprint": "%s-%s" % (stat.st_mtime, stat.st_size),
            }
            items.append(item)
            fingerprints[rel] = {
                "mtime": stat.st_mtime,
                "size": stat.st_size,
                "kind": kind,
                "hash_fast": "%s-%s" % (stat.st_mtime, stat.st_size),
            }
    items.sort(key=lambda x: x["relative_path"])
    return items, fingerprints


def discover_runs(root):
    return scan_runs(root, previous_index=None)


def compute_groups(runs, scripts):
    groups = []
    by_group = defaultdict(list)
    for run in runs:
        by_group[run.get("group") or "未分类"].append(run)
    script_group_counts = defaultdict(int)
    for script in scripts:
        script_group_counts[script.get("group") or "未分类"] += 1
    for group, rows in sorted(by_group.items()):
        mother_count = len(set(r.get("mother_structure") for r in rows if r.get("mother_structure")))
        denom = max(script_group_counts.get(group, 0), len(rows), 1)
        groups.append({
            "group": group,
            "run_count": len(rows),
            "mother_count": mother_count,
            "coverage_rate": min(1.0, float(len(rows)) / float(denom)),
        })
    return groups


def build_summary(runs, scripts, groups):
    severe = [r for r in runs if r.get("risk_level") == "high"]
    warning = [r for r in runs if r.get("risk_level") == "medium"]
    mothers_total = len(set([s.get("mother_structure") for s in scripts if s.get("mother_structure")] + [r.get("mother_structure") for r in runs if r.get("mother_structure")]))
    mothers_with_runs = len(set(r.get("mother_structure") for r in runs if r.get("mother_structure")))
    candidates = sorted(runs, key=lambda r: (r.get("score") if r.get("score") is not None else -1), reverse=True)[:10]
    return {
        "valid_run_count": len([r for r in runs if r.get("spectra_count", 0) > 0]),
        "bad_run_count": len(severe),
        "spectra_count": sum(r.get("spectra_count", 0) for r in runs),
        "missing_evidence_count": sum(len(r.get("missing_evidence", [])) for r in runs),
        "mother_coverage_rate": float(mothers_with_runs) / float(mothers_total or 1),
        "severe_issue_count": len(severe),
        "warning_count": len(warning),
        "pass_sample_count": sum(max(1, r.get("sample_count", 0)) for r in runs if r.get("risk_level") == "low"),
        "rerun_count": len(severe) + len(warning),
        "high_value_candidates": candidates,
    }


def build_risks(runs):
    risk_rows = []
    for run in runs:
        flags = run.get("quality_flags") or []
        if not flags and run.get("risk_level") == "low":
            continue
        title = "%s / %s / %s" % (run.get("group") or "未识别", run.get("mother_structure") or "", run.get("perturbation") or run.get("run_name"))
        risk_rows.append({
            "level": "high" if run.get("risk_level") == "high" else "medium",
            "title": title,
            "detail": "、".join(flags[:4]) if flags else "证据不完整",
            "suggestion": "进入补做实验或以 test 模式复核",
            "run_id": run.get("run_id"),
            "when": run.get("mtime_iso", "")[:10],
        })
    return risk_rows[:100]


def build_top_candidates(run_index, quality_cache=None):
    runs = run_index.get("runs", []) if isinstance(run_index, dict) else run_index
    candidates = []
    for run in runs:
        if run.get("risk_level") == "high":
            continue
        candidates.append({
            "run_id": run.get("run_id"),
            "run_name": run.get("run_name"),
            "group": run.get("group"),
            "mother_structure": run.get("mother_structure"),
            "perturbation": run.get("perturbation"),
            "reduction_path": run.get("reduction_path"),
            "score": run.get("score"),
            "lambda0_nm": run.get("lambda0_nm"),
            "q": run.get("q"),
            "fwhm_nm": run.get("fwhm_nm"),
            "missing_evidence": run.get("missing_evidence", []),
        })
    candidates.sort(key=lambda item: item.get("score") if item.get("score") is not None else -1, reverse=True)
    return candidates[:30]


def trend_points_from_rows(rows):
    points = []
    for idx, row in enumerate(rows or []):
        points.append({
            "delta": numeric(row.get("delta") or row.get("Delta") or row.get("value_nm") or row.get("param_value")) if numeric(row.get("delta") or row.get("Delta") or row.get("value_nm") or row.get("param_value")) is not None else idx,
            "score": numeric(row.get("score") or row.get("Score")) or 0,
            "q": numeric(row.get("Q") or row.get("q")) or 0,
            "fwhm_nm": numeric(row.get("FWHM") or row.get("fwhm_nm") or row.get("FWHM_nm")) or 0,
            "lambda0_nm": numeric(row.get("lambda0_nm") or row.get("lambda_peak_nm") or row.get("peak_nm")),
        })
    return points


def slim_run_for_cache(run):
    keep = {
        "run_id", "run_name", "relative_path", "group", "mother_structure",
        "perturbation", "reduction_path", "mode", "archive_state",
        "sample_count", "spectra_count", "missing_evidence",
        "quality_flags", "risk_level", "risk_label",
        "score", "lambda0_nm", "q", "fwhm_nm", "max_t", "best_sample_id",
        "mtime", "mtime_iso",
    }
    return {k: v for k, v in run.items() if k in keep}


def build_quality_cache(runs):
    flag_rows = []
    by_run = {}
    for run in runs:
        records = run.get("quality_flag_records") or []
        by_run[run.get("run_id")] = {
            "flags": records,
            "flag_names": [f.get("flag") for f in records],
            "risk_level": run.get("risk_level"),
            "risk_label": run.get("risk_label"),
        }
        flag_rows.extend(records)
    serious = [f for f in flag_rows if f.get("severity") in ("fail", "serious")]
    warnings = [f for f in flag_rows if f.get("severity") == "warning"]
    return {
        "schema_version": 1,
        "built_at": now_iso(),
        "runs": by_run,
        "flags": flag_rows,
        "serious_count": len(serious),
        "warning_count": len(warnings),
        "missing_evidence_count": len([f for f in flag_rows if str(f.get("flag", "")).startswith("缺 ")]),
        "passed_count": len([r for r in runs if not r.get("quality_flag_records")]),
        "rerun_suggested_count": len([r for r in runs if r.get("risk_level") in ("high", "medium")]),
    }


def build_overview_summary(runs, scripts, quality):
    groups = compute_groups(runs, scripts)
    summary_data = build_summary(runs, scripts, groups)
    summary_data.update({
        "serious_count": quality.get("serious_count", 0),
        "warning_count": quality.get("warning_count", 0),
        "passed_count": quality.get("passed_count", 0),
        "rerun_suggested_count": quality.get("rerun_suggested_count", 0),
        "high_value_candidates": build_top_candidates(runs),
        "next_actions": [
            {
                "title": "补齐缺失证据",
                "count": quality.get("missing_evidence_count", 0),
                "target": "supplement",
            },
            {
                "title": "复核严重质量旗标",
                "count": quality.get("serious_count", 0),
                "target": "quality",
            },
        ],
    })
    return summary_data


def scan_project(root, previous_index=None, previous_registry=None):
    """Unified data scanner used by HTML pages through runtime_state caches."""
    started = time.time()
    root = Path(root)
    files, fingerprints = scan_file_index(root)
    scripts_pre = scan_scripts(root, previous_registry or {}, runs=[])
    runs = scan_runs(root, previous_index or {})
    scripts = scan_scripts(root, previous_registry or {}, runs=runs)
    quality = build_quality_cache(runs)
    groups = compute_groups(runs, scripts)
    summary_data = build_overview_summary(runs, scripts, quality)
    slim_runs = [slim_run_for_cache(r) for r in runs]
    cache = {
        "schema_version": 2,
        "project_root": str(root),
        "built_at": now_iso(),
        "scan_duration_ms": int((time.time() - started) * 1000),
        "summary": summary_data,
        "groups": groups,
        "runs": slim_runs,
        "risks": build_risks(runs),
        "errors": [],
    }
    file_index = {
        "schema_version": 1,
        "built_at": cache["built_at"],
        "files": files,
    }
    registry = {
        "schema_version": 1,
        "built_at": cache["built_at"],
        "scripts": scripts,
        "controllers": [
            {
                "name": "fdtd_master_controller.py",
                "relative_path": "fdtd_master_controller.py",
                "args": ["--mode", "--style", "--max-parallel", "--ids", "--all", "--missing-only", "--overrides-json", "--child-timeout-s", "--yes"],
            }
        ],
    }
    meta = {
        "schema_version": 1,
        "built_at": cache["built_at"],
        "fingerprints": fingerprints,
    }
    return {
        "index_cache": cache,
        "script_registry": registry,
        "quality_cache": quality,
        "index_meta": meta,
        "file_index": file_index,
    }


def refresh_index_job(app, full_rebuild=False):
    """Background refresh flow: old split caches -> incremental scan -> atomic JSON."""
    started = time.time()
    result = rebuild_split_caches(app.root, app=app, full_rebuild=full_rebuild)
    result["index_meta"]["scan_duration_ms"] = int((time.time() - started) * 1000)
    # Legacy index_cache is kept small for compatibility, but no longer drives L1.
    legacy = {
        "schema_version": 2,
        "project_root": str(app.root),
        "built_at": result["index_meta"].get("built_at"),
        "scan_duration_ms": result["index_meta"].get("scan_duration_ms", 0),
        "summary": dict(result["overview_cache"].get("summary", {}), high_value_candidates=result["overview_cache"].get("top_candidates", [])[:10]),
        "groups": result["overview_cache"].get("groups", []),
        "runs": result["overview_cache"].get("recent_runs", [])[:10],
        "risks": result["overview_cache"].get("risks", [])[:10],
        "errors": [],
    }
    save_json_atomic(app.index_cache_path, legacy)
    save_json_atomic(app.index_meta_path, result["index_meta"])
    save_json_atomic(app.overview_cache_path, result["overview_cache"])
    save_json_atomic(app.run_index_cache_path, result["run_index_cache"])
    save_json_atomic(app.script_registry_path, result["script_registry"])
    save_json_atomic(app.quality_cache_path, result["quality_cache"])
    save_json_atomic(app.supplement_index_path, result["supplement_index"])
    save_json_atomic(app.resource_index_light_path, result["resource_index_light"])
    save_json_atomic(app.resource_index_full_path, result["resource_index_full"])
    save_json_atomic(app.file_index_path, result["resource_index_full"])
    save_json_atomic(app.spectra_index_path, result["spectra_index"])
    app.record_cache_change(result.get("changed_runs", []), result.get("changed_paths", []), overview_changed=bool(result.get("changed_runs")))
    return result


def sheet_names_from_xlsx(path):
    names = []
    try:
        with zipfile.ZipFile(str(path)) as zf:
            xml = zf.read("xl/workbook.xml")
        root = ET.fromstring(xml)
        ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        for sheet in root.findall(".//a:sheet", ns):
            names.append(sheet.attrib.get("name", "Sheet"))
    except Exception:
        pass
    return names


def xlsx_shared_strings(zf):
    strings = []
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        for si in root.findall(".//a:si", ns):
            text = "".join(t.text or "" for t in si.findall(".//a:t", ns))
            strings.append(text)
    except Exception:
        pass
    return strings


def xlsx_first_sheet_rows(path, max_rows=XLSX_PREVIEW_ROWS):
    rows = []
    try:
        with zipfile.ZipFile(str(path)) as zf:
            shared = xlsx_shared_strings(zf)
            sheet_paths = sorted([n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")])
            if not sheet_paths:
                return rows
            root = ET.fromstring(zf.read(sheet_paths[0]))
            ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            for row in root.findall(".//a:sheetData/a:row", ns):
                values = []
                for cell in row.findall("a:c", ns):
                    typ = cell.attrib.get("t")
                    v = cell.find("a:v", ns)
                    raw = "" if v is None or v.text is None else v.text
                    if typ == "s":
                        try:
                            raw = shared[int(raw)]
                        except Exception:
                            pass
                    values.append(raw)
                rows.append(values)
                if len(rows) >= max_rows:
                    break
    except Exception:
        pass
    return rows


def sample_points(points, limit=SPECTRUM_MAX_POINTS):
    if len(points) <= limit:
        return points
    step = max(1, int(len(points) / limit))
    return points[::step][:limit]


def infer_delta_from_text(text, fallback=0):
    patterns = [
        r"delta[_=\- ]*([+-]?\d+(?:\.\d+)?)",
        r"value[_=\- ]*([+-]?\d+(?:\.\d+)?)",
        r"([+-]?\d+(?:\.\d+)?)\s*nm",
    ]
    for pattern in patterns:
        m = re.search(pattern, str(text), flags=re.I)
        if m:
            val = numeric(m.group(1))
            if val is not None:
                return val
    return fallback


def interpolate_series(lam, values, grid):
    if not lam or not values or not grid:
        return []
    pairs = sorted(zip(lam, values), key=lambda p: p[0])
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    out = []
    j = 0
    for x in grid:
        while j < len(xs) - 2 and xs[j + 1] < x:
            j += 1
        if x < xs[0] or x > xs[-1]:
            out.append(None)
        else:
            x0, x1 = xs[j], xs[j + 1] if j + 1 < len(xs) else xs[j]
            y0, y1 = ys[j], ys[j + 1] if j + 1 < len(ys) else ys[j]
            if x1 == x0:
                out.append(y0)
            else:
                out.append(y0 + (x - x0) * (y1 - y0) / (x1 - x0))
    return out


def parse_csv_spectrum(path):
    rows = []
    try:
        with open(str(path), "r", encoding="utf-8-sig", errors="replace", newline="") as f:
            reader = csv.reader(f)
            all_rows = list(reader)
        for row in all_rows[1:]:
            nums = [numeric(x) for x in row]
            nums = [x for x in nums if x is not None]
            if len(nums) >= 2:
                rows.append([nums[0], nums[1]])
    except Exception:
        pass
    return sample_points(rows)


def parse_xlsx_spectrum(path):
    rows = xlsx_first_sheet_rows(path, max_rows=5000)
    points = []
    for row in rows[1:]:
        nums = [numeric(x) for x in row]
        nums = [x for x in nums if x is not None]
        if len(nums) >= 2:
            x, y = nums[0], nums[1]
            if x < 10:
                x = x * 1000.0
            points.append([x, y])
    return sample_points(points)


def run_detail_cache_path(run_id):
    return RUN_DETAILS_DIR / ("%s.json" % safe_token(run_id))


def spectrum_cache_path(spectrum_id):
    return SPECTRUM_CACHE_DIR / ("%s.json" % safe_token(spectrum_id))


def build_run_light(detail, source_job_id=None):
    fp = build_dir_fingerprint(Path(detail.get("_abs_path", ""))) if detail.get("_abs_path") else {
        "mtime_max": detail.get("mtime", 0),
        "total_size": detail.get("size", 0),
        "file_count": 0,
        "fingerprint": detail.get("_fingerprint", ""),
    }
    evidence = detail.get("evidence") or {}
    return {
        "run_id": detail.get("run_id"),
        "run_name": detail.get("run_name"),
        "relative_path": detail.get("relative_path"),
        "group": detail.get("group"),
        "mother_structure": detail.get("mother_structure"),
        "perturbation": detail.get("perturbation"),
        "reduction_path": detail.get("reduction_path"),
        "status": "done" if detail.get("spectra_count", 0) or detail.get("sample_count", 0) else "unknown",
        "risk": detail.get("risk_level", "unknown"),
        "risk_level": detail.get("risk_level", "unknown"),
        "risk_label": detail.get("risk_label", ""),
        "mode": detail.get("mode"),
        "archive_state": detail.get("archive_state"),
        "spectrum_count": detail.get("spectra_count", 0),
        "spectra_count": detail.get("spectra_count", 0),
        "sample_count": detail.get("sample_count", 0),
        "has_T": bool(evidence.get("T")),
        "has_R": bool(evidence.get("R")),
        "has_A": bool(evidence.get("A")),
        "has_field": bool(evidence.get("Field")),
        "has_phase": bool(evidence.get("Phase")),
        "has_poynting": bool(evidence.get("Poynting")),
        "best_score": detail.get("score"),
        "score": detail.get("score"),
        "lambda0_nm": detail.get("lambda0_nm"),
        "Q": detail.get("q"),
        "q": detail.get("q"),
        "FWHM_nm": detail.get("fwhm_nm"),
        "fwhm_nm": detail.get("fwhm_nm"),
        "max_t": detail.get("max_t"),
        "modified_at": detail.get("mtime_iso"),
        "mtime": detail.get("mtime", 0),
        "fingerprint": fp,
        "last_indexed_at": now_iso(),
        "source_job_id": source_job_id,
        "missing_evidence": detail.get("missing_evidence", []),
        "quality_flags": detail.get("quality_flags", []),
    }


def build_run_detail_payload(root, detail, source_job_id=None):
    run_id = detail.get("run_id")
    run_light = build_run_light(detail, source_job_id=source_job_id)
    run_light["evidence"] = detail.get("evidence", {})
    run_light["quality_flag_records"] = detail.get("quality_flag_records", [])
    payload = {
        "schema_version": 2,
        "run": run_light,
        "samples": build_samples_for_run(root, detail),
        "files": list_run_files(root, detail),
        "metrics": detail.get("trend_points", []),
        "quality_flags": detail.get("quality_flag_records", []),
        "missing_evidence": detail.get("missing_evidence", []),
        "linked_supplements": [],
    }
    payload.update(run_light)
    return payload


def save_run_detail_cache(root, detail, source_job_id=None):
    payload = build_run_detail_payload(root, detail, source_job_id=source_job_id)
    save_json_atomic(run_detail_cache_path(detail["run_id"]), payload)
    return payload


def load_run_detail_cache(run_id):
    return load_json_safe(run_detail_cache_path(run_id), None)


def spectrum_id_for(run_id, rel_path, kind="T", sample_id=""):
    raw = "|".join([str(run_id), str(rel_path), str(kind), str(sample_id)])
    return "spec_" + hashlib.sha1(raw.encode("utf-8", errors="replace")).hexdigest()[:16]


def scan_spectrum_index(run_detail, root=None):
    root = Path(root or ".")
    run_path = root / run_detail.get("relative_path", "")
    items = []
    for kind in ("T", "R", "A"):
        for idx, path in enumerate(find_spectrum_files(run_path, kind)):
            stat = path.stat()
            rel = slash(rel_to(root, path))
            sample_id = "#%d" % (idx + 1)
            sid = spectrum_id_for(run_detail.get("run_id"), rel, kind, sample_id)
            cache_rel = slash(rel_to(root, spectrum_cache_path(sid))) if root in spectrum_cache_path(sid).resolve().parents else slash(str(spectrum_cache_path(sid)))
            cache = load_json_safe(spectrum_cache_path(sid), {})
            cache_valid = (
                bool(cache)
                and cache.get("source_mtime") == stat.st_mtime
                and cache.get("source_size") == stat.st_size
            )
            metrics = cache.get("metrics") or {}
            items.append({
                "spectrum_id": sid,
                "run_id": run_detail.get("run_id"),
                "sample_id": sample_id,
                "kind": kind,
                "relative_path": rel,
                "lambda_min": metrics.get("lambda_min_nm"),
                "lambda_max": metrics.get("lambda_max_nm"),
                "point_count": cache.get("point_count"),
                "source_mtime": stat.st_mtime,
                "source_size": stat.st_size,
                "cache_path": cache_rel,
                "cache_valid": cache_valid,
            })
    return items


def load_or_build_spectrum_cache(spectrum_item, root=None):
    root = Path(root or ".")
    source = root / spectrum_item.get("relative_path", "")
    if not source.exists():
        raise ValueError("spectrum source not found")
    stat = source.stat()
    cache_path = spectrum_cache_path(spectrum_item["spectrum_id"])
    cached = load_json_safe(cache_path, {})
    if cached and cached.get("source_mtime") == stat.st_mtime and cached.get("source_size") == stat.st_size:
        return cached
    parsed = scan_spectrum_file(source)
    value = parsed.get("T", [])
    metrics = parsed.get("metrics") or {}
    data = {
        "schema_version": 2,
        "spectrum_id": spectrum_item["spectrum_id"],
        "run_id": spectrum_item.get("run_id"),
        "sample_id": spectrum_item.get("sample_id"),
        "kind": spectrum_item.get("kind", "T"),
        "lambda_nm": parsed.get("lambda_nm", []),
        "value": value,
        "metrics": metrics,
        "point_count": len(value),
        "source_path": spectrum_item.get("relative_path"),
        "source_mtime": stat.st_mtime,
        "source_size": stat.st_size,
        "built_at": now_iso(),
    }
    save_json_atomic(cache_path, data)
    return data


def empty_overview_cache():
    return {
        "schema_version": 2,
        "summary": {
            "valid_run_count": 0,
            "bad_run_count": 0,
            "spectra_count": 0,
            "missing_evidence_count": 0,
            "mother_coverage_rate": 0,
        },
        "groups": [],
        "top_candidates": [],
        "recent_runs": [],
        "risks": [],
        "next_actions": [],
    }


def compact_index_meta(meta, root=None):
    meta = meta or {}
    counts = meta.get("counts") or {}
    return {
        "schema_version": 2,
        "project_root": meta.get("project_root") or (str(root) if root else ""),
        "built_at": meta.get("built_at", ""),
        "scan_duration_ms": meta.get("scan_duration_ms", 0),
        "scanner_version": meta.get("scanner_version", "v2"),
        "status": meta.get("status", "empty" if not meta.get("built_at") else "ready"),
        "stale": bool(meta.get("stale", not bool(meta.get("built_at")))),
        "counts": {
            "runs": counts.get("runs", 0),
            "scripts": counts.get("scripts", 0),
            "spectra": counts.get("spectra", 0),
            "files": counts.get("files", 0),
        },
        "last_error": meta.get("last_error"),
        "full_rebuild": bool(meta.get("full_rebuild", False)),
        "changed_paths_count": len(meta.get("changed_paths", []) or []),
    }


def build_overview_cache(run_index, script_registry, quality_cache, supplement_index):
    runs = run_index.get("runs", [])
    scripts = script_registry.get("scripts", [])
    quality_flags = quality_cache.get("flags", [])
    groups = compute_groups([
        {
            "group": r.get("group"),
            "mother_structure": r.get("mother_structure"),
            "spectra_count": r.get("spectrum_count", r.get("spectra_count", 0)),
        }
        for r in runs
    ], scripts)
    valid = [r for r in runs if r.get("spectrum_count", r.get("spectra_count", 0)) > 0 or r.get("sample_count", 0) > 0]
    bad = [r for r in runs if r.get("risk_level") == "high" or r.get("risk") == "high"]
    mothers_total = len(set([s.get("mother_structure") for s in scripts if s.get("mother_structure")] + [r.get("mother_structure") for r in runs if r.get("mother_structure")]))
    mothers_valid = len(set(r.get("mother_structure") for r in valid if r.get("mother_structure")))
    candidates = sorted(runs, key=lambda r: r.get("best_score") if r.get("best_score") is not None else (r.get("score") if r.get("score") is not None else -1), reverse=True)[:10]
    recent = sorted(runs, key=lambda r: r.get("mtime", 0), reverse=True)[:10]
    risks = []
    for flag in quality_flags[:40]:
        if len(risks) >= 10:
            break
        risks.append({
            "level": "high" if flag.get("severity") in ("fail", "serious") else "medium",
            "title": flag.get("run_id", "") + " / " + flag.get("flag", ""),
            "detail": flag.get("detail", ""),
            "suggestion": flag.get("suggestion", ""),
            "run_id": flag.get("run_id"),
            "when": quality_cache.get("built_at", "")[:10],
        })
    missing_count = quality_cache.get("missing_evidence_count", 0)
    return {
        "schema_version": 2,
        "summary": {
            "valid_run_count": len(valid),
            "bad_run_count": len(bad),
            "spectra_count": sum(r.get("spectrum_count", r.get("spectra_count", 0)) for r in runs),
            "missing_evidence_count": missing_count,
            "mother_coverage_rate": float(mothers_valid) / float(mothers_total or 1),
            "severe_issue_count": quality_cache.get("serious_count", 0),
            "warning_count": quality_cache.get("warning_count", 0),
            "passed_count": quality_cache.get("passed_count", 0),
            "rerun_suggested_count": quality_cache.get("rerun_suggested_count", 0),
        },
        "groups": groups,
        "top_candidates": candidates,
        "recent_runs": recent,
        "risks": risks,
        "next_actions": [
            {"title": "补齐缺失证据", "count": missing_count, "target": "supplement"},
            {"title": "复核严重质量旗标", "count": quality_cache.get("serious_count", 0), "target": "quality"},
            {"title": "检查补做任务包", "count": len(supplement_index.get("packages", [])), "target": "supplement"},
        ],
    }


def discover_run_dirs_under(root, base_paths=None):
    root = Path(root)
    bases = []
    if base_paths:
        for rel in base_paths:
            try:
                p = Path(safe_join(root, rel))
                if p.exists():
                    bases.append(p)
            except Exception:
                pass
    if not bases:
        bases = [root]
    found = []
    seen = set()
    for base in bases:
        if base.is_dir() and base.name.lower().startswith("run_"):
            candidates = [base]
        else:
            candidates = []
            if base.exists():
                for dirpath, dirnames, filenames in os.walk(str(base)):
                    p = Path(dirpath)
                    try:
                        resolved = p.resolve()
                        if resolved == WEB_DIR.resolve() or WEB_DIR.resolve() in resolved.parents:
                            dirnames[:] = []
                            continue
                    except Exception:
                        pass
                    dirnames[:] = [d for d in dirnames if d != "__pycache__"]
                    if p.name.lower().startswith("run_"):
                        candidates.append(p)
                        dirnames[:] = []
        for p in candidates:
            key = str(p.resolve()).lower()
            if key not in seen:
                seen.add(key)
                found.append(p)
    return found


def scan_changed_run_dirs(root, previous_run_index):
    prev = {
        item.get("relative_path"): item.get("fingerprint", {})
        for item in previous_run_index.get("runs", [])
        if item.get("relative_path")
    }
    changed = []
    current_paths = set()
    for run_dir in discover_run_dirs_under(root):
        rel = slash(rel_to(root, run_dir))
        current_paths.add(rel)
        fp = build_dir_fingerprint(run_dir)
        old = prev.get(rel)
        if not old or old.get("fingerprint") != fp.get("fingerprint"):
            changed.append({"relative_path": rel, "path": run_dir, "fingerprint": fp})
    deleted = [rel for rel in prev if rel not in current_paths]
    return changed, deleted


def scan_runs_light(root, changed_paths=None, previous_run_index=None, source_job_id=None):
    root = Path(root)
    previous_run_index = previous_run_index or {"runs": []}
    prev_by_path = {r.get("relative_path"): r for r in previous_run_index.get("runs", [])}
    bases = changed_paths if changed_paths else None
    changed_dirs = discover_run_dirs_under(root, bases)
    light = []
    details = []
    for run_dir in changed_dirs:
        rel = slash(rel_to(root, run_dir))
        fp = build_dir_fingerprint(run_dir)
        old = prev_by_path.get(rel)
        if old and old.get("fingerprint", {}).get("fingerprint") == fp.get("fingerprint"):
            light.append(old)
            continue
        detail = scan_run_detail(run_dir, root=root, previous_detail=None)
        detail["_abs_path"] = str(run_dir)
        light_item = build_run_light(detail, source_job_id=source_job_id)
        light_item["fingerprint"] = fp
        light.append(light_item)
        details.append(detail)
    return light, details


def merge_run_index(old_index, changed_light, deleted_paths=None):
    deleted_paths = set(deleted_paths or [])
    by_path = {
        r.get("relative_path"): r
        for r in old_index.get("runs", [])
        if r.get("relative_path") and r.get("relative_path") not in deleted_paths
    }
    for item in changed_light:
        by_path[item.get("relative_path")] = item
    runs = sorted(by_path.values(), key=lambda r: r.get("mtime", 0), reverse=True)
    return {"schema_version": 2, "built_at": now_iso(), "runs": runs}


def merge_spectra_index(old_index, changed_items, changed_run_ids=None):
    changed_run_ids = set(changed_run_ids or [])
    old_items = [
        item for item in old_index.get("items", [])
        if item.get("run_id") not in changed_run_ids
    ]
    all_items = old_items + list(changed_items)
    all_items.sort(key=lambda x: (x.get("run_id", ""), x.get("kind", ""), x.get("relative_path", "")))
    return {"schema_version": 2, "built_at": now_iso(), "items": all_items}


def update_quality_cache_for_changed_runs(old_quality, changed_details, removed_run_ids=None):
    removed_run_ids = set(removed_run_ids or [])
    runs_map = {
        k: v for k, v in (old_quality.get("runs", {}) if isinstance(old_quality.get("runs"), dict) else {}).items()
        if k not in removed_run_ids
    }
    for detail in changed_details:
        records = detail.get("quality_flag_records") or build_quality_flags(detail)
        runs_map[detail.get("run_id")] = {
            "flags": records,
            "flag_names": [f.get("flag") for f in records],
            "risk_level": detail.get("risk_level"),
            "risk_label": detail.get("risk_label"),
        }
    flags = []
    for data in runs_map.values():
        flags.extend(data.get("flags", []))
    serious = [f for f in flags if f.get("severity") in ("fail", "serious")]
    warnings = [f for f in flags if f.get("severity") == "warning"]
    return {
        "schema_version": 2,
        "built_at": now_iso(),
        "runs": runs_map,
        "flags": flags,
        "serious_count": len(serious),
        "warning_count": len(warnings),
        "missing_evidence_count": len([f for f in flags if str(f.get("flag", "")).startswith("缺 ")]),
        "passed_count": len([k for k, v in runs_map.items() if not v.get("flags")]),
        "rerun_suggested_count": len([k for k, v in runs_map.items() if v.get("risk_level") in ("high", "medium")]),
    }


def update_run_index_for_changed_runs(root, changed_paths, old_run_index, source_job_id=None):
    changed_light, changed_details = scan_runs_light(root, changed_paths=changed_paths, previous_run_index=old_run_index, source_job_id=source_job_id)
    for detail in changed_details:
        save_run_detail_cache(root, detail, source_job_id=source_job_id)
    new_index = merge_run_index(old_run_index, changed_light)
    return new_index, changed_details


def update_spectra_index_for_changed_runs(root, changed_details, old_spectra_index):
    items = []
    run_ids = []
    for detail in changed_details:
        run_ids.append(detail.get("run_id"))
        items.extend(scan_spectrum_index(detail, root=root))
    return merge_spectra_index(old_spectra_index, items, changed_run_ids=run_ids)


def update_overview_cache_incremental(changed_runs, old_overview, run_index=None, script_registry=None, quality_cache=None, supplement_index=None):
    if run_index is None or script_registry is None or quality_cache is None:
        return old_overview
    return build_overview_cache(run_index, script_registry, quality_cache, supplement_index or {"packages": []})


def build_resource_indexes(root):
    files, fingerprints = scan_file_index(root)
    light = []
    for item in files:
        light.append({
            "relative_path": item.get("relative_path"),
            "kind": item.get("kind"),
            "extension": item.get("extension"),
            "size": item.get("size"),
            "mtime": item.get("mtime"),
            "mtime_iso": item.get("mtime_iso"),
        })
    return (
        {"schema_version": 2, "built_at": now_iso(), "items": light, "files": light},
        {"schema_version": 2, "built_at": now_iso(), "items": files, "files": files},
        fingerprints,
    )


def collect_resource_items(root, base_paths):
    root = Path(root)
    items = []
    fingerprints = {}
    seen = set()
    for rel in base_paths or []:
        try:
            base = Path(safe_join(root, rel))
        except Exception:
            continue
        if not base.exists():
            continue
        paths = [base] if base.is_file() else list(base.rglob("*"))
        for path in paths:
            if not path.is_file() or path.suffix.lower() in (".pyc", ".tmp"):
                continue
            try:
                stat = path.stat()
            except Exception:
                continue
            rel_path = slash(rel_to(root, path))
            if rel_path in seen:
                continue
            seen.add(rel_path)
            kind = file_kind(path)
            item = {
                "relative_path": rel_path,
                "name": path.name,
                "extension": path.suffix.lower().lstrip("."),
                "kind": kind,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "mtime_iso": iso_mtime(path),
                "fingerprint": "%s-%s" % (stat.st_mtime, stat.st_size),
            }
            items.append(item)
            fingerprints[rel_path] = {
                "mtime": stat.st_mtime,
                "size": stat.st_size,
                "kind": kind,
                "hash_fast": "%s-%s" % (stat.st_mtime, stat.st_size),
            }
    return sorted(items, key=lambda x: x["relative_path"]), fingerprints


def update_resource_indexes_for_paths(root, old_light, old_full, dirty_paths, deleted_paths=None):
    dirty_paths = [slash(str(p)).rstrip("\\") for p in dirty_paths or [] if p]
    deleted_paths = [slash(str(p)).rstrip("\\") for p in deleted_paths or [] if p]
    prefixes = dirty_paths + deleted_paths
    if not prefixes:
        return old_light, old_full

    def affected(rel):
        rel = slash(rel)
        return any(rel == p or rel.startswith(p + "\\") for p in prefixes)

    full_items = [item for item in (old_full.get("items") or old_full.get("files") or []) if not affected(item.get("relative_path", ""))]
    light_items = [item for item in (old_light.get("items") or old_light.get("files") or []) if not affected(item.get("relative_path", ""))]
    new_items, _ = collect_resource_items(root, dirty_paths)
    full_items.extend(new_items)
    for item in new_items:
        light_items.append({
            "relative_path": item.get("relative_path"),
            "kind": item.get("kind"),
            "extension": item.get("extension"),
            "size": item.get("size"),
            "mtime": item.get("mtime"),
            "mtime_iso": item.get("mtime_iso"),
        })
    full_items.sort(key=lambda x: x.get("relative_path", ""))
    light_items.sort(key=lambda x: x.get("relative_path", ""))
    built = now_iso()
    return (
        {"schema_version": 2, "built_at": built, "items": light_items, "files": light_items},
        {"schema_version": 2, "built_at": built, "items": full_items, "files": full_items},
    )


def scan_project_incremental(root, previous_meta=None, previous_run_index=None, full_rebuild=False):
    started = time.time()
    root = Path(root)
    previous_run_index = previous_run_index or {"runs": []}
    if full_rebuild or not previous_run_index.get("runs"):
        changed = [{"relative_path": slash(rel_to(root, p)), "path": p, "fingerprint": build_dir_fingerprint(p)} for p in discover_run_dirs_under(root)]
        deleted = []
    else:
        changed, deleted = scan_changed_run_dirs(root, previous_run_index)
    changed_paths = [c["relative_path"] for c in changed]
    return {
        "changed_paths": changed_paths,
        "deleted_paths": deleted,
        "full_rebuild": full_rebuild,
        "duration_ms": int((time.time() - started) * 1000),
    }


def rebuild_split_caches(root, app=None, full_rebuild=False):
    root = Path(root)
    old_run_index = load_json_safe(app.run_index_cache_path if app else STATE_DIR / "run_index_cache.json", {"runs": []})
    old_quality = load_json_safe(app.quality_cache_path if app else STATE_DIR / "quality_cache.json", {})
    old_spectra = load_json_safe(app.spectra_index_path if app else STATE_DIR / "spectra_index.json", {"items": []})
    old_scripts = load_json_safe(app.script_registry_path if app else STATE_DIR / "script_registry.json", {})
    old_resource_light = load_json_safe(app.resource_index_light_path if app else STATE_DIR / "resource_index_light.json", {"items": [], "files": []})
    old_resource_full = load_json_safe(app.resource_index_full_path if app else STATE_DIR / "resource_index_full.json", {"items": [], "files": []})
    supplement = load_json_safe(app.supplement_index_path if app else STATE_DIR / "supplement_index.json", {"packages": []})
    inc = scan_project_incremental(root, previous_run_index=old_run_index, full_rebuild=full_rebuild)
    run_index, changed_details = update_run_index_for_changed_runs(root, inc["changed_paths"], old_run_index)
    if inc["deleted_paths"]:
        run_index = merge_run_index(run_index, [], deleted_paths=inc["deleted_paths"])
    scripts = scan_scripts(root, old_scripts, runs=run_index.get("runs", []))
    script_registry = {"schema_version": 2, "built_at": now_iso(), "scripts": scripts}
    spectra_index = update_spectra_index_for_changed_runs(root, changed_details, old_spectra)
    removed_ids = []
    if inc["deleted_paths"]:
        removed_ids = [r.get("run_id") for r in old_run_index.get("runs", []) if r.get("relative_path") in set(inc["deleted_paths"])]
    quality = update_quality_cache_for_changed_runs(old_quality, changed_details, removed_run_ids=removed_ids)
    overview = build_overview_cache(run_index, script_registry, quality, supplement)
    if full_rebuild or not (old_resource_full.get("items") or old_resource_full.get("files")):
        resource_light, resource_full, _ = build_resource_indexes(root)
    else:
        resource_light, resource_full = update_resource_indexes_for_paths(
            root,
            old_resource_light,
            old_resource_full,
            inc["changed_paths"],
            deleted_paths=inc["deleted_paths"],
        )
    meta = {
        "schema_version": 2,
        "project_root": str(root),
        "built_at": now_iso(),
        "scan_duration_ms": inc["duration_ms"],
        "scanner_version": "v2",
        "status": "ready",
        "stale": False,
        "counts": {
            "runs": len(run_index.get("runs", [])),
            "scripts": len(script_registry.get("scripts", [])),
            "spectra": len(spectra_index.get("items", [])),
            "files": len(resource_full.get("items", [])),
        },
        "last_error": None,
        "changed_paths": inc["changed_paths"][:500],
        "full_rebuild": bool(full_rebuild),
    }
    return {
        "index_meta": meta,
        "overview_cache": overview,
        "run_index_cache": run_index,
        "script_registry": script_registry,
        "quality_cache": quality,
        "supplement_index": supplement,
        "resource_index_light": resource_light,
        "resource_index_full": resource_full,
        "spectra_index": spectra_index,
        "changed_runs": [d.get("run_id") for d in changed_details],
        "changed_paths": inc["changed_paths"],
    }


def scripts_by_ids(script_registry, ids):
    scripts = script_registry.get("scripts", [])
    by_id = {}
    for script in scripts:
        by_id[str(script.get("id"))] = script
        by_id[str(script.get("script_id"))] = script
    return [by_id.get(str(i)) for i in ids if by_id.get(str(i))]


def predict_expected_outputs(job_manifest):
    expected = []
    parents = []
    mode = job_manifest.get("mode") or "test"
    stamp = job_manifest.get("created_at", "").replace("-", "").replace(":", "").replace("T", "_")[:15]
    for script in job_manifest.get("scripts", []):
        rel = script.get("relative_path") or ""
        parts = Path(rel).parts
        parent = ""
        if "coding" in [p.lower() for p in parts]:
            low = [p.lower() for p in parts]
            idx = low.index("coding")
            if idx >= 1 and idx + 1 < len(parts):
                parent = slash(str(Path(*parts[:idx]) / "results" / parts[idx + 1]))
        if not parent:
            mother = script.get("mother_structure") or ""
            perturb = script.get("perturbation") or Path(rel).stem
            group_text = script.get("group") or ""
            parent = slash(str(Path(group_text + "对称结构") / mother / "results" / perturb)) if mother else ""
        if parent:
            parents.append(parent)
            run_root = slash(str(Path(parent) / ("run_%s_%s" % (mode, stamp))))
            expected.extend([
                {"kind": "run_root", "relative_path": run_root},
                {"kind": "T", "relative_path": slash(str(Path(run_root) / "02_transmission_excel"))},
                {"kind": "T_png", "relative_path": slash(str(Path(run_root) / "03_transmission_abs2_png"))},
                {"kind": "logs", "relative_path": slash(str(Path(run_root) / "04_logs"))},
                {"kind": "analysis", "relative_path": slash(str(Path(run_root) / "12_analysis_summary"))},
            ])
    job_manifest["expected_outputs"] = expected
    job_manifest["probable_output_parents"] = sorted(set(parents))
    return job_manifest


def create_job_manifest(request, job_id=None, script_registry=None):
    ids = request.get("ids") or request.get("script_ids") or []
    if isinstance(ids, str):
        ids = [x.strip() for x in ids.split(",") if x.strip()]
    scripts = scripts_by_ids(script_registry or {"scripts": []}, ids)
    job_id = job_id or ("job_" + now_stamp() + "_" + hashlib.sha1(",".join(map(str, ids)).encode("utf-8")).hexdigest()[:6])
    manifest = {
        "schema_version": 1,
        "job_id": job_id,
        "created_at": now_iso(),
        "finished_at": None,
        "status": "planned",
        "trigger": "web_ui",
        "mode": request.get("mode") or "preview",
        "style": request.get("style") or "sequential",
        "script_ids": [str(i) for i in ids],
        "scripts": scripts,
        "overrides": request.get("overrides") or {},
        "command": "",
        "expected_outputs": [],
        "probable_output_parents": [],
        "dirty_paths": [],
        "created_files": [],
        "modified_files": [],
        "deleted_files": [],
        "cache_update_status": "pending",
    }
    return predict_expected_outputs(manifest)


def take_path_snapshot(root, paths):
    root = Path(root)
    items = []
    seen = set()
    for rel in paths or []:
        try:
            base = Path(safe_join(root, rel))
        except Exception:
            continue
        candidates = [base]
        if base.exists() and base.is_dir():
            candidates.extend(base.rglob("*"))
        for path in candidates:
            try:
                stat = path.stat()
            except Exception:
                continue
            rel_path = slash(rel_to(root, path))
            if rel_path in seen:
                continue
            seen.add(rel_path)
            kind = "dir" if path.is_dir() else file_kind(path)
            items.append({"relative_path": rel_path, "mtime": stat.st_mtime, "size": stat.st_size if path.is_file() else 0, "kind": kind})
    return {"taken_at": now_iso(), "items": sorted(items, key=lambda x: x["relative_path"])}


def diff_snapshots(before, after):
    before_map = {i["relative_path"]: i for i in before.get("items", [])}
    after_map = {i["relative_path"]: i for i in after.get("items", [])}
    created_files, modified_files, deleted_files = [], [], []
    created_dirs, modified_dirs = [], []
    for rel, item in after_map.items():
        old = before_map.get(rel)
        if not old:
            (created_dirs if item.get("kind") == "dir" else created_files).append(rel)
        elif old.get("mtime") != item.get("mtime") or old.get("size") != item.get("size"):
            (modified_dirs if item.get("kind") == "dir" else modified_files).append(rel)
    for rel, item in before_map.items():
        if rel not in after_map and item.get("kind") != "dir":
            deleted_files.append(rel)
    dirty = sorted(set(created_files + modified_files + created_dirs + modified_dirs))
    return {
        "finished_at": now_iso(),
        "created_files": created_files,
        "modified_files": modified_files,
        "deleted_files": deleted_files,
        "created_dirs": created_dirs,
        "modified_dirs": modified_dirs,
        "dirty_paths": dirty,
    }


def normalize_dirty_paths_to_run_or_parent(root, dirty_paths):
    out = []
    for rel in dirty_paths or []:
        parts = Path(rel).parts
        run_idx = next((i for i, part in enumerate(parts) if part.lower().startswith("run_")), None)
        if run_idx is not None:
            out.append(slash(str(Path(*parts[:run_idx + 1]))))
        elif "results" in parts:
            idx = parts.index("results")
            if idx + 1 < len(parts):
                out.append(slash(str(Path(*parts[:idx + 2]))))
        else:
            out.append(rel)
    return sorted(set(out))


def refresh_delta_paths(app, dirty_paths, job_id=None):
    dirty_paths = normalize_dirty_paths_to_run_or_parent(app.root, dirty_paths)
    old_run_index = load_json_safe(app.run_index_cache_path, {"runs": []})
    old_spectra = load_json_safe(app.spectra_index_path, {"items": []})
    old_quality = load_json_safe(app.quality_cache_path, {})
    old_resource_light = load_json_safe(app.resource_index_light_path, {"items": [], "files": []})
    old_resource_full = load_json_safe(app.resource_index_full_path, {"items": [], "files": []})
    script_registry = load_json_safe(app.script_registry_path, {"scripts": []})
    supplement = load_json_safe(app.supplement_index_path, {"packages": []})
    run_index, changed_details = update_run_index_for_changed_runs(app.root, dirty_paths, old_run_index, source_job_id=job_id)
    spectra_index = update_spectra_index_for_changed_runs(app.root, changed_details, old_spectra)
    quality = update_quality_cache_for_changed_runs(old_quality, changed_details)
    overview = build_overview_cache(run_index, script_registry, quality, supplement)
    resource_light, resource_full = update_resource_indexes_for_paths(app.root, old_resource_light, old_resource_full, dirty_paths)
    meta = load_json_safe(app.index_meta_path, {})
    meta.update({
        "schema_version": 2,
        "project_root": str(app.root),
        "built_at": now_iso(),
        "scanner_version": "v2",
        "status": "ready",
        "stale": False,
        "counts": {
            "runs": len(run_index.get("runs", [])),
            "scripts": len(script_registry.get("scripts", [])),
            "spectra": len(spectra_index.get("items", [])),
            "files": len(resource_full.get("items", [])),
        },
        "last_error": None,
    })
    save_json_atomic(app.run_index_cache_path, run_index)
    save_json_atomic(app.spectra_index_path, spectra_index)
    save_json_atomic(app.quality_cache_path, quality)
    save_json_atomic(app.overview_cache_path, overview)
    save_json_atomic(app.resource_index_light_path, resource_light)
    save_json_atomic(app.resource_index_full_path, resource_full)
    save_json_atomic(app.file_index_path, resource_full)
    save_json_atomic(app.index_meta_path, meta)
    changed_runs = [d.get("run_id") for d in changed_details]
    app.record_cache_change(changed_runs, dirty_paths, overview_changed=bool(changed_runs), job_id=job_id)
    return {"changed_runs": changed_runs, "dirty_paths": dirty_paths, "overview_changed": bool(changed_runs)}


def refresh_delta_from_job(app, job_id):
    job_dir = JOBS_DIR / job_id
    delta = load_json_safe(job_dir / "delta_files.json", {})
    dirty = delta.get("dirty_paths", [])
    manifest = load_json_safe(job_dir / "job_manifest.json", {})
    if not dirty:
        dirty = manifest.get("probable_output_parents", [])
    result = refresh_delta_paths(app, dirty, job_id=job_id)
    manifest["cache_update_status"] = "done"
    manifest["dirty_paths"] = result.get("dirty_paths", [])
    manifest["updated_runs"] = result.get("changed_runs", [])
    save_json_atomic(job_dir / "job_manifest.json", manifest)
    return result


class WorkbenchApp(object):
    def __init__(self, root, port):
        self.root = Path(root).resolve()
        self.port = int(port)
        ensure_dirs()
        self.index_cache_path = STATE_DIR / "index_cache.json"
        self.index_meta_path = STATE_DIR / "index_meta.json"
        self.overview_cache_path = STATE_DIR / "overview_cache.json"
        self.run_index_cache_path = STATE_DIR / "run_index_cache.json"
        self.script_registry_path = STATE_DIR / "script_registry.json"
        self.job_state_path = STATE_DIR / "job_state.json"
        self.supplement_index_path = STATE_DIR / "supplement_index.json"
        self.quality_cache_path = STATE_DIR / "quality_cache.json"
        self.file_index_path = STATE_DIR / "file_index.json"
        self.resource_index_light_path = STATE_DIR / "resource_index_light.json"
        self.resource_index_full_path = STATE_DIR / "resource_index_full.json"
        self.spectra_index_path = STATE_DIR / "spectra_index.json"
        self.cache_changes_path = STATE_DIR / "cache_changes.json"
        self.preload_state_path = STATE_DIR / "preload_state.json"
        self.scan_lock = threading.Lock()
        self.scan_status = {
            "running": False,
            "progress": 0,
            "message": "未刷新",
            "started_at": "",
            "completed_at": "",
            "error": "",
        }
        self.preload_status_data = {
            "running": False,
            "started_at": "",
            "completed_at": "",
            "progress": 0,
            "queue": [],
            "current": "",
            "counts": {},
        }
        self.jobs = {}
        self.ensure_initial_state()

    def ensure_initial_state(self):
        if not self.index_meta_path.exists():
            atomic_write_json(self.index_meta_path, compact_index_meta({}, root=self.root))
        if not self.index_cache_path.exists():
            atomic_write_json(self.index_cache_path, {
                "schema_version": 2,
                "project_root": str(self.root),
                "built_at": "",
                "scan_duration_ms": 0,
                "summary": {
                    "valid_run_count": 0,
                    "bad_run_count": 0,
                    "spectra_count": 0,
                    "missing_evidence_count": 0,
                    "mother_coverage_rate": 0,
                },
                "groups": [],
                "runs": [],
                "risks": [],
                "files": [],
                "errors": [],
            })
        if not self.script_registry_path.exists():
            atomic_write_json(self.script_registry_path, {"schema_version": 1, "built_at": "", "scripts": []})
        if not self.overview_cache_path.exists():
            atomic_write_json(self.overview_cache_path, empty_overview_cache())
        if not self.run_index_cache_path.exists():
            atomic_write_json(self.run_index_cache_path, {"schema_version": 2, "built_at": "", "runs": []})
        if not self.quality_cache_path.exists():
            atomic_write_json(self.quality_cache_path, {"schema_version": 2, "built_at": "", "runs": {}, "flags": []})
        if not self.supplement_index_path.exists():
            atomic_write_json(self.supplement_index_path, {"schema_version": 1, "built_at": "", "packages": []})
        if not self.file_index_path.exists():
            atomic_write_json(self.file_index_path, {"schema_version": 1, "built_at": "", "files": []})
        if not self.resource_index_light_path.exists():
            atomic_write_json(self.resource_index_light_path, {"schema_version": 2, "built_at": "", "items": [], "files": []})
        if not self.resource_index_full_path.exists():
            atomic_write_json(self.resource_index_full_path, {"schema_version": 2, "built_at": "", "items": [], "files": []})
        if not self.spectra_index_path.exists():
            atomic_write_json(self.spectra_index_path, {"schema_version": 2, "built_at": "", "items": []})
        if not self.job_state_path.exists():
            atomic_write_json(self.job_state_path, {"schema_version": 1, "built_at": "", "jobs": []})
        if not self.cache_changes_path.exists():
            atomic_write_json(self.cache_changes_path, {"schema_version": 1, "changes": []})
        if not self.preload_state_path.exists():
            atomic_write_json(self.preload_state_path, self.preload_status_data)
        self.ensure_templates()

    def ensure_templates(self):
        patch_template = TEMPLATE_DIR / "patch_request.template.json"
        points_template = TEMPLATE_DIR / "patch_points.template.csv"
        if not patch_template.exists():
            atomic_write_json(patch_template, {
                "schema_version": 1,
                "package_id": "patch_YYYYMMDD_HHMMSS_type",
                "created_at": "ISO_TIME",
                "supplement_type": "field",
                "monitor_policy": "single_monitor_only",
                "source_run_id": "run_id",
                "source_run_path": "relative_path",
                "mother_structure": "",
                "perturbation": "",
                "reduction_path": "",
                "samples": [],
                "outputs": {},
                "status": "planned",
            })
        if not points_template.exists():
            points_template.write_text("sample_id,delta,lambda_nm,evidence_type,source_run_id,source_fsp,output_dir,priority,reason\n", encoding="utf-8")

    def safe_path(self, rel_path):
        rel = unquote(str(rel_path or "")).replace("/", "\\")
        if not rel or "\x00" in rel:
            raise ValueError("empty path")
        p = Path(rel)
        if p.is_absolute() or any(part == ".." for part in p.parts):
            raise ValueError("invalid path")
        target = (self.root / p).resolve()
        root_resolved = self.root.resolve()
        if target != root_resolved and root_resolved not in target.parents:
            raise ValueError("path outside project root")
        return target

    def bootstrap(self):
        meta = compact_index_meta(read_json(self.index_meta_path, {}), root=self.root)
        overview = read_json(self.overview_cache_path, empty_overview_cache())
        quality_full = read_json(self.quality_cache_path, {})
        quality_cache = {
            "schema_version": quality_full.get("schema_version", 2),
            "built_at": quality_full.get("built_at", ""),
            "serious_count": quality_full.get("serious_count", 0),
            "warning_count": quality_full.get("warning_count", 0),
            "missing_evidence_count": quality_full.get("missing_evidence_count", 0),
            "passed_count": quality_full.get("passed_count", 0),
            "rerun_suggested_count": quality_full.get("rerun_suggested_count", 0),
        }
        scripts = read_json(self.script_registry_path, {"scripts": []}).get("scripts", [])
        supplements = read_json(self.supplement_index_path, {"packages": []})
        stale = not bool(meta.get("built_at")) or bool(meta.get("stale"))
        # Compatibility shape for existing frontend modules while keeping L1 small.
        index_cache = {
            "schema_version": 2,
            "project_root": str(self.root),
            "built_at": meta.get("built_at", ""),
            "scan_duration_ms": meta.get("scan_duration_ms", 0),
            "summary": dict(overview.get("summary", {}), high_value_candidates=overview.get("top_candidates", [])[:10]),
            "groups": overview.get("groups", []),
            "runs": overview.get("recent_runs", [])[:10],
            "risks": overview.get("risks", [])[:10],
            "errors": [],
        }
        return {
            "ok": True,
            "stale": stale,
            "meta": meta,
            "overview": overview,
            "index_cache": index_cache,
            "script_summary": {"count": len(scripts), "built_at": read_json(self.script_registry_path, {}).get("built_at", "")},
            "script_registry": {"schema_version": 2, "built_at": read_json(self.script_registry_path, {}).get("built_at", ""), "scripts": scripts[:50]},
            "quality_cache": quality_cache,
            "supplement_index": {"schema_version": supplements.get("schema_version", 1), "built_at": supplements.get("built_at", ""), "packages": supplements.get("packages", [])[:10]},
        }

    def cache(self):
        return read_json(self.run_index_cache_path, {"runs": []})

    def scripts(self):
        return read_json(self.script_registry_path, {"scripts": []})

    def find_run(self, run_id):
        for run in read_json(self.run_index_cache_path, {"runs": []}).get("runs", []):
            if run.get("run_id") == run_id:
                return run
        return None

    def run_detail(self, run_id):
        run = self.find_run(run_id)
        if not run:
            return None
        cached = load_run_detail_cache(run_id)
        fp = run.get("fingerprint", {})
        if cached and cached.get("run", {}).get("fingerprint", {}).get("fingerprint") == fp.get("fingerprint"):
            return cached
        run_path = self.root / run.get("relative_path", "")
        if not run_path.exists():
            return {"schema_version": 2, "run": run, "samples": [], "files": [], "metrics": [], "quality_flags": [], "missing_evidence": run.get("missing_evidence", [])}
        detail = scan_run_detail(run_path, root=self.root, previous_detail=None)
        detail["run_id"] = run_id
        payload = save_run_detail_cache(self.root, detail, source_job_id=run.get("source_job_id"))
        return payload

    def start_scan(self, full_rebuild=False, confirm=False):
        if full_rebuild and not confirm:
            raise ValueError("full rebuild requires confirm=true")
        with self.scan_lock:
            if self.scan_status.get("running"):
                return self.scan_status
            self.scan_status = {
                "running": True,
                "progress": 1,
                "message": "后台扫描启动",
                "started_at": now_iso(),
                "completed_at": "",
                "error": "",
                "full_rebuild": bool(full_rebuild),
            }
            t = threading.Thread(target=self._scan_worker, args=(bool(full_rebuild),), name="fdtd-v2-scanner", daemon=True)
            t.start()
            return dict(self.scan_status)

    def _set_scan(self, progress, message):
        with self.scan_lock:
            self.scan_status["progress"] = progress
            self.scan_status["message"] = message

    def _scan_worker(self, full_rebuild=False):
        started = time.time()
        try:
            append_log(LOG_DIR / "scanner.log", "[%s] scan start" % now_iso())
            self._set_scan(10, "扫描目录 fingerprint")
            self._set_scan(35, "识别变化 run")
            self._set_scan(70, "局部更新缓存")
            result = refresh_index_job(self, full_rebuild=full_rebuild)
            meta = result["index_meta"]
            self._set_scan(100, "扫描完成")
            append_log(LOG_DIR / "scanner.log", "[%s] scan done %d ms" % (now_iso(), int((time.time() - started) * 1000)))
            with self.scan_lock:
                self.scan_status["running"] = False
                self.scan_status["completed_at"] = now_iso()
                self.scan_status["changed_runs"] = result.get("changed_runs", [])
                self.scan_status["counts"] = meta.get("counts", {})
        except Exception as exc:
            tb = traceback.format_exc()
            append_log(STATE_DIR / "scan_errors.log", tb)
            with self.scan_lock:
                self.scan_status["running"] = False
                self.scan_status["error"] = str(exc)
                self.scan_status["message"] = "扫描失败"

    def index_status(self):
        with self.scan_lock:
            return dict(self.scan_status)

    def record_cache_change(self, changed_runs, dirty_paths, overview_changed=True, job_id=None):
        data = read_json(self.cache_changes_path, {"schema_version": 1, "changes": []})
        changes = data.get("changes", [])
        changes.append({
            "changed_at": now_iso(),
            "job_id": job_id,
            "overview_changed": bool(overview_changed),
            "changed_runs": list(changed_runs or []),
            "dirty_paths": list(dirty_paths or []),
        })
        data["changes"] = changes[-200:]
        atomic_write_json(self.cache_changes_path, data)

    def cache_changes(self, since):
        data = read_json(self.cache_changes_path, {"changes": []})
        changes = []
        for item in data.get("changes", []):
            if not since or item.get("changed_at", "") >= since:
                changes.append(item)
        changed_runs = []
        dirty_paths = []
        overview_changed = False
        for item in changes:
            overview_changed = overview_changed or item.get("overview_changed", False)
            changed_runs.extend(item.get("changed_runs", []))
            dirty_paths.extend(item.get("dirty_paths", []))
        return {
            "schema_version": 1,
            "since": since,
            "overview_changed": overview_changed,
            "changed_runs": sorted(set(changed_runs)),
            "dirty_paths": sorted(set(dirty_paths)),
            "changes": changes,
        }

    def _paginate(self, items, query):
        page = max(1, int((query.get("page") or ["1"])[0] or 1))
        page_size = min(500, max(1, int((query.get("page_size") or ["100"])[0] or 100)))
        total = len(items)
        start = (page - 1) * page_size
        return {"page": page, "page_size": page_size, "total": total, "items": items[start:start + page_size]}

    def get_runs_page(self, query):
        items = list(read_json(self.run_index_cache_path, {"runs": []}).get("runs", []))
        q = ((query.get("query") or [""])[0] or "").lower()
        group = (query.get("group") or [""])[0]
        risk = (query.get("risk") or [""])[0]
        status = (query.get("status") or [""])[0]
        scope = (query.get("scope") or [""])[0]
        mother = (query.get("mother") or [""])[0]
        perturbation = (query.get("perturbation") or [""])[0]
        def is_old_run(run):
            text = "%s %s" % (run.get("relative_path", ""), run.get("archive_state", ""))
            low = text.lower()
            return "旧" in text or "旧文件" in text or "\\old" in low or "/old" in low or "archive" in low
        if q:
            items = [r for r in items if q in json.dumps(r, ensure_ascii=False).lower()]
        if scope == "current":
            items = [r for r in items if not is_old_run(r)]
        elif scope == "old":
            items = [r for r in items if is_old_run(r)]
        if group:
            items = [r for r in items if group in (r.get("group") or "")]
        if mother:
            items = [r for r in items if mother in (r.get("mother_structure") or "")]
        if perturbation:
            items = [r for r in items if perturbation in (r.get("perturbation") or "")]
        if risk:
            items = [r for r in items if risk == (r.get("risk") or r.get("risk_level"))]
        if status:
            items = [r for r in items if status == (r.get("status") or "")]
        out = self._paginate(items, query)
        out["runs"] = out["items"]
        return out

    def get_scripts_page(self, query):
        items = list(read_json(self.script_registry_path, {"scripts": []}).get("scripts", []))
        q = ((query.get("query") or [""])[0] or "").lower()
        if q:
            items = [s for s in items if q in json.dumps(s, ensure_ascii=False).lower()]
        out = self._paginate(items, query)
        out["scripts"] = out["items"]
        return out

    def get_resources_page(self, query):
        data = read_json(self.resource_index_light_path, {"items": []})
        items = list(data.get("items") or data.get("files") or [])
        q = ((query.get("query") or [""])[0] or "").lower()
        kind = (query.get("kind") or [""])[0]
        run_id = (query.get("run_id") or [""])[0]
        if q:
            items = [r for r in items if q in json.dumps(r, ensure_ascii=False).lower()]
        if kind:
            items = [r for r in items if kind in (r.get("kind") or r.get("extension") or "")]
        if run_id:
            run = self.find_run(run_id)
            prefix = run.get("relative_path", "") if run else ""
            items = [r for r in items if prefix and str(r.get("relative_path", "")).startswith(prefix)]
        out = self._paginate(items, query)
        out["resources"] = out["items"]
        out["files"] = out["items"]
        return out

    def cache_chunk(self, name, query):
        if name == "run_index":
            return self.get_runs_page(query)
        if name in ("scripts", "script_registry"):
            return self.get_scripts_page(query)
        if name in ("resources", "resource_index_light"):
            return self.get_resources_page(query)
        if name == "spectra":
            items = read_json(self.spectra_index_path, {"items": []}).get("items", [])
            out = self._paginate(items, query)
            out["spectra"] = out["items"]
            return out
        if name == "quality":
            return read_json(self.quality_cache_path, {})
        if name == "overview":
            return read_json(self.overview_cache_path, empty_overview_cache())
        raise ValueError("unknown cache chunk: " + str(name))

    def preload_start(self, payload=None):
        payload = payload or {}
        queue = payload.get("queue") or [
            "run_index",
            "script_registry",
            "quality_cache",
            "supplement_index",
            "resource_index_light",
            "recent_run_details",
            "top_candidate_spectra",
            "resource_index_full",
            "remaining_spectrum_cache",
        ]
        self.preload_status_data = {
            "running": True,
            "started_at": now_iso(),
            "completed_at": "",
            "progress": 0,
            "queue": queue,
            "current": "",
            "counts": self.index_counts(),
        }
        atomic_write_json(self.preload_state_path, self.preload_status_data)
        return dict(self.preload_status_data)

    def preload_status(self):
        return read_json(self.preload_state_path, self.preload_status_data)

    def preload_next(self, kind, limit):
        limit = max(1, min(100, int(limit or 10)))
        status = self.preload_status()
        status["current"] = kind
        if kind == "run_details":
            runs = read_json(self.run_index_cache_path, {"runs": []}).get("runs", [])
            built = 0
            items = []
            for run in runs:
                if built >= limit:
                    break
                run_id = run.get("run_id")
                if not run_id:
                    continue
                cached = load_run_detail_cache(run_id)
                if cached:
                    continue
                detail = self.run_detail(run_id)
                if detail:
                    items.append(run_id)
                    built += 1
            status["counts"]["run_details_built"] = status["counts"].get("run_details_built", 0) + built
            status["progress"] = min(99, status.get("progress", 0) + 3)
            atomic_write_json(self.preload_state_path, status)
            return {"kind": kind, "built": built, "items": items, "status": status}
        if kind == "spectra":
            spectra = read_json(self.spectra_index_path, {"items": []}).get("items", [])
            built = 0
            items = []
            for item in spectra:
                if built >= limit:
                    break
                if item.get("cache_valid"):
                    continue
                try:
                    load_or_build_spectrum_cache(item, root=self.root)
                    items.append(item.get("spectrum_id"))
                    built += 1
                except Exception as exc:
                    append_log(STATE_DIR / "scan_errors.log", "preload spectrum failed %s: %s" % (item.get("relative_path"), exc))
            status["counts"]["spectra_built"] = status["counts"].get("spectra_built", 0) + built
            status["progress"] = min(99, status.get("progress", 0) + 2)
            atomic_write_json(self.preload_state_path, status)
            return {"kind": kind, "built": built, "items": items, "status": status}
        status["progress"] = min(99, status.get("progress", 0) + 1)
        atomic_write_json(self.preload_state_path, status)
        return {"kind": kind, "built": 0, "items": [], "status": status}

    def index_counts(self):
        meta = read_json(self.index_meta_path, {})
        counts = meta.get("counts") or {}
        if counts:
            return counts
        return {
            "runs": len(read_json(self.run_index_cache_path, {"runs": []}).get("runs", [])),
            "scripts": len(read_json(self.script_registry_path, {"scripts": []}).get("scripts", [])),
            "spectra": len(read_json(self.spectra_index_path, {"items": []}).get("items", [])),
            "files": len(read_json(self.resource_index_light_path, {"items": []}).get("items", [])),
        }

    def files_preview(self, rel_path):
        path = self.safe_path(rel_path)
        if not path.exists() or not path.is_file():
            raise ValueError("file not found")
        kind = file_kind(path)
        stat = path.stat()
        base = {
            "relative_path": slash(rel_to(self.root, path)),
            "kind": kind,
            "size": stat.st_size,
            "mtime": iso_mtime(path),
        }
        if kind == "image":
            base["url"] = "/api/v2/files/raw?path=" + quote(rel_to(self.root, path).replace("\\", "/"))
            return base
        if kind == "fsp":
            return base
        if kind == "xlsx":
            base["sheets"] = sheet_names_from_xlsx(path)
            base["rows"] = xlsx_first_sheet_rows(path)
            return base
        if kind in ("csv", "json", "md", "txt", "log", "py"):
            with open(str(path), "r", encoding="utf-8-sig", errors="replace") as f:
                base["text"] = f.read(TEXT_PREVIEW_LIMIT)
            if stat.st_size > TEXT_PREVIEW_LIMIT:
                base["truncated"] = True
            return base
        base["text"] = "该文件类型暂不读取内容，只登记路径、大小和 mtime。"
        return base

    def raw_file(self, rel_path):
        path = self.safe_path(rel_path)
        if not path.exists() or not path.is_file():
            raise ValueError("file not found")
        return path

    def open_project_file(self, rel_path):
        path = self.safe_path(rel_path)
        if not path.exists() or not path.is_file():
            raise ValueError("file not found")
        if path.suffix.lower() != ".fsp":
            raise ValueError("only .fsp direct open is enabled")
        if os.name != "nt" or not hasattr(os, "startfile"):
            raise ValueError("open file is only available on Windows")
        os.startfile(str(path))
        return {"ok": True, "path": slash(rel_to(self.root, path))}

    def open_project_folder(self, rel_path):
        path = self.safe_path(rel_path)
        target = path if path.is_dir() else path.parent
        if not target.exists():
            raise ValueError("folder not found")
        if os.name != "nt" or not hasattr(os, "startfile"):
            raise ValueError("open folder is only available on Windows")
        os.startfile(str(target))
        return {"ok": True, "path": slash(rel_to(self.root, target))}

    def run_files(self, run_id):
        run = self.find_run(run_id)
        if not run:
            raise ValueError("run not found")
        return {"run_id": run_id, "files": list_run_files(self.root, run)}

    def run_samples(self, run_id):
        detail = self.run_detail(run_id)
        if not detail:
            raise ValueError("run not found")
        return {"run_id": run_id, "samples": detail.get("samples", [])}

    def save_peak_selection(self, payload):
        run_id = payload.get("run_id")
        sample_id = str(payload.get("sample_id") or "")
        kind = (payload.get("kind") or "T").upper()
        lambda_min = numeric(payload.get("lambda_min"))
        lambda_max = numeric(payload.get("lambda_max"))
        if not run_id or lambda_min is None or lambda_max is None:
            raise ValueError("run_id, lambda_min and lambda_max are required")
        if lambda_min > lambda_max:
            lambda_min, lambda_max = lambda_max, lambda_min
        run = self.find_run(run_id)
        if not run:
            raise ValueError("run not found")
        spectra = read_json(self.spectra_index_path, {"items": []}).get("items", [])
        item = next((s for s in spectra if s.get("run_id") == run_id and s.get("kind", "").upper() == kind and (not sample_id or str(s.get("sample_id")) == sample_id)), None)
        if not item:
            candidates = scan_spectrum_index({"run_id": run_id, "relative_path": run.get("relative_path")}, root=self.root)
            item = next((s for s in candidates if s.get("kind", "").upper() == kind and (not sample_id or str(s.get("sample_id")) == sample_id)), None)
        if not item:
            raise ValueError("spectrum not found for selected sample")
        spectrum = load_or_build_spectrum_cache(item, root=self.root)
        pairs = [
            (numeric(x), numeric(y))
            for x, y in zip(spectrum.get("lambda_nm", []), spectrum.get("value", []))
            if numeric(x) is not None and numeric(y) is not None and lambda_min <= numeric(x) <= lambda_max
        ]
        if len(pairs) < 3:
            raise ValueError("selected λ range has too few points")
        metrics = extract_metrics_from_spectrum([p[0] for p in pairs], [p[1] for p in pairs])
        record = {
            "selection_id": "peak_" + now_stamp() + "_" + hashlib.sha1(("%s|%s|%s|%s" % (run_id, sample_id, lambda_min, lambda_max)).encode("utf-8", errors="replace")).hexdigest()[:8],
            "created_at": now_iso(),
            "run_id": run_id,
            "sample_id": item.get("sample_id") or sample_id,
            "kind": kind,
            "lambda_min_nm": lambda_min,
            "lambda_max_nm": lambda_max,
            "source_path": item.get("relative_path"),
            "metrics": metrics,
            "note": payload.get("note") or "用户在 V2 页面框选峰区后计算",
        }
        run_path = self.root / run.get("relative_path", "")
        summary_dir = run_path / "12_analysis_summary"
        summary_dir.mkdir(parents=True, exist_ok=True)
        target = summary_dir / "v2_peak_selections.json"
        data = load_json_safe(target, {"schema_version": 1, "selections": []})
        data["selections"] = [x for x in data.get("selections", []) if x.get("selection_id") != record["selection_id"]]
        data["selections"].insert(0, record)
        data["updated_at"] = now_iso()
        save_json_atomic(target, data)
        return {"ok": True, "selection": record, "relative_path": slash(rel_to(self.root, target))}

    def controller_preview(self, payload):
        ids = payload.get("ids") or []
        if isinstance(ids, str):
            ids = [x.strip() for x in ids.split(",") if x.strip()]
        mode = payload.get("mode") or "preview"
        style = payload.get("style") or "sequential"
        max_parallel = int(payload.get("max_parallel") or 2)
        points = self._estimate_points(payload.get("overrides") or {})
        command = self._controller_command(ids, mode, style, max_parallel, "<overrides-json>", payload.get("child_timeout_s") or 3600)
        manifest = create_job_manifest({**payload, "ids": ids, "mode": mode, "style": style}, script_registry=read_json(self.script_registry_path, {"scripts": []}))
        return {
            "ok": True,
            "command": command,
            "job_preview": {
                "mode": mode,
                "style": style,
                "script_count": len(ids),
                "estimated_points": points or "按脚本默认",
                "estimated_runtime": self._estimate_duration(points, len(ids), style, max_parallel),
                "expected_outputs": manifest.get("expected_outputs", []),
                "probable_output_parents": manifest.get("probable_output_parents", []),
            },
            "estimated_points": points or "按脚本默认",
            "estimated_duration": self._estimate_duration(points, len(ids), style, max_parallel),
            "warnings": ["full + parallel 需要二次确认"] if mode == "full" and style == "parallel" else [],
            "controller_args": ["--mode", "--style", "--max-parallel", "--ids", "--overrides-json", "--child-timeout-s", "--yes"],
        }

    def _estimate_points(self, overrides):
        wildcard = overrides.get("*", {}) if isinstance(overrides, dict) else {}
        start = numeric(wildcard.get("START_NM"))
        end = numeric(wildcard.get("END_NM"))
        step = numeric(wildcard.get("STEP_NM"))
        if start is None or end is None or step in (None, 0):
            return None
        return int(abs(end - start) / abs(step)) + 1

    def _estimate_duration(self, points, count, style, max_parallel):
        if not points:
            return "无法估算，使用脚本默认扫描参数"
        seconds = points * max(1, count) * 240
        if style == "parallel":
            seconds = seconds / max(1, max_parallel)
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return "%dh %02dm（粗估，按每点 4 分钟）" % (hours, minutes)

    def _controller_command(self, ids, mode, style, max_parallel, overrides_path, child_timeout_s):
        controller = self.root / "fdtd_master_controller.py"
        cmd = [
            sys.executable,
            str(controller),
            "--mode",
            mode,
            "--style",
            style,
            "--max-parallel",
            str(max_parallel),
            "--ids",
            ",".join(str(x) for x in ids),
            "--overrides-json",
            str(overrides_path),
            "--child-timeout-s",
            str(child_timeout_s),
            "--yes",
        ]
        return cmd

    def controller_start(self, payload):
        ids = payload.get("ids") or []
        if isinstance(ids, str):
            ids = [x.strip() for x in ids.split(",") if x.strip()]
        if not ids:
            raise ValueError("no script ids selected")
        mode = payload.get("mode") or "preview"
        style = payload.get("style") or "sequential"
        if mode == "full" and style == "parallel" and not payload.get("risk_ack"):
            raise ValueError("full + parallel requires risk_ack")
        if not payload.get("confirm"):
            raise ValueError("start requires explicit confirm")
        job_id = "job_" + now_stamp() + "_" + hashlib.sha1(",".join(map(str, ids)).encode("utf-8")).hexdigest()[:6]
        job_dir = JOBS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        manifest = create_job_manifest({**payload, "ids": ids, "mode": mode, "style": style}, job_id=job_id, script_registry=read_json(self.script_registry_path, {"scripts": []}))
        snapshot_paths = manifest.get("probable_output_parents", []) + [x.get("relative_path") for x in manifest.get("expected_outputs", [])]
        before_snapshot = take_path_snapshot(self.root, snapshot_paths)
        save_json_atomic(job_dir / "before_snapshot.json", before_snapshot)
        overrides_path = job_dir / "overrides.json"
        atomic_write_json(overrides_path, payload.get("overrides") or {})
        cmd = self._controller_command(ids, mode, style, int(payload.get("max_parallel") or 2), overrides_path, payload.get("child_timeout_s") or 3600)
        manifest["command"] = " ".join('"%s"' % c if " " in str(c) else str(c) for c in cmd)
        manifest["status"] = "running"
        save_json_atomic(job_dir / "job_manifest.json", manifest)
        (job_dir / "command.txt").write_text(manifest["command"], encoding="utf-8")
        stdout_path = job_dir / "stdout.log"
        stderr_path = job_dir / "stderr.log"
        stdout = open(str(stdout_path), "wb")
        stderr = open(str(stderr_path), "wb")
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        process = subprocess.Popen(
            cmd,
            cwd=str(self.root),
            stdout=stdout,
            stderr=stderr,
            stdin=subprocess.DEVNULL,
            env=env,
            creationflags=creationflags,
        )
        job = {
            "job_id": job_id,
            "pid": process.pid,
            "status": "running",
            "started_at": now_iso(),
            "completed_at": "",
            "returncode": None,
            "command": cmd,
            "stdout": slash(rel_to(WEB_DIR, stdout_path)),
            "stderr": slash(rel_to(WEB_DIR, stderr_path)),
            "manifest_path": slash(rel_to(WEB_DIR, job_dir / "job_manifest.json")),
            "created_at": manifest["created_at"],
            "mode": mode,
            "style": style,
            "ids": ids,
            "probable_output_parents": manifest.get("probable_output_parents", []),
        }
        self.jobs[job_id] = {"process": process, "stdout_handle": stdout, "stderr_handle": stderr, "state": job}
        self._persist_jobs()
        threading.Thread(target=self._watch_job, args=(job_id,), daemon=True).start()
        return {"ok": True, **job}

    def _watch_job(self, job_id):
        entry = self.jobs.get(job_id)
        if not entry:
            return
        process = entry["process"]
        rc = process.wait()
        try:
            entry["stdout_handle"].close()
            entry["stderr_handle"].close()
        except Exception:
            pass
        entry["state"]["status"] = "stopped" if entry["state"].get("status") == "stopping" else ("success" if rc == 0 else "failed")
        entry["state"]["returncode"] = rc
        entry["state"]["completed_at"] = now_iso()
        job_dir = JOBS_DIR / job_id
        manifest = load_json_safe(job_dir / "job_manifest.json", {})
        manifest["status"] = entry["state"]["status"]
        manifest["finished_at"] = entry["state"]["completed_at"]
        manifest["returncode"] = rc
        paths = manifest.get("probable_output_parents", []) + [x.get("relative_path") for x in manifest.get("expected_outputs", [])]
        after = take_path_snapshot(self.root, paths)
        save_json_atomic(job_dir / "after_snapshot.json", after)
        before = load_json_safe(job_dir / "before_snapshot.json", {"items": []})
        delta = diff_snapshots(before, after)
        delta["job_id"] = job_id
        save_json_atomic(job_dir / "delta_files.json", delta)
        manifest["created_files"] = delta.get("created_files", [])
        manifest["modified_files"] = delta.get("modified_files", [])
        manifest["deleted_files"] = delta.get("deleted_files", [])
        manifest["dirty_paths"] = delta.get("dirty_paths", [])
        manifest["cache_update_status"] = "pending"
        save_json_atomic(job_dir / "job_manifest.json", manifest)
        try:
            refresh_delta_from_job(self, job_id)
        except Exception as exc:
            manifest["cache_update_status"] = "failed"
            manifest["cache_update_error"] = str(exc)
            save_json_atomic(job_dir / "job_manifest.json", manifest)
            append_log(STATE_DIR / "scan_errors.log", "refresh_delta_from_job failed %s: %s" % (job_id, exc))
        self._persist_jobs()

    def _persist_jobs(self):
        existing = read_json(self.job_state_path, {"jobs": []}).get("jobs", [])
        by_id = {j.get("job_id"): j for j in existing}
        for entry in self.jobs.values():
            by_id[entry["state"]["job_id"]] = entry["state"]
        jobs = sorted(by_id.values(), key=lambda x: x.get("started_at", ""), reverse=True)
        atomic_write_json(self.job_state_path, {"schema_version": 1, "built_at": now_iso(), "jobs": jobs[:100]})

    def job_list(self):
        return read_json(self.job_state_path, {"jobs": []})

    def job_state(self, job_id):
        for job in self.job_list().get("jobs", []):
            if job.get("job_id") == job_id:
                return job
        raise ValueError("job not found")

    def job_log(self, job_id):
        job = self.job_state(job_id)
        stdout = WEB_DIR / job.get("stdout", "")
        stderr = WEB_DIR / job.get("stderr", "")
        text = ""
        for label, path in (("stdout", stdout), ("stderr", stderr)):
            if path.exists():
                try:
                    content = decode_mixed_log(path.read_bytes())[-12000:]
                    if content:
                        text += "\n[%s]\n%s" % (label, content)
                except Exception:
                    pass
        return {"job_id": job_id, "text": text.strip(), "status": job.get("status")}

    def stop_job(self, job_id):
        entry = self.jobs.get(job_id)
        if not entry:
            job = self.job_state(job_id)
            if job.get("status") not in ("running", "stopping"):
                return job
            raise ValueError("running process is not attached to this server session")
        process = entry["process"]
        entry["state"]["status"] = "stopping"
        if os.name == "nt":
            subprocess.call(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            process.terminate()
        self._persist_jobs()
        return entry["state"]

    def diagnostics_run(self, run_id):
        detail = self.run_detail(run_id)
        if not detail:
            raise ValueError("run not found")
        run = detail.get("run", detail)
        return {
            "run_id": run_id,
            "group": run.get("group"),
            "mother_structure": run.get("mother_structure"),
            "perturbation": run.get("perturbation"),
            "reduction_path": run.get("reduction_path"),
            "objective": "score/Q/FWHM/max(T) 综合评分",
            "evidence_completeness": self._evidence_completeness(run),
            "best_score": run.get("score"),
            "lambda0_nm": run.get("lambda0_nm"),
            "q": run.get("q"),
            "fwhm_nm": run.get("fwhm_nm"),
            "quality_status": run.get("risk_label"),
            "next_actions": self._next_actions(run),
        }

    def _evidence_completeness(self, run):
        ev = run.get("evidence") or {}
        if not ev:
            return 0
        return len([v for v in ev.values() if v]) / float(len(ev))

    def _next_actions(self, run):
        actions = []
        missing = run.get("missing_evidence") or []
        if missing:
            actions.append("补齐证据：" + "、".join(missing))
        if "T > 1" in (run.get("quality_flags") or []):
            actions.append("用 test 模式复核 T > 1 样本并检查归一化。")
        if not actions:
            actions.append("可进入模式接力页观察 T(λ,δ) 热图与峰位轨迹。")
        return actions

    def diagnostics_spectrum(self, run_id, sample_id, kind):
        run = self.find_run(run_id)
        if not run:
            raise ValueError("run not found")
        kind = (kind or "T").upper()
        spectra = read_json(self.spectra_index_path, {"items": []}).get("items", [])
        item = next((s for s in spectra if s.get("run_id") == run_id and s.get("kind", "").upper() == kind and (not sample_id or s.get("sample_id") == sample_id)), None)
        if not item:
            detail = self.run_detail(run_id)
            run_path = self.root / run["relative_path"]
            raw_detail = {"run_id": run_id, "relative_path": run["relative_path"]}
            candidates = scan_spectrum_index(raw_detail, root=self.root)
            item = next((s for s in candidates if s.get("kind", "").upper() == kind), None)
            if item:
                old = read_json(self.spectra_index_path, {"items": []})
                old["items"] = old.get("items", []) + [item]
                save_json_atomic(self.spectra_index_path, old)
        if not item:
            return {"run_id": run_id, "sample_id": sample_id, "kind": kind, "source": "", "points": []}
        spectrum = load_or_build_spectrum_cache(item, root=self.root)
        points = sample_points(list(zip(spectrum.get("lambda_nm", []), spectrum.get("value", []))))
        return {"run_id": run_id, "sample_id": item.get("sample_id"), "kind": kind, "source": item.get("relative_path"), "points": points, "metrics": spectrum.get("metrics", {})}

    def diagnostics_trend(self, run_id):
        detail = self.run_detail(run_id)
        if not detail:
            raise ValueError("run not found")
        run = detail.get("run", detail)
        points = list(detail.get("metrics") or run.get("trend_points") or [])
        if not points:
            run_path = self.root / run["relative_path"]
            _, rows = read_metrics(run_path)
            points = trend_points_from_rows(rows)[:240]
        if not points:
            run_path = self.root / run["relative_path"]
            for idx, path in enumerate(find_spectrum_files(run_path, "T")[:80]):
                try:
                    spec = scan_spectrum_file(path)
                    metrics = spec.get("metrics") or {}
                    points.append({"delta": infer_delta_from_text(path.name, idx), "score": metrics.get("score") or 0, "q": metrics.get("Q") or 0, "fwhm_nm": metrics.get("FWHM_nm") or 0})
                except Exception:
                    pass
        return {"run_id": run_id, "points": points}

    def diagnostics_quality(self, run_id):
        detail = self.run_detail(run_id)
        if not detail:
            raise ValueError("run not found")
        run = detail.get("run", detail)
        records = detail.get("quality_flags", [])
        if records and isinstance(records[0], str):
            records = run.get("quality_flag_records", [])
        if not records:
            quality = load_json_safe(self.quality_cache_path, {})
            records = (quality.get("runs", {}).get(run_id, {}) or {}).get("flags", [])
        flag_names = [f.get("flag") for f in records if isinstance(f, dict)]
        return {"run_id": run_id, "flags": flag_names, "flag_records": records, "risk_level": run.get("risk_level") or run.get("risk")}

    def mode_relay(self, run_id):
        detail = self.run_detail(run_id) if run_id else None
        run = detail.get("run", detail) if detail else None
        if not run:
            run = (self.cache().get("runs") or [{}])[0]
        gaps = ["k-space 扫描", "带隙演化", "相位连续性", "缠绕数验证"]
        if run.get("missing_evidence"):
            gaps = run.get("missing_evidence") + gaps
        rows = (detail.get("metrics") if detail else None) or run.get("trend_points") or []
        track = []
        for idx, row in enumerate(rows[:80]):
            lam = numeric(row.get("lambda0_nm") or row.get("lambda_peak_nm") or row.get("peak_nm"))
            if lam is not None:
                track.append({"delta": numeric(row.get("delta")) if numeric(row.get("delta")) is not None else idx, "lambda_nm": lam})
        if not track:
            run_path = self.root / run.get("relative_path", "")
            for idx, path in enumerate(find_spectrum_files(run_path, "T")[:80]):
                spec = scan_spectrum_file(path)
                metrics = spec.get("metrics") or {}
                if metrics.get("lambda0_nm") is not None:
                    track.append({"delta": infer_delta_from_text(path.name, idx), "lambda_nm": metrics.get("lambda0_nm"), "Q": metrics.get("Q")})
        return {
            "run_id": run.get("run_id", ""),
            "candidate_strength": run.get("score") or 0,
            "critical_interval": "待识别" if not rows else "按谱峰跃迁区间候选",
            "representative_sample_count": len(track),
            "evidence_gaps": gaps,
            "track": track,
            "todo": ["补 angle-resolved / k-space 扫描", "补相位连续性与 Poynting 证据", "只写候选，不写作已证明拓扑态"],
        }

    def mode_relay_heatmap(self, run_id):
        run = self.find_run(run_id) if run_id else None
        if not run:
            return {"run_id": run_id, "x_label": "lambda_nm", "y_label": "delta", "values": [], "lambda_grid": [], "deltas": []}
        run_path = self.root / run.get("relative_path", "")
        spectra = []
        for idx, path in enumerate(find_spectrum_files(run_path, "T")[:80]):
            spec = scan_spectrum_file(path)
            if spec.get("lambda_nm") and spec.get("T"):
                spectra.append({
                    "delta": infer_delta_from_text(path.name, idx),
                    "lambda_nm": spec["lambda_nm"],
                    "T": spec["T"],
                })
        if not spectra:
            return {"run_id": run_id, "x_label": "lambda_nm", "y_label": "delta", "values": [], "lambda_grid": [], "deltas": []}
        low = max(min(s["lambda_nm"]) for s in spectra)
        high = min(max(s["lambda_nm"]) for s in spectra)
        if high <= low:
            return {"run_id": run_id, "x_label": "lambda_nm", "y_label": "delta", "values": [], "lambda_grid": [], "deltas": []}
        cols = min(96, max(16, min(len(s["lambda_nm"]) for s in spectra)))
        step = (high - low) / float(cols - 1)
        grid = [low + i * step for i in range(cols)]
        all_values = []
        for spec in spectra:
            all_values.extend([v for v in spec["T"] if numeric(v) is not None])
        vmin = min(all_values) if all_values else 0
        vmax = max(all_values) if all_values else 1
        denom = (vmax - vmin) or 1.0
        rows = []
        deltas = []
        for spec in sorted(spectra, key=lambda s: s["delta"]):
            interpolated = interpolate_series(spec["lambda_nm"], spec["T"], grid)
            rows.append([None if v is None else round((v - vmin) / denom, 4) for v in interpolated])
            deltas.append(spec["delta"])
        return {"run_id": run_id, "x_label": "lambda_nm", "y_label": "delta", "values": rows, "lambda_grid": grid, "deltas": deltas}

    def mode_relay_candidates(self, group):
        runs = self.cache().get("runs", [])
        if group:
            runs = [r for r in runs if group in (r.get("group") or "")]
        candidates = sorted(runs, key=lambda r: (r.get("score") if r.get("score") is not None else -1), reverse=True)[:20]
        return {"candidates": [{
            "run_id": r.get("run_id"),
            "group": r.get("group"),
            "mother_structure": r.get("mother_structure"),
            "perturbation": r.get("perturbation"),
            "candidate_strength": r.get("score") or 0,
        } for r in candidates]}

    def supplement_missing(self):
        items = []
        for run in self.cache().get("runs", []):
            flags = run.get("quality_flag_records") or []
            flag_names = [f.get("flag") for f in flags]
            needs = bool(run.get("missing_evidence")) or any(name in flag_names for name in ("T > 1", "FWHM 不可靠")) or (run.get("score") or 0) > 0 and run.get("missing_evidence")
            if not needs:
                continue
            samples = build_samples_for_run(self.root, run)[:12]
            for sample in samples:
                missing = sample.get("missing_evidence") or run.get("missing_evidence") or []
                priority = "低"
                reason = "普通证据补全"
                if "T > 1" in flag_names or "FWHM 不可靠" in flag_names:
                    priority = "高"
                    reason = "质量旗标需要复核"
                elif any(x in missing for x in ("Field", "Phase", "Poynting")) and (run.get("score") or 0) > 0:
                    priority = "高"
                    reason = "高价值候选缺少场/相位/Poynting 证据"
                elif any(x in missing for x in ("R", "A")):
                    priority = "中"
                    reason = "缺少 R/A 谱线补证"
                items.append({
                    "run_id": run.get("run_id"),
                    "run_name": run.get("run_name"),
                    "source_run_path": run.get("relative_path"),
                    "group": run.get("group"),
                    "mother_structure": run.get("mother_structure"),
                    "perturbation": run.get("perturbation"),
                    "reduction_path": run.get("reduction_path"),
                    "sample_id": sample.get("sample_id"),
                    "delta": sample.get("delta"),
                    "lambda0_nm": sample.get("lambda0_nm") or run.get("lambda0_nm"),
                    "Q": sample.get("Q") or sample.get("q") or run.get("q"),
                    "FWHM_nm": sample.get("FWHM_nm") or sample.get("fwhm_nm") or run.get("fwhm_nm"),
                    "score": sample.get("score") or run.get("score"),
                    "missing_evidence": missing,
                    "source_fsp": sample.get("source_fsp", ""),
                    "priority": priority,
                    "reason": reason,
                })
        return {"items": items}

    def create_supplement_package(self, payload):
        samples = payload.get("samples") or []
        if not samples:
            raise ValueError("no supplement samples")
        supplement_type = payload.get("supplement_type") or "field"
        monitor_policy = payload.get("monitor_policy") or "single_monitor_only"
        first = samples[0]
        source_run_path = first.get("source_run_path") or ""
        run = self.find_run(first.get("run_id")) or {}
        perturbation = first.get("perturbation") or run.get("perturbation") or "未分类扰动"
        package_id = "patch_%s_%s" % (now_stamp(), safe_token(supplement_type))
        base_root = None
        if source_run_path and "results" in Path(source_run_path).parts:
            parts = Path(source_run_path).parts
            idx = parts.index("results")
            if idx + 1 < len(parts):
                base_root = self.root / Path(*parts[:idx + 2]) / "补做实验"
        if base_root is None:
            base_root = GENERATED_DIR / "supplement_requests"
        package_root = base_root / package_id
        dirs = [
            "00_patch_plan",
            "01_patch_fsp",
            "04_logs",
            "06_reflection_excel",
            "07_absorption_excel",
            "08_field_data",
            "09_phase_data",
            "10_poynting_data",
            "12_patch_summary",
        ]
        for d in dirs:
            (package_root / d).mkdir(parents=True, exist_ok=True)
        manual = [numeric(x) for x in re.split(r"[,，\s]+", str(payload.get("manual_lambdas_nm") or "")) if x.strip()]
        manual = [x for x in manual if x is not None]
        request_samples = []
        csv_rows = []
        for idx, sample in enumerate(samples):
            lam = numeric(sample.get("lambda0_nm"))
            if manual:
                lambdas = manual
            elif lam is not None:
                lambdas = [round(lam, 4), round(lam - 0.5, 4), round(lam + 0.5, 4)]
            else:
                lambdas = []
            request_sample = {
                "sample_id": sample.get("sample_id") or "#%d" % (idx + 1),
                "delta": sample.get("delta"),
                "lambda_targets_nm": lambdas,
                "missing_evidence": sample.get("missing_evidence") or [supplement_type],
                "source_fsp": sample.get("source_fsp") or "",
            }
            request_samples.append(request_sample)
            for lam_value in lambdas or [""]:
                csv_rows.append({
                    "sample_id": request_sample["sample_id"],
                    "delta": request_sample["delta"],
                    "lambda_nm": lam_value,
                    "evidence_type": supplement_type,
                    "source_run_id": sample.get("run_id"),
                    "source_fsp": request_sample["source_fsp"],
                    "output_dir": self._output_dir_for_type(supplement_type),
                    "priority": "high" if idx < 3 else "normal",
                    "reason": "missing evidence: " + ",".join(request_sample["missing_evidence"]),
                })
        request = {
            "schema_version": 1,
            "package_id": package_id,
            "created_at": now_iso(),
            "supplement_type": supplement_type,
            "monitor_policy": monitor_policy,
            "lambda_policy": payload.get("lambda_policy") or "peak_triplet",
            "source_run_id": first.get("run_id"),
            "source_run_path": first.get("source_run_path"),
            "mother_structure": first.get("mother_structure") or run.get("mother_structure"),
            "perturbation": perturbation,
            "reduction_path": first.get("reduction_path") or run.get("reduction_path"),
            "samples": request_samples,
            "outputs": {
                "root": slash(rel_to(package_root.parent, package_root)),
                "field_dir": "08_field_data",
                "summary_dir": "12_patch_summary",
            },
            "status": "planned",
        }
        atomic_write_json(package_root / "patch_request.json", request)
        atomic_write_json(package_root / "source_links.json", {"source_run_path": source_run_path, "source_run_id": first.get("run_id"), "samples": samples})
        with open(str(package_root / "00_patch_plan" / "patch_points.csv"), "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["sample_id", "delta", "lambda_nm", "evidence_type", "source_run_id", "source_fsp", "output_dir", "priority", "reason"])
            writer.writeheader()
            writer.writerows(csv_rows)
        index = read_json(self.supplement_index_path, {"schema_version": 1, "packages": []})
        item = {
            "package_id": package_id,
            "created_at": request["created_at"],
            "supplement_type": supplement_type,
            "type": supplement_type,
            "status": "planned",
            "source_run_id": first.get("run_id"),
            "source_job_id": first.get("source_job_id") or run.get("source_job_id"),
            "relative_path": slash(rel_to(self.root, package_root)) if self.root in package_root.resolve().parents else str(package_root),
            "output_root": slash(rel_to(self.root, package_root)) if self.root in package_root.resolve().parents else str(package_root),
            "expected_outputs": [
                {"kind": supplement_type, "relative_path": slash(rel_to(self.root, package_root / self._output_dir_for_type(supplement_type)))}
            ],
        }
        packages = [p for p in index.get("packages", []) if p.get("package_id") != package_id]
        packages.insert(0, item)
        index["built_at"] = now_iso()
        index["packages"] = packages
        atomic_write_json(self.supplement_index_path, index)
        return item

    def _output_dir_for_type(self, supplement_type):
        return {
            "R": "06_reflection_excel",
            "A": "07_absorption_excel",
            "field": "08_field_data",
            "phase": "09_phase_data",
            "poynting": "10_poynting_data",
            "angle-resolved": "12_patch_summary",
            "band sweep": "12_patch_summary",
        }.get(supplement_type, "12_patch_summary")

    def supplement_packages(self):
        return read_json(self.supplement_index_path, {"packages": []})

    def supplement_package(self, package_id):
        for item in self.supplement_packages().get("packages", []):
            if item.get("package_id") == package_id:
                return item
        raise ValueError("package not found")

    def delete_supplement_package(self, package_id):
        if not str(package_id).startswith("patch_"):
            raise ValueError("only V2 patch packages can be deleted")
        index = read_json(self.supplement_index_path, {"schema_version": 1, "packages": []})
        packages = index.get("packages", [])
        item = next((p for p in packages if p.get("package_id") == package_id), None)
        if not item:
            raise ValueError("package not found")
        rel = item.get("relative_path") or item.get("output_root") or ""
        package_root = self.safe_path(rel)
        if not package_root.exists() or not package_root.is_dir():
            packages = [p for p in packages if p.get("package_id") != package_id]
            index["packages"] = packages
            index["built_at"] = now_iso()
            atomic_write_json(self.supplement_index_path, index)
            return {"ok": True, "deleted": False, "package_id": package_id, "message": "index entry removed; folder was missing"}
        marker = package_root / "patch_request.json"
        if not marker.exists():
            raise ValueError("refuse to delete folder without patch_request.json")
        shutil.rmtree(str(package_root))
        packages = [p for p in packages if p.get("package_id") != package_id]
        index["packages"] = packages
        index["built_at"] = now_iso()
        atomic_write_json(self.supplement_index_path, index)
        return {"ok": True, "deleted": True, "package_id": package_id}

    def refresh_scripts_only(self):
        runs = read_json(self.run_index_cache_path, {"runs": []}).get("runs", [])
        scripts = scan_scripts(self.root, previous_registry=read_json(self.script_registry_path, {}), runs=runs)
        registry = {"schema_version": 2, "built_at": now_iso(), "scripts": scripts}
        atomic_write_json(self.script_registry_path, registry)
        overview = build_overview_cache(read_json(self.run_index_cache_path, {"runs": []}), registry, read_json(self.quality_cache_path, {}), read_json(self.supplement_index_path, {"packages": []}))
        atomic_write_json(self.overview_cache_path, overview)
        return registry

    def result_manager_dry_run(self):
        manager = self.root / "fdtd_results_manager.py"
        if not manager.exists():
            raise ValueError("fdtd_results_manager.py not found")
        cmd = [sys.executable, str(manager), "--normalize-all", "--dry-run"]
        proc = subprocess.run(cmd, cwd=str(self.root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, encoding="utf-8", errors="replace", timeout=90)
        return {"command": cmd, "returncode": proc.returncode, "text": proc.stdout[-20000:]}


class Handler(SimpleHTTPRequestHandler):
    server_version = "FDTDWorkbenchV2/0.1"

    def log_message(self, fmt, *args):
        append_log(LOG_DIR / "server.log", "[%s] %s" % (now_iso(), fmt % args))

    @property
    def app(self):
        return self.server.app

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, exc, status=400):
        self._json({"ok": False, "error": str(exc)}, status)

    def _body_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        return json.loads(raw or "{}")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/v2/"):
                return self.handle_api_get(path, query)
            return self.handle_static(parsed.path)
        except Exception as exc:
            self._error(exc, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        try:
            payload = self._body_json()
            return self.handle_api_post(path, payload)
        except Exception as exc:
            self._error(exc, 400)

    def handle_api_get(self, path, query):
        app = self.app
        if path == "/api/v2/bootstrap":
            return self._json(app.bootstrap())
        if path == "/api/v2/index/status":
            return self._json(app.index_status())
        if path == "/api/v2/summary":
            return self._json(read_json(app.overview_cache_path, empty_overview_cache()).get("summary", {}))
        if path == "/api/v2/runs":
            return self._json(app.get_runs_page(query))
        m = re.match(r"^/api/v2/runs/([^/]+)$", path)
        if m:
            run = app.run_detail(unquote(m.group(1)))
            if not run:
                raise ValueError("run not found")
            return self._json(run)
        m = re.match(r"^/api/v2/runs/([^/]+)/files$", path)
        if m:
            return self._json(app.run_files(unquote(m.group(1))))
        m = re.match(r"^/api/v2/runs/([^/]+)/samples$", path)
        if m:
            return self._json(app.run_samples(unquote(m.group(1))))
        if path == "/api/v2/files/preview":
            return self._json(app.files_preview((query.get("path") or [""])[0]))
        if path == "/api/v2/files":
            return self._json(app.get_resources_page(query))
        if path == "/api/v2/resources":
            return self._json(app.get_resources_page(query))
        if path == "/api/v2/files/raw":
            return self.serve_raw_file(app.raw_file((query.get("path") or [""])[0]))
        if path == "/api/v2/scripts":
            return self._json(app.get_scripts_page(query))
        if path == "/api/v2/preload/status":
            return self._json(app.preload_status())
        if path == "/api/v2/preload/next":
            return self._json(app.preload_next((query.get("kind") or ["run_details"])[0], (query.get("limit") or ["10"])[0]))
        if path == "/api/v2/cache/chunk":
            return self._json(app.cache_chunk((query.get("name") or [""])[0], query))
        if path == "/api/v2/cache/changes":
            return self._json(app.cache_changes((query.get("since") or [""])[0]))
        if path == "/api/v2/jobs":
            return self._json(app.job_list())
        m = re.match(r"^/api/v2/jobs/([^/]+)$", path)
        if m:
            return self._json(app.job_state(unquote(m.group(1))))
        m = re.match(r"^/api/v2/jobs/([^/]+)/log$", path)
        if m:
            return self._json(app.job_log(unquote(m.group(1))))
        m = re.match(r"^/api/v2/diagnostics/run/([^/]+)$", path)
        if m:
            return self._json(app.diagnostics_run(unquote(m.group(1))))
        m = re.match(r"^/api/v2/diagnostics/sample/([^/]+)/([^/]+)$", path)
        if m:
            run_id = unquote(m.group(1))
            sample_id = unquote(m.group(2))
            samples = app.run_samples(run_id).get("samples", [])
            return self._json({"run_id": run_id, "sample_id": sample_id, "sample": next((s for s in samples if str(s.get("sample_id")) == sample_id), {})})
        if path == "/api/v2/diagnostics/spectrum":
            return self._json(app.diagnostics_spectrum((query.get("run_id") or [""])[0], (query.get("sample_id") or [""])[0], (query.get("kind") or ["T"])[0]))
        if path == "/api/v2/diagnostics/trend":
            return self._json(app.diagnostics_trend((query.get("run_id") or [""])[0]))
        if path == "/api/v2/diagnostics/quality":
            return self._json(app.diagnostics_quality((query.get("run_id") or [""])[0]))
        if path == "/api/v2/mode-relay":
            return self._json(app.mode_relay((query.get("run_id") or [""])[0]))
        if path == "/api/v2/mode-relay/heatmap":
            return self._json(app.mode_relay_heatmap((query.get("run_id") or [""])[0]))
        if path == "/api/v2/mode-relay/candidates":
            return self._json(app.mode_relay_candidates((query.get("group") or [""])[0]))
        if path == "/api/v2/supplement/missing":
            return self._json(app.supplement_missing())
        if path == "/api/v2/supplement/packages":
            return self._json(app.supplement_packages())
        m = re.match(r"^/api/v2/supplement/packages/([^/]+)$", path)
        if m:
            return self._json(app.supplement_package(unquote(m.group(1))))
        raise ValueError("unknown endpoint: " + path)

    def handle_api_post(self, path, payload):
        app = self.app
        if path == "/api/v2/index/refresh":
            return self._json(app.start_scan(full_rebuild=bool(payload.get("full_rebuild")), confirm=bool(payload.get("confirm"))))
        if path == "/api/v2/index/refresh-delta":
            return self._json(refresh_delta_paths(app, payload.get("dirty_paths") or [], job_id=payload.get("job_id")))
        if path == "/api/v2/preload/start":
            return self._json(app.preload_start(payload))
        if path == "/api/v2/scripts/refresh":
            return self._json(app.refresh_scripts_only())
        if path == "/api/v2/controller/preview":
            return self._json(app.controller_preview(payload))
        if path == "/api/v2/controller/start":
            return self._json(app.controller_start(payload))
        if path == "/api/v2/files/open":
            return self._json(app.open_project_file(payload.get("path") or ""))
        if path == "/api/v2/files/open-folder":
            return self._json(app.open_project_folder(payload.get("path") or ""))
        if path == "/api/v2/diagnostics/peak-selection":
            return self._json(app.save_peak_selection(payload))
        m = re.match(r"^/api/v2/jobs/([^/]+)/stop$", path)
        if m:
            return self._json(app.stop_job(unquote(m.group(1))))
        if path == "/api/v2/supplement/create-package":
            return self._json(app.create_supplement_package(payload))
        m = re.match(r"^/api/v2/supplement/packages/([^/]+)/delete$", path)
        if m:
            return self._json(app.delete_supplement_package(unquote(m.group(1))))
        if path == "/api/v2/results-manager/dry-run":
            return self._json(app.result_manager_dry_run())
        raise ValueError("unknown endpoint: " + path)

    def handle_static(self, request_path):
        if request_path in ("", "/"):
            target = WEB_DIR / "index.html"
        else:
            raw = unquote(request_path.lstrip("/")).replace("/", os.sep)
            target = (WEB_DIR / raw).resolve()
            if WEB_DIR.resolve() != target and WEB_DIR.resolve() not in target.parents:
                raise ValueError("invalid static path")
            if target.is_dir():
                target = target / "index.html"
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        self.serve_file(target)

    def serve_raw_file(self, target):
        self.serve_file(target, attachment=False)

    def serve_file(self, target, attachment=False):
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if attachment:
            self.send_header("Content-Disposition", "attachment; filename=%s" % target.name)
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="FDTD Spectrum Workbench V2 server")
    parser.add_argument("--root", default=str(WEB_DIR.parent), help="Project root")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    app = WorkbenchApp(args.root, args.port)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.app = app
    print("FDTD Workbench V2 running at http://127.0.0.1:%d/" % args.port)
    print("Project root: %s" % app.root)
    append_log(LOG_DIR / "server.log", "[%s] server start port=%d root=%s" % (now_iso(), args.port, app.root))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
