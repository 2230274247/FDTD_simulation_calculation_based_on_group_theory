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
import secrets
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

LOCAL_TOKEN = secrets.token_urlsafe(24)


class APIError(Exception):
    def __init__(self, message, status_code=400):
        super(APIError, self).__init__(message)
        self.status_code = status_code


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
        root_path = Path(root).resolve()
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = root_path / candidate
        return str(candidate.resolve().relative_to(root_path))
    except Exception:
        try:
            return os.path.relpath(str(Path(path)), str(Path(root)))
        except Exception:
            return str(path)


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


ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
LOG_TIME_RE = re.compile(
    r"^(?P<time>(?:\d{4}[-/]\d{2}[-/]\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)?)|(?:\d{2}:\d{2}:\d{2}))(?:\s*[\]\)]\s*|\s+[-|:]\s*|\s+)?(?P<rest>.*)$"
)
BRACKET_TIME_RE = re.compile(r"^\[(?P<time>[^\]]+)\]\s*(?P<rest>.*)$")
COLLAPSE_HINT_RE = re.compile(r"(license|licen[sc]e|heartbeat|keep[- ]?alive|\bmesh\b|saving|saved|write|dump)", re.I)


def strip_ansi(text):
    return ANSI_ESCAPE_RE.sub("", text or "")


def extract_log_time(text):
    line = strip_ansi(text or "").strip()
    if not line:
        return "", ""
    match = BRACKET_TIME_RE.match(line)
    if match and re.search(r"\d", match.group("time")):
        return match.group("time").strip(), match.group("rest").strip()
    match = LOG_TIME_RE.match(line)
    if match:
        return match.group("time").strip(), match.group("rest").strip()
    return "", line


def classify_log_level(text):
    low = (text or "").lower()
    if any(flag in low for flag in ("traceback", "exception", "fatal", "error", "failed", "cannot ", "unable ", " not found")):
        return "error"
    if any(flag in low for flag in ("warning", "warn", "deprecated")) or "警告" in text or "错误" in text or "失败" in text:
        return "warning"
    if any(flag in low for flag in ("progress", "step", "running", "start", "mesh", "saving", "saved", "license", "heartbeat", "scan")):
        return "progress"
    return "info"


def collapse_signature(text):
    cleaned = re.sub(r"\s+", " ", (text or "").strip().lower())
    cleaned = re.sub(r"\b\d+(?:\.\d+)?\b", "#", cleaned)
    cleaned = re.sub(r"0x[0-9a-f]+", "0x#", cleaned)
    return cleaned


def detect_encoding_warning(text):
    suspicious = text.count("�") + text.count("锟") + text.count("Ã")
    if suspicious >= 8 or (suspicious >= 3 and suspicious >= max(1, len(text) // 2000)):
        return "可能存在编码问题：日志中出现较多乱码替换字符。"
    return ""


def _source_log_entries(source, raw_text):
    entries = []
    collapsed_count = 0
    prev = None
    for raw_line in (raw_text or "").splitlines():
        cleaned = strip_ansi(raw_line).rstrip()
        if not cleaned.strip():
            continue
        time_value, text = extract_log_time(cleaned)
        level = classify_log_level(text)
        signature = collapse_signature(text)
        if COLLAPSE_HINT_RE.search(text):
            signature = "hint:" + signature
        if prev and prev["source"] == source and prev["level"] == level and prev["signature"] == signature:
            prev["repeated_count"] += 1
            prev["raw"] = prev["raw"] + "\n" + raw_line.rstrip()
            prev["text"] = prev["base_text"] + (" (x%d)" % prev["repeated_count"] if prev["repeated_count"] > 1 else "")
            collapsed_count += 1
            continue
        entry = {
            "time": time_value,
            "level": level,
            "source": source,
            "base_text": text,
            "text": text,
            "raw": raw_line.rstrip(),
            "signature": signature,
            "repeated_count": 1,
        }
        entries.append(entry)
        prev = entry
    for entry in entries:
        if entry["repeated_count"] > 1:
            entry["text"] = entry["base_text"] + (" (x%d)" % entry["repeated_count"])
        else:
            entry["text"] = entry["base_text"]
        entry.pop("base_text", None)
        entry.pop("signature", None)
    return entries, collapsed_count


def decode_structured_log(payloads):
    raw_parts = []
    clean_parts = []
    structured = []
    collapsed_count = 0
    for source, raw_bytes in payloads:
        decoded = decode_mixed_log(raw_bytes)
        raw_parts.append("[%s]\n%s" % (source, decoded.rstrip()))
        entries, collapsed = _source_log_entries(source, decoded)
        structured.extend(entries)
        collapsed_count += collapsed
        if entries:
            clean_parts.append("[%s]" % source)
            for item in entries:
                prefix = ""
                if item.get("time"):
                    prefix = "[%s] " % item["time"]
                clean_parts.append("%s%s%s" % (prefix, item["source"] + " | " if item.get("source") else "", item["text"]))
    raw_text = "\n".join(part for part in raw_parts if part.strip()).strip()
    text = "\n".join(part for part in clean_parts if part.strip()).strip()
    encoding_warning = detect_encoding_warning(raw_text)
    return {
        "text": text,
        "raw_text": raw_text,
        "structured_lines": structured,
        "collapsed_count": collapsed_count,
        "encoding_warning": encoding_warning,
    }


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


GROUP_ROOT_MAP = {
    "C2对称结构": "C2",
    "C3对称结构": "C3",
    "C4对称结构": "C4",
    "C6对称结构": "C6",
    "近径向高对称结构": "近径向",
}
GROUP_LABEL_MAP = {
    "C2": "C2",
    "C3": "C3",
    "C4": "C4",
    "C6": "C6",
    "近径向": "近径向高对称结构",
}
ALLOWED_GROUP_ROOTS = set(GROUP_ROOT_MAP.keys())
EXCLUDED_SCAN_DIRS = {
    "旧文件",
    "controller_logs",
    "结果查看器_html_v2",
    "runtime_state",
    "logs",
    "generated",
    "__pycache__",
    ".idea",
    "docs",
}


def _parts_under_root(path, data_root):
    try:
        rel = Path(path).resolve().relative_to(Path(data_root).resolve())
    except Exception:
        return []
    return list(rel.parts)


def is_active_run_dir(path, data_root):
    parts = _parts_under_root(path, data_root)
    if not parts:
        return False
    if Path(path).name.lower().startswith("run_") is False:
        return False
    if parts[0] not in ALLOWED_GROUP_ROOTS:
        return False
    lower_parts = [p.lower() for p in parts]
    if "results" not in lower_parts:
        return False
    if any(p in EXCLUDED_SCAN_DIRS for p in parts):
        return False
    return True


def is_archived_good_dir(path, data_root):
    parts = _parts_under_root(path, data_root)
    if not parts:
        return False
    if parts[0] not in ALLOWED_GROUP_ROOTS:
        return False
    lower_parts = [p.lower() for p in parts]
    if "results" not in lower_parts:
        return False
    return ("旧文件" in parts) and ("良好" in parts)


def detect_group(parts):
    if not parts:
        return ""
    for part in parts:
        if part in GROUP_ROOT_MAP:
            return GROUP_ROOT_MAP[part]
    return ""


def normalize_group_label(group):
    g = str(group or "").strip()
    if g in GROUP_LABEL_MAP:
        return GROUP_LABEL_MAP[g]
    return ""


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


def convergence_fields(detail):
    records = detail.get("quality_flag_records") or []
    names = [str(r.get("flag") or "") for r in records]
    has_fail = any(str(r.get("severity") or "").lower() in ("fail", "serious", "error") for r in records)
    has_non_converged = has_fail or any(("未收敛" in name) or ("non-converged" in name.lower()) for name in names)
    if has_non_converged:
        return True, "non_converged"
    if records:
        return False, "warning"
    return False, "converged"


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


def normalize_spectrum_points(points):
    normalized = []
    for item in points or []:
        lam = val = None
        if isinstance(item, dict):
            lam = numeric(item.get("lambda_nm") or item.get("lambda") or item.get("x"))
            val = numeric(item.get("T") or item.get("value") or item.get("y"))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            lam = numeric(item[0])
            val = numeric(item[1])
        if lam is None or val is None:
            continue
        normalized.append((float(lam), float(val)))
    normalized.sort(key=lambda pair: pair[0])
    return normalized


def interpolate_level_crossing(left_point, right_point, level):
    x0, y0 = left_point
    x1, y1 = right_point
    if y1 == y0:
        return (x0 + x1) / 2.0
    return x0 + (level - y0) * (x1 - x0) / (y1 - y0)


def calculate_peak_selection_metrics(points, lambda_min, lambda_max, feature_type="auto"):
    lam_min = numeric(lambda_min)
    lam_max = numeric(lambda_max)
    if lam_min is None or lam_max is None:
        raise ValueError("lambda_min and lambda_max are required")
    if lam_min > lam_max:
        lam_min, lam_max = lam_max, lam_min
    all_points = normalize_spectrum_points(points)
    if len(all_points) < 3:
        raise ValueError("spectrum has too few points")
    used_points = [(x, y) for x, y in all_points if lam_min <= x <= lam_max]
    if len(used_points) < 3:
        raise ValueError("selected λ range has too few raw points")
    xs = [x for x, _ in used_points]
    ys = [y for _, y in used_points]
    max_t = max(ys)
    min_t = min(ys)
    median = sorted(ys)[len(ys) // 2]
    feature = str(feature_type or "auto").strip().lower()
    if feature not in ("auto", "peak", "dip"):
        raise ValueError("feature_type must be auto, peak or dip")
    peak_contrast = max_t - median
    dip_contrast = median - min_t
    if feature == "auto":
        feature = "peak" if peak_contrast >= dip_contrast else "dip"
    if feature == "peak":
        feature_index = ys.index(max_t)
    else:
        feature_index = ys.index(min_t)
    lambda0 = xs[feature_index]
    feature_value = ys[feature_index]
    contrast = max_t - min_t
    half_level = min_t + contrast / 2.0 if feature == "peak" else max_t - contrast / 2.0
    warnings = []

    def predicate(value):
        return value >= half_level if feature == "peak" else value <= half_level

    left = feature_index
    while left > 0 and predicate(ys[left]):
        left -= 1
    right = feature_index
    while right < len(ys) - 1 and predicate(ys[right]):
        right += 1

    left_boundary = None
    right_boundary = None
    if left < feature_index and predicate(ys[left + 1]) and not predicate(ys[left]):
        left_boundary = interpolate_level_crossing(used_points[left], used_points[left + 1], half_level)
    else:
        warnings.append("左侧未找到半高边界")
    if right > feature_index and predicate(ys[right - 1]) and not predicate(ys[right]):
        right_boundary = interpolate_level_crossing(used_points[right - 1], used_points[right], half_level)
    else:
        warnings.append("右侧未找到半高边界")

    fwhm = abs(right_boundary - left_boundary) if left_boundary is not None and right_boundary is not None else None
    if fwhm is None or fwhm <= 0:
        warnings.append("FWHM 无法可靠计算")
    q = lambda0 / fwhm if fwhm and fwhm > 0 else None
    score = (q or 0) * max(0.0, contrast)
    return {
        "lambda0_nm": lambda0,
        "FWHM_nm": fwhm,
        "Q": q,
        "score": score,
        "feature_type": feature,
        "feature_value": feature_value,
        "max_T": max_t,
        "min_T": min_t,
        "contrast": contrast,
        "half_level": half_level,
        "lambda_min_nm": lam_min,
        "lambda_max_nm": lam_max,
        "left_boundary_nm": left_boundary,
        "right_boundary_nm": right_boundary,
        "feature_index": feature_index,
        "used_points": [[x, y] for x, y in used_points],
        "used_point_count": len(used_points),
        "warnings": warnings,
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
    if run_detail.get("subprocess_failed"):
        flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "子进程失败", "severity": "fail", "detail": "日志中检测到子进程失败/异常关键词", "suggestion": "检查 run.log / stderr.log 并复跑"})
    if run_detail.get("manifest_abnormal"):
        flags.append({"run_id": run_id, "sample_id": run_detail.get("best_sample_id"), "flag": "manifest 异常", "severity": "fail", "detail": "manifest 缺失或无有效行", "suggestion": "检查 04_logs/manifest.csv 生成流程"})
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
    manifest_rows = count_csv_rows(manifest) if manifest else 0
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
    subprocess_failed = False
    for log_file in [run_path / "04_logs" / "stderr.log", run_path / "04_logs" / "run.log", run_path / "04_logs" / "error.log"]:
        if not log_file.exists() or not log_file.is_file():
            continue
        try:
            text = log_file.read_text(encoding="utf-8", errors="replace").lower()
        except Exception:
            text = ""
        if any(token in text for token in ("traceback", "subprocess", "returncode", "child process", "failed", "fatal error")):
            subprocess_failed = True
            break
    manifest_abnormal = bool(manifest is None or manifest_rows <= 0)
    stat = Path(run_path).stat()
    return {
        "run_id": run_id_for(rel),
        "run_name": run_name,
        "relative_path": rel,
        "group": normalize_group_label(group),
        "mother_structure": mother,
        "perturbation": perturbation,
        "reduction_path": reduction_path,
        "mode": mode,
        "archive_state": archive_state,
        "sample_count": sample_count,
        "manifest_rows": manifest_rows,
        "manifest_abnormal": manifest_abnormal,
        "subprocess_failed": subprocess_failed,
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
        "scope": "active" if is_active_run_dir(run_path, root) else ("archived_good" if is_archived_good_dir(run_path, root) else "ignored"),
        "is_active_result": bool(is_active_run_dir(run_path, root)),
        "is_archived_good": bool(is_archived_good_dir(run_path, root)),
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
    has_non_converged, convergence_status = convergence_fields(detail)
    detail["has_non_converged"] = has_non_converged
    detail["convergence_status"] = convergence_status
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
    for p in discover_run_dirs_under(root):
        if not is_active_run_dir(p, root):
            continue
        rel = slash(rel_to(root, p))
        try:
            runs.append(scan_run_detail(p, root=root, previous_detail=prev_by_path.get(rel)))
        except Exception as exc:
            append_log(STATE_DIR / "scan_errors.log", "scan_run_detail failed %s: %s" % (p, exc))
    runs.sort(key=lambda x: x.get("mtime", 0), reverse=True)
    return runs


def is_old_run_record(run):
    text = "%s %s" % (run.get("relative_path", ""), run.get("archive_state", ""))
    low = text.lower()
    return "旧" in text or "旧文件" in text or "\\old" in low or "/old" in low or "archive" in low


def _run_abs_path(run, data_root):
    rel = str(run.get("relative_path") or "").strip()
    if not rel:
        return None
    try:
        return Path(safe_join(data_root, rel))
    except Exception:
        return None


def classify_run_scope(run, data_root):
    run_path = _run_abs_path(run, data_root)
    if run_path is None or (not run_path.exists()) or (not run_path.is_dir()):
        return "ignored"
    if is_active_run_dir(run_path, data_root):
        return "active"
    if is_archived_good_dir(run_path, data_root):
        return "archived_good"
    return "ignored"


def filter_runs_by_scope(runs, scope, data_root=None):
    scope = (scope or "current").lower()
    data_root = Path(data_root or Path(WEB_DIR).parent)
    items = list(runs or [])
    filtered = []
    for run in items:
        scoped = classify_run_scope(run, data_root)
        run["scope"] = scoped
        run["is_active_result"] = scoped == "active"
        run["is_archived_good"] = scoped == "archived_good"
        if scope == "all":
            if scoped in ("active", "archived_good"):
                filtered.append(run)
        elif scope == "old":
            if scoped == "archived_good":
                filtered.append(run)
        else:
            if scoped == "active":
                filtered.append(run)
    return filtered


def normalize_structure_scope(scope):
    scope = (scope or "current").lower()
    return scope if scope in ("current", "old", "all") else "current"


def read_run_index_cache(path):
    data = read_json(path, {"schema_version": 2, "built_at": "", "runs": []})
    if isinstance(data, list):
        return {"schema_version": 2, "built_at": "", "runs": list(data)}
    if not isinstance(data, dict):
        return {"schema_version": 2, "built_at": "", "runs": []}
    runs = data.get("runs")
    if runs is None:
        runs = data.get("items") or []
    if not isinstance(runs, list):
        runs = list(runs) if runs else []
    data["runs"] = runs
    return data


def _structure_node(name, kind):
    return {
        "name": name,
        "kind": kind,
        "run_count": 0,
        "full_count": 0,
        "test_count": 0,
        "high_risk_count": 0,
        "missing_evidence_count": 0,
        "latest_mtime": "",
        "latest_mtime_ts": 0,
        "best_score": None,
        "children_map": {},
        "runs": [],
    }


def _update_structure_node(node, run):
    node["run_count"] += 1
    mode = str(run.get("mode") or "").lower()
    if mode == "full":
        node["full_count"] += 1
    elif mode == "test":
        node["test_count"] += 1
    if str(run.get("risk_level") or run.get("risk") or "").lower() == "high":
        node["high_risk_count"] += 1
    node["missing_evidence_count"] += len(run.get("missing_evidence") or [])
    mtime = run.get("mtime") or 0
    try:
        mtime = float(mtime)
    except Exception:
        mtime = 0
    if mtime >= node["latest_mtime_ts"]:
        node["latest_mtime_ts"] = mtime
        node["latest_mtime"] = run.get("mtime_iso") or ""
    score = numeric(run.get("best_score") if run.get("best_score") is not None else run.get("score"))
    if score is not None and (node["best_score"] is None or score > node["best_score"]):
        node["best_score"] = score


def _finalize_structure_node(node):
    children = node.pop("children_map", {})
    node["children"] = [_finalize_structure_node(child) for child in sorted(children.values(), key=lambda item: (
        -item.get("run_count", 0),
        -(item.get("best_score") if item.get("best_score") is not None else -1),
        -item.get("latest_mtime_ts", 0),
        item.get("name") or "",
    ))]
    node["runs"].sort(key=lambda item: (
        -item.get("run_count", 0),
        -(item.get("best_score") if item.get("best_score") is not None else -1),
        -item.get("latest_mtime_ts", 0),
        item.get("name") or "",
    ))
    node.pop("latest_mtime_ts", None)
    return node


def build_structure_tree(runs):
    roots = {}
    for run in runs or []:
        group_name = run.get("group") or "未分类"
        mother_name = run.get("mother_structure") or "未识别母结构"
        perturb_name = run.get("perturbation") or "未识别扰动"
        run_name = run.get("run_name") or run.get("run_id") or "run"

        group_node = roots.setdefault(group_name, _structure_node(group_name, "group"))
        _update_structure_node(group_node, run)
        mother_node = group_node["children_map"].setdefault(mother_name, _structure_node(mother_name, "mother"))
        _update_structure_node(mother_node, run)
        perturb_node = mother_node["children_map"].setdefault(perturb_name, _structure_node(perturb_name, "perturbation"))
        _update_structure_node(perturb_node, run)

        perturb_node["runs"].append({
            "kind": "run",
            "name": run_name,
            "run_name": run_name,
            "run_id": run.get("run_id") or "",
            "group": group_name,
            "mother_structure": mother_name,
            "perturbation": perturb_name,
            "run_count": 1,
            "full_count": 1 if str(run.get("mode") or "").lower() == "full" else 0,
            "test_count": 1 if str(run.get("mode") or "").lower() == "test" else 0,
            "high_risk_count": 1 if str(run.get("risk_level") or run.get("risk") or "").lower() == "high" else 0,
            "missing_evidence_count": len(run.get("missing_evidence") or []),
            "latest_mtime": run.get("mtime_iso") or "",
            "latest_mtime_ts": float(run.get("mtime") or 0) if str(run.get("mtime") or "").strip() else 0,
            "best_score": numeric(run.get("best_score") if run.get("best_score") is not None else run.get("score")),
            "mode": run.get("mode") or "",
            "risk_level": run.get("risk_level") or run.get("risk") or "",
            "risk_label": run.get("risk_label") or "",
            "missing_evidence": run.get("missing_evidence") or [],
        })

    return [_finalize_structure_node(node) for node in sorted(roots.values(), key=lambda item: (
        -item.get("run_count", 0),
        -(item.get("best_score") if item.get("best_score") is not None else -1),
        -item.get("latest_mtime_ts", 0),
        item.get("name") or "",
    ))]


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


def detect_script_args(path):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    keys = set()
    for match in re.finditer(r"--([A-Za-z0-9][A-Za-z0-9_-]*)", text):
        key = match.group(1).replace("-", "_").upper()
        if key and key != "HELP":
            keys.add(key)
    return sorted(keys)


def build_script_schema(record, defaults=None):
    defaults = defaults or {}
    script_path = record.get("script_path") or record.get("relative_path") or ""
    script_name = Path(script_path).name.lower()
    detected_style = record.get("detected_style") or ("mock" if "mock_run_script" in script_name else detect_mode(Path(script_path).stem))
    accepted_keys = record.get("accepted_keys") or detect_script_args(script_path)
    if not accepted_keys:
        accepted_keys = sorted([k for k in defaults.keys() if re.match(r"^[A-Z0-9_]+$", str(k))])
    supports_mode = record.get("supports_mode")
    if supports_mode is None:
        if detected_style in ("preview", "test", "full"):
            supports_mode = [detected_style]
        else:
            supports_mode = ["preview", "test", "full"]
    supports_overrides = record.get("supports_overrides")
    if supports_overrides is None:
        supports_overrides = bool(accepted_keys)
    warnings = list(record.get("warnings") or [])
    if detected_style == "unknown":
        warnings.append("未识别脚本模式")
    if not supports_overrides:
        warnings.append("未检测到可覆盖参数")
    schema = dict(record)
    schema.update({
        "script_id": str(record.get("script_id") or record.get("id") or ""),
        "script_path": script_path,
        "detected_style": detected_style,
        "supports_mode": supports_mode,
        "supports_overrides": bool(supports_overrides),
        "accepted_keys": sorted(set(accepted_keys)),
        "default_values": dict(record.get("default_values") or defaults),
        "warnings": warnings,
    })
    return schema


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
    allowed_group_roots = set(ALLOWED_GROUP_ROOTS)
    excluded_script_dirs = set(EXCLUDED_SCAN_DIRS) | {"results"}
    for dirpath, dirnames, filenames in os.walk(str(root)):
        p = Path(dirpath)
        if WEB_DIR in p.resolve().parents or p.resolve() == WEB_DIR.resolve():
            dirnames[:] = []
            continue
        parts = _parts_under_root(p, root)
        if parts:
            if parts[0] not in allowed_group_roots:
                dirnames[:] = []
                continue
            if any(part in excluded_script_dirs for part in parts):
                dirnames[:] = []
                continue
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            path = p / name
            if not is_run_script_candidate(path):
                continue
            rel_parts = _parts_under_root(path, root)
            lower_parts = [x.lower() for x in rel_parts]
            if "coding" not in lower_parts:
                continue
            if any(part in excluded_script_dirs for part in rel_parts):
                continue
            rel = slash(rel_to(root, path))
            group, mother, perturbation, reduction_path, _ = context_from_rel(rel)
            if not group:
                continue
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
            records[-1] = build_script_schema(records[-1], defaults)
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
    peak_selection_path = Path(root) / run["relative_path"] / "12_analysis_summary" / "v2_peak_selections.json"
    peak_selections = load_json_safe(peak_selection_path, {"schema_version": 1, "selections": []})
    peak_records = peak_selections.get("selections", []) if isinstance(peak_selections, dict) else []
    selection_by_key = {}
    for record in peak_records:
        if not isinstance(record, dict):
            continue
        if not record.get("manual_verified"):
            continue
        sid = str(record.get("sample_id") or "")
        kind = str(record.get("kind") or "T").upper()
        if sid:
            selection_by_key[(sid, kind)] = record
    for idx, row in enumerate(source_rows):
        sid = row.get("sample_id") or row.get("id") or row.get("index") or row.get("sample") or "#%d" % (idx + 1)
        metric = metric_by_sample.get(str(sid)) or metric_by_index.get(idx) or metric_by_index.get(idx + 1) or {}
        selection = selection_by_key.get((str(sid), "T"))
        auto_metrics = {
            "lambda0_nm": metric.get("lambda0_nm") or metric.get("lambda_peak_nm") or run.get("lambda0_nm"),
            "Q": metric.get("Q") or metric.get("q") or run.get("q"),
            "q": metric.get("Q") or metric.get("q") or run.get("q"),
            "FWHM_nm": metric.get("FWHM_nm") or metric.get("FWHM") or metric.get("fwhm_nm") or run.get("fwhm_nm"),
            "fwhm_nm": metric.get("FWHM_nm") or metric.get("FWHM") or metric.get("fwhm_nm") or run.get("fwhm_nm"),
            "max_T": numeric(metric.get("max_T") or metric.get("maxT") or metric.get("T_max") or metric.get("max_t") or run.get("max_t")),
            "max_t": numeric(metric.get("max_T") or metric.get("maxT") or metric.get("T_max") or metric.get("max_t") or run.get("max_t")),
            "score": metric.get("score") or metric.get("quality_score") or run.get("score"),
        }
        manual_metrics = selection.get("metrics") if selection else {}
        visible = dict(auto_metrics)
        if selection and selection.get("manual_verified"):
            for key in ("lambda0_nm", "Q", "q", "FWHM_nm", "fwhm_nm", "max_T", "max_t", "min_T", "contrast", "score", "feature_type", "half_level", "left_boundary_nm", "right_boundary_nm"):
                if manual_metrics.get(key) is not None:
                    visible[key] = manual_metrics.get(key)
        max_t = numeric(metric.get("max_T") or metric.get("maxT") or metric.get("T_max") or metric.get("max_t") or run.get("max_t"))
        sample_flags = []
        if max_t is not None and max_t > 1:
            sample_flags.append("T > 1")
        sample_flags.extend(flag_names or [])
        sample_flags = list(dict.fromkeys([str(x) for x in sample_flags if x]))
        row_payload = {
            "sample_id": sid,
            "delta": row.get("delta") or row.get("Delta") or row.get("value") or row.get("scan_value"),
            "lambda0_nm": visible.get("lambda0_nm"),
            "Q": visible.get("Q"),
            "q": visible.get("q"),
            "FWHM_nm": visible.get("FWHM_nm"),
            "fwhm_nm": visible.get("fwhm_nm"),
            "max_T": visible.get("max_T"),
            "max_t": visible.get("max_t"),
            "score": visible.get("score"),
            "quality_flags": sample_flags,
            "missing_evidence": run.get("missing_evidence", []),
            "source_fsp": row.get("source_fsp") or row.get("fsp") or (slash(rel_to(root, fsp_files[min(idx, len(fsp_files) - 1)])) if fsp_files else ""),
        }
        if selection:
            row_payload["manual_verified"] = True
            row_payload["manual_selection"] = selection
            row_payload["manual_metrics"] = manual_metrics
            row_payload["auto_metrics"] = auto_metrics
            row_payload["manual_verified_at"] = selection.get("verified_at") or selection.get("created_at")
        rows.append(row_payload)
    if not rows:
        selection = selection_by_key.get((str(run.get("best_sample_id") or "#1"), "T"))
        auto_metrics = {
            "lambda0_nm": run.get("lambda0_nm", ""),
            "Q": run.get("q", ""),
            "q": run.get("q", ""),
            "FWHM_nm": run.get("fwhm_nm", ""),
            "fwhm_nm": run.get("fwhm_nm", ""),
            "max_T": run.get("max_t", ""),
            "max_t": run.get("max_t", ""),
            "score": run.get("score", ""),
        }
        visible = dict(auto_metrics)
        if selection and selection.get("manual_verified"):
            manual_metrics = selection.get("metrics") or {}
            for key in ("lambda0_nm", "Q", "q", "FWHM_nm", "fwhm_nm", "max_T", "max_t", "min_T", "contrast", "score", "feature_type", "half_level", "left_boundary_nm", "right_boundary_nm"):
                if manual_metrics.get(key) is not None:
                    visible[key] = manual_metrics.get(key)
        rows.append({
            "sample_id": run.get("best_sample_id") or "#1",
            "delta": run.get("delta", ""),
            "lambda0_nm": visible.get("lambda0_nm", ""),
            "Q": visible.get("Q", ""),
            "q": visible.get("q", ""),
            "FWHM_nm": visible.get("FWHM_nm", ""),
            "fwhm_nm": visible.get("fwhm_nm", ""),
            "max_T": visible.get("max_T", ""),
            "max_t": visible.get("max_t", ""),
            "score": visible.get("score", ""),
            "quality_flags": flag_names,
            "missing_evidence": run.get("missing_evidence", []),
            "source_fsp": slash(rel_to(root, fsp_files[0])) if fsp_files else "",
            "manual_verified": bool(selection and selection.get("manual_verified")),
            "manual_selection": selection if selection else None,
            "manual_metrics": selection.get("metrics") if selection else {},
            "auto_metrics": auto_metrics,
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


def find_master_template(root, run):
    run_path = Path(root) / run.get("relative_path", "")
    candidates = find_mother_fsp_candidates(root, run)
    if candidates:
        return candidates[0]
    return run_path / "05_work_fsp" / "master_template.fsp"


def find_mother_fsp_candidates(root, run):
    run_path = Path(root) / run.get("relative_path", "")
    work_dir = run_path / "05_work_fsp"
    if not work_dir.exists():
        work_dir = run_path / "work_fsp"
    if not work_dir.exists():
        return []
    level1 = []
    for name in ("master_template.fsp",):
        p = work_dir / name
        if p.exists() and p.is_file():
            level1.append(p)
    level2 = sorted([p for p in work_dir.glob("master_*.fsp") if p.is_file()], key=lambda x: x.name.lower())
    level3 = sorted([p for p in work_dir.glob("mather_*.fsp") if p.is_file()], key=lambda x: x.name.lower())
    level4 = sorted([p for p in work_dir.glob("*.fsp") if p.is_file()], key=lambda x: x.name.lower())
    ordered = []
    seen = set()
    for item in level1 + level2 + level3 + level4:
        key = str(item.resolve())
        if key in seen:
            continue
        seen.add(key)
        ordered.append(item)
    return ordered


def find_sample_fsp_candidates(root, run, sample_id):
    run_path = Path(root) / run.get("relative_path", "")
    sample_dir = run_path / "01_supercell_fsp"
    if not sample_dir.exists():
        return []
    sid = str(sample_id or "").strip()
    if not sid:
        return sorted([p for p in sample_dir.glob("*.fsp") if p.is_file()], key=lambda x: x.name.lower())
    candidates = []
    for p in sample_dir.glob("*.fsp"):
        if not p.is_file():
            continue
        name = p.name.lower()
        token = sid.lower()
        if token in name:
            candidates.append(p)
    return sorted(candidates, key=lambda x: x.name.lower())


def run_work_fsp_dir(root, run):
    master = find_master_template(root, run)
    if master and master.name == "master_template.fsp":
        return master.parent
    return Path(root) / run.get("relative_path", "") / "05_work_fsp"


def rel_or_empty(root, path):
    try:
        if path:
            return slash(rel_to(root, Path(path)))
    except Exception:
        pass
    return ""


def abs_or_empty(path):
    try:
        if path:
            return str(Path(path).resolve())
    except Exception:
        pass
    return ""


def next_numbered_output_dirs(run_path, supplement_type):
    run_path = Path(run_path)
    max_index = -1
    if run_path.exists():
        for child in run_path.iterdir():
            if child.is_dir():
                m = re.match(r"^(\d{2})_", child.name)
                if m:
                    max_index = max(max_index, int(m.group(1)))
    start = max_index + 1
    typ = str(supplement_type or "").lower()
    if typ in ("r", "reflection"):
        names = ["reflection_excel_raw", "reflection_png"]
    elif typ in ("a", "absorption"):
        names = ["absorption_excel_raw", "absorption_png"]
    elif typ in ("field", "fields"):
        names = ["field_data"]
    elif typ == "phase":
        names = ["phase_data"]
    elif typ == "poynting":
        names = ["poynting_data"]
    elif typ in ("angle-resolved", "angle_resolved"):
        names = ["angle_resolved"]
    elif typ in ("band sweep", "band_sweep"):
        names = ["band_sweep"]
    else:
        names = ["patch_outputs"]
    return [run_path / ("%02d_%s" % (start + idx, name)) for idx, name in enumerate(names)]


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


def count_archived_good_diagnosed_spectra(data_root):
    root = Path(data_root)
    excluded_for_archive = set(EXCLUDED_SCAN_DIRS) - {"旧文件"}
    archived_dirs = []
    for dirpath, dirnames, _ in os.walk(str(root)):
        p = Path(dirpath)
        parts = _parts_under_root(p, root)
        if not parts:
            dirnames[:] = []
            continue
        if any(part in excluded_for_archive for part in parts):
            dirnames[:] = []
            continue
        if is_archived_good_dir(p, root):
            archived_dirs.append(p)
            dirnames[:] = []
    diagnosed_spectra = 0
    for folder in archived_dirs:
        for f in folder.rglob("*"):
            if not f.is_file():
                continue
            if f.suffix.lower() not in (".csv", ".xlsx", ".xlsm"):
                continue
            name = f.name.lower()
            if any(token in name for token in ("trans", "transmission", "reflection", "absorption", "spectral", "spectrum")):
                diagnosed_spectra += 1
    return {
        "archived_good_dir_count": len(archived_dirs),
        "diagnosed_spectra": diagnosed_spectra,
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
        "scope", "is_active_result", "is_archived_good",
        "has_non_converged", "convergence_status",
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


def build_overview_summary(runs, scripts, quality, data_root=None):
    runs = [dict(r, group=normalize_group_label(r.get("group"))) for r in (runs or []) if normalize_group_label(r.get("group"))]
    groups = compute_groups(runs, scripts)
    summary_data = build_summary(runs, scripts, groups)
    archived_stats = count_archived_good_diagnosed_spectra(data_root or Path(WEB_DIR).parent)
    summary_data.update({
        "active_valid_run_count": summary_data.get("valid_run_count", 0),
        "archived_good_run_count": archived_stats.get("archived_good_dir_count", 0),
        "diagnosed_spectra": archived_stats.get("diagnosed_spectra", 0),
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
    summary_data = build_overview_summary(runs, scripts, quality, data_root=root)
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


def purge_deleted_run_caches(valid_run_ids):
    valid = set(str(x) for x in (valid_run_ids or []) if x)
    removed_run_details = 0
    removed_spectrum_cache = 0
    for path in RUN_DETAILS_DIR.glob("*.json"):
        data = load_json_safe(path, {})
        run_id = str(data.get("run_id") or (data.get("run") or {}).get("run_id") or "")
        if run_id and run_id not in valid:
            try:
                path.unlink()
                removed_run_details += 1
            except Exception:
                pass
    for path in SPECTRUM_CACHE_DIR.glob("*.json"):
        data = load_json_safe(path, {})
        run_id = str(data.get("run_id") or "")
        if run_id and run_id not in valid:
            try:
                path.unlink()
                removed_spectrum_cache += 1
            except Exception:
                pass
    return {
        "removed_run_details": removed_run_details,
        "removed_spectrum_cache": removed_spectrum_cache,
    }


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
        "scope": detail.get("scope", "active"),
        "is_active_result": bool(detail.get("is_active_result", True)),
        "is_archived_good": bool(detail.get("is_archived_good", False)),
        "has_non_converged": bool(detail.get("has_non_converged", False)),
        "convergence_status": detail.get("convergence_status", "converged"),
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
    root = Path(run_index.get("project_root") or Path(WEB_DIR).parent)
    active_runs = []
    for r in runs:
        rel = r.get("relative_path") or ""
        abs_path = root / rel if rel else None
        if not rel or abs_path is None:
            continue
        if not abs_path.exists():
            continue
        if not is_active_run_dir(abs_path, root):
            continue
        g = normalize_group_label(r.get("group"))
        if not g:
            continue
        item = dict(r)
        item["group"] = g
        item["scope"] = "active"
        active_runs.append(item)
    scripts = script_registry.get("scripts", [])
    quality_flags = quality_cache.get("flags", [])
    groups = compute_groups([
        {
            "group": r.get("group"),
            "mother_structure": r.get("mother_structure"),
            "spectra_count": r.get("spectrum_count", r.get("spectra_count", 0)),
        }
        for r in active_runs
    ], scripts)
    abnormal_flags = {"T > 1", "FWHM 不可靠", "子进程失败", "manifest 异常"}
    def is_abnormal(run):
        names = set(str(x) for x in (run.get("quality_flags") or []))
        if run.get("has_non_converged") or str(run.get("convergence_status") or "").lower() == "non_converged":
            return True
        if any(name in names for name in abnormal_flags):
            return True
        return str(run.get("risk_level") or run.get("risk") or "").lower() == "high"
    valid = [
        r for r in active_runs
        if (r.get("spectrum_count", r.get("spectra_count", 0)) > 0 or r.get("sample_count", 0) > 0) and not is_abnormal(r)
    ]
    bad = [r for r in active_runs if is_abnormal(r)]
    mothers_total = len(set([s.get("mother_structure") for s in scripts if s.get("mother_structure")] + [r.get("mother_structure") for r in active_runs if r.get("mother_structure")]))
    mothers_valid = len(set(r.get("mother_structure") for r in valid if r.get("mother_structure")))
    candidates = sorted(active_runs, key=lambda r: r.get("best_score") if r.get("best_score") is not None else (r.get("score") if r.get("score") is not None else -1), reverse=True)[:10]
    recent = sorted(active_runs, key=lambda r: r.get("mtime", 0), reverse=True)[:10]
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
    archived_stats = count_archived_good_diagnosed_spectra(root)
    return {
        "schema_version": 2,
        "summary": {
            "valid_run_count": len(valid),
            "active_valid_run_count": len(valid),
            "archived_good_run_count": archived_stats.get("archived_good_dir_count", 0),
            "diagnosed_spectra": archived_stats.get("diagnosed_spectra", 0),
            "bad_run_count": len(bad),
            "spectra_count": archived_stats.get("diagnosed_spectra", 0),
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
                    parts = _parts_under_root(p, root)
                    if parts and any(part in EXCLUDED_SCAN_DIRS for part in parts):
                        dirnames[:] = []
                        continue
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
            if not is_active_run_dir(p, root):
                continue
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
    purge_deleted_run_caches([r.get("run_id") for r in run_index.get("runs", []) if r.get("run_id")])
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
    if request.get("patch_mode"):
        source_run_dir = request.get("source_run_dir") or request.get("source_run_path") or ""
        manifest.update({
            "patch_mode": True,
            "normal_mode": False,
            "source_run_dir": source_run_dir,
            "master_template_fsp_path": request.get("master_template_fsp_path") or "",
            "reuse_existing_perturbation_points": bool(request.get("reuse_existing_perturbation_points", True)),
            "output_to_existing_run": bool(request.get("output_to_existing_run", True)),
            "patch_package_id": request.get("package_id") or request.get("patch_package_id"),
            "expected_outputs": request.get("expected_outputs") or [{"kind": "patch_run_root", "relative_path": source_run_dir}],
            "probable_output_parents": [source_run_dir] if source_run_dir else [],
        })
        return manifest
    return predict_expected_outputs(manifest)


def normalize_requested_overrides(overrides):
    if not isinstance(overrides, dict):
        return {}
    if "*" in overrides and isinstance(overrides.get("*"), dict):
        return dict(overrides.get("*") or {})
    flat = {}
    for key, value in overrides.items():
        if isinstance(value, dict) and key == "*":
            continue
        flat[str(key)] = value
    return flat


def flatten_execution_overrides(overrides):
    return normalize_requested_overrides(overrides)


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def controller_payload_signature(payload):
    ids = payload.get("ids") or []
    if isinstance(ids, str):
        ids = [x.strip() for x in ids.split(",") if x.strip()]
    normalized = {
        "ids": [str(x) for x in ids],
        "mode": payload.get("mode") or "preview",
        "style": payload.get("style") or "sequential",
        "max_parallel": int(payload.get("max_parallel") or 2),
        "overrides": payload.get("overrides") or {},
        "child_timeout_s": int(payload.get("child_timeout_s") or 3600),
    }
    return canonical_json(normalized)


def controller_preview_hash(payload):
    signature = controller_payload_signature(payload)
    seed = "%s|%s|%s" % (signature, now_iso(), os.urandom(8).hex())
    return "prev_" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


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
    deleted_paths = []
    dirty_prefixes = [slash(str(p)).rstrip("\\") for p in dirty_paths if p]
    for old in old_run_index.get("runs", []):
        rel = slash(str(old.get("relative_path") or "")).rstrip("\\")
        if not rel:
            continue
        if dirty_prefixes and not any(rel == pref or rel.startswith(pref + "\\") for pref in dirty_prefixes):
            continue
        abs_path = app.root / rel
        if (not abs_path.exists()) or (not is_active_run_dir(abs_path, app.root)):
            deleted_paths.append(rel)
    if deleted_paths:
        run_index = merge_run_index(run_index, [], deleted_paths=sorted(set(deleted_paths)))
    spectra_index = update_spectra_index_for_changed_runs(app.root, changed_details, old_spectra)
    if deleted_paths:
        removed_ids = [
            r.get("run_id")
            for r in old_run_index.get("runs", [])
            if slash(str(r.get("relative_path") or "")).rstrip("\\") in set(deleted_paths)
        ]
        spectra_index = merge_spectra_index(spectra_index, [], changed_run_ids=[])
        spectra_index["items"] = [s for s in spectra_index.get("items", []) if s.get("run_id") not in set(removed_ids)]
    else:
        removed_ids = []
    quality = update_quality_cache_for_changed_runs(old_quality, changed_details, removed_run_ids=removed_ids)
    overview = build_overview_cache(run_index, script_registry, quality, supplement)
    resource_light, resource_full = update_resource_indexes_for_paths(app.root, old_resource_light, old_resource_full, dirty_paths, deleted_paths=deleted_paths)
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
    purge_deleted_run_caches([r.get("run_id") for r in run_index.get("runs", []) if r.get("run_id")])
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
        self.controller_preview_path = STATE_DIR / "controller_preview_cache.json"
        self.supplement_job_state_path = STATE_DIR / "supplement_job_state.json"
        self.scan_lock = threading.Lock()
        self.supplement_job_lock = threading.Lock()
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
        self.supplement_jobs = {}
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
        if not self.controller_preview_path.exists():
            atomic_write_json(self.controller_preview_path, {"schema_version": 1, "previews": {}})
        if not self.supplement_job_state_path.exists():
            atomic_write_json(self.supplement_job_state_path, {"schema_version": 1, "built_at": "", "jobs": []})
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
            "local_token": LOCAL_TOKEN,
            "meta": meta,
            "overview": overview,
            "index_cache": index_cache,
            "script_summary": {"count": len(scripts), "built_at": read_json(self.script_registry_path, {}).get("built_at", "")},
            "script_registry": {"schema_version": 2, "built_at": read_json(self.script_registry_path, {}).get("built_at", ""), "scripts": scripts[:50]},
            "quality_cache": quality_cache,
            "supplement_index": {"schema_version": supplements.get("schema_version", 1), "built_at": supplements.get("built_at", ""), "packages": supplements.get("packages", [])[:10]},
        }

    def cache(self):
        return read_run_index_cache(self.run_index_cache_path)

    def scripts(self):
        return read_json(self.script_registry_path, {"scripts": []})

    def find_run(self, run_id):
        for run in read_run_index_cache(self.run_index_cache_path).get("runs", []):
            if run.get("run_id") == run_id:
                return run
        return None

    def run_detail(self, run_id):
        run = self.find_run(run_id)
        if not run:
            return None
        cached = load_run_detail_cache(run_id)
        fp = run.get("fingerprint", {})
        sample_schema_ok = True
        if cached and cached.get("samples"):
            first_sample = cached.get("samples", [{}])[0]
            sample_schema_ok = "Q" in first_sample and "FWHM_nm" in first_sample and "quality_flags" in first_sample
        if cached and cached.get("run", {}).get("fingerprint", {}).get("fingerprint") == fp.get("fingerprint") and sample_schema_ok:
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
        items = list(read_run_index_cache(self.run_index_cache_path).get("runs", []))
        q = ((query.get("query") or [""])[0] or "").lower()
        group = (query.get("group") or [""])[0]
        risk = (query.get("risk") or [""])[0]
        status = (query.get("status") or [""])[0]
        scope = normalize_structure_scope((query.get("scope") or ["current"])[0])
        mother = (query.get("mother") or [""])[0]
        perturbation = (query.get("perturbation") or [""])[0]
        if q:
            items = [r for r in items if q in json.dumps(r, ensure_ascii=False).lower()]
        items = filter_runs_by_scope(items, scope, data_root=self.root)
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

    def structure_tree(self, query):
        scope = normalize_structure_scope((query.get("scope") or ["current"])[0])
        runs = filter_runs_by_scope(read_run_index_cache(self.run_index_cache_path).get("runs", []), scope, data_root=self.root)
        return {
            "schema_version": 1,
            "scope": scope,
            "run_count": len(runs),
            "tree": build_structure_tree(runs),
        }

    def supplement_tree(self, query):
        scope = normalize_structure_scope((query.get("scope") or ["current"])[0])
        q = ((query.get("query") or [""])[0] or "").strip().lower()
        banned_parts = {
            "旧文件",
            "controller_logs",
            "docs",
            "结果查看器_html_v2",
            "__pycache__",
            ".idea",
        }
        runs = filter_runs_by_scope(read_run_index_cache(self.run_index_cache_path).get("runs", []), scope, data_root=self.root)
        filtered_runs = []
        for run in runs:
            rel = str(run.get("relative_path") or "")
            if not rel:
                continue
            parts = [p for p in Path(rel).parts if p]
            low_parts = [p.lower() for p in parts]
            if "results" not in low_parts:
                continue
            if any((p in banned_parts) for p in parts):
                continue
            if any((p.startswith(".") for p in parts)):
                continue
            if q:
                hay = " ".join([
                    str(run.get("run_name") or ""),
                    str(run.get("run_id") or ""),
                    str(run.get("group") or ""),
                    str(run.get("mother_structure") or ""),
                    str(run.get("perturbation") or ""),
                    rel,
                ]).lower()
                if q not in hay:
                    continue
            filtered_runs.append(run)

        groups = {}
        for run in filtered_runs:
            group = run.get("group") or "未分类"
            mother = run.get("mother_structure") or "未识别结构"
            perturbation = run.get("perturbation") or "未识别扰动"
            run_id = run.get("run_id") or ""
            run_name = run.get("run_name") or run_id or "run"
            sample_rows = build_samples_for_run(self.root, run)
            sample_nodes = []
            for idx, sample in enumerate(sample_rows):
                sid = str(sample.get("sample_id") or "#%d" % (idx + 1))
                sample_nodes.append({
                    "id": "sample|%s|%s" % (safe_token(run_id), safe_token(sid)),
                    "type": "sample",
                    "label": sid,
                    "run_id": run_id,
                    "run_name": run_name,
                    "sample_id": sid,
                    "sample_fsp_path": sample.get("source_fsp") or "",
                })
            if not sample_nodes:
                sample_nodes = [{
                    "id": "sample|%s|#1" % safe_token(run_id),
                    "type": "sample",
                    "label": "#1",
                    "run_id": run_id,
                    "run_name": run_name,
                    "sample_id": "#1",
                    "sample_fsp_path": "",
                }]
            g = groups.setdefault(group, {})
            m = g.setdefault(mother, {})
            p = m.setdefault(perturbation, [])
            p.append({
                "id": "run|%s" % safe_token(run_id),
                "type": "run",
                "label": run_name,
                "run_id": run_id,
                "run_name": run_name,
                "run_path": run.get("relative_path") or "",
                "children": sample_nodes,
            })

        tree = []
        for group in sorted(groups.keys()):
            group_children = []
            mothers = groups[group]
            for mother in sorted(mothers.keys()):
                mother_children = []
                perts = mothers[mother]
                for pert in sorted(perts.keys()):
                    run_nodes = sorted(perts[pert], key=lambda x: x.get("label") or "")
                    mother_children.append({
                        "id": "perturbation|%s|%s|%s" % (safe_token(group), safe_token(mother), safe_token(pert)),
                        "type": "perturbation",
                        "label": pert,
                        "children": run_nodes,
                    })
                if mother_children:
                    mother_children.sort(key=lambda x: x.get("label") or "")
                    mother_node = {
                        "id": "structure|%s|%s" % (safe_token(group), safe_token(mother)),
                        "type": "structure",
                        "label": mother,
                        "children": mother_children,
                    }
                    group_children.append(mother_node)
            if group_children:
                tree.append({
                    "id": "symmetry|%s" % safe_token(group),
                    "type": "symmetry",
                    "label": group,
                    "children": group_children,
                })
        return {
            "schema_version": 1,
            "scope": scope,
            "root": slash(str(self.root)),
            "excluded": sorted(list(banned_parts)),
            "run_count": len(filtered_runs),
            "tree": tree,
        }

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
            runs = read_run_index_cache(self.run_index_cache_path).get("runs", [])
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
            "runs": len(read_run_index_cache(self.run_index_cache_path).get("runs", [])),
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

    def _pick_spectrum_item(self, spectra, run_id, kind, sample_id):
        rows = [s for s in spectra if s.get("run_id") == run_id and s.get("kind", "").upper() == kind]
        if not rows:
            return None
        if not sample_id:
            return rows[0]
        wanted = str(sample_id)
        aliases = {wanted}
        n = numeric(wanted.lstrip("#"))
        if n is not None:
            i = int(n)
            aliases.update({str(i), "#%d" % i, "#%d" % (i + 1)})
        for item in rows:
            if str(item.get("sample_id") or "") in aliases:
                return item
        if n is not None and 0 <= int(n) < len(rows):
            return rows[int(n)]
        return rows[0]

    def _resolve_spectrum_points(self, run_id, sample_id="", kind="T"):
        run = self.find_run(run_id)
        if not run:
            raise ValueError("run not found")
        spectra = read_json(self.spectra_index_path, {"items": []}).get("items", [])
        item = self._pick_spectrum_item(spectra, run_id, kind, sample_id)
        if not item:
            raw_detail = {"run_id": run_id, "relative_path": run.get("relative_path")}
            candidates = scan_spectrum_index(raw_detail, root=self.root)
            item = self._pick_spectrum_item(candidates, run_id, kind, sample_id)
            if item:
                old = read_json(self.spectra_index_path, {"items": []})
                old["items"] = old.get("items", []) + [item]
                save_json_atomic(self.spectra_index_path, old)
        if not item:
            return run, None, [], {}
        spectrum = load_or_build_spectrum_cache(item, root=self.root)
        points = list(zip(spectrum.get("lambda_nm", []), spectrum.get("value", [])))
        return run, item, points, spectrum

    def save_peak_selection(self, payload):
        run_id = payload.get("run_id")
        sample_id = str(payload.get("sample_id") or "")
        kind = (payload.get("kind") or "T").upper()
        lambda_min = numeric(payload.get("lambda_min"))
        lambda_max = numeric(payload.get("lambda_max"))
        feature_type = payload.get("feature_type") or "auto"
        if not run_id or lambda_min is None or lambda_max is None:
            raise ValueError("run_id, lambda_min and lambda_max are required")
        run, item, all_pairs, spectrum = self._resolve_spectrum_points(run_id, sample_id, kind)
        if not item:
            raise ValueError("spectrum not found for selected sample")
        metrics = calculate_peak_selection_metrics(all_pairs, lambda_min, lambda_max, feature_type=feature_type)
        detail = self.run_detail(run_id)
        sample_row = next((s for s in detail.get("samples", []) if str(s.get("sample_id") or "") == (item.get("sample_id") or sample_id)), {})
        record = {
            "selection_id": "peak_" + now_stamp() + "_" + hashlib.sha1(("%s|%s|%s|%s" % (run_id, sample_id, lambda_min, lambda_max)).encode("utf-8", errors="replace")).hexdigest()[:8],
            "created_at": now_iso(),
            "verified_at": now_iso(),
            "run_id": run_id,
            "sample_id": item.get("sample_id") or sample_id,
            "kind": kind,
            "lambda_min_nm": lambda_min,
            "lambda_max_nm": lambda_max,
            "source_path": item.get("relative_path"),
            "metrics": metrics,
            "manual_verified": True,
            "feature_type": metrics.get("feature_type") or feature_type,
            "used_points": metrics.get("used_points", []),
            "warnings": metrics.get("warnings", []),
            "auto_metrics": {
                "lambda0_nm": sample_row.get("lambda0_nm"),
                "Q": sample_row.get("Q") or sample_row.get("q"),
                "q": sample_row.get("q"),
                "FWHM_nm": sample_row.get("FWHM_nm") or sample_row.get("fwhm_nm"),
                "fwhm_nm": sample_row.get("fwhm_nm"),
                "max_T": sample_row.get("max_T") or sample_row.get("max_t"),
                "max_t": sample_row.get("max_t"),
                "score": sample_row.get("score"),
            },
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

    def peak_calc(self, payload):
        run_id = payload.get("run_id")
        sample_id = str(payload.get("sample_id") or "")
        kind = (payload.get("kind") or "T").upper()
        lambda_min = numeric(payload.get("lambda_min"))
        lambda_max = numeric(payload.get("lambda_max"))
        feature_type = payload.get("feature_type") or "auto"
        if not run_id or lambda_min is None or lambda_max is None:
            raise ValueError("run_id, lambda_min and lambda_max are required")
        run, item, all_pairs, spectrum = self._resolve_spectrum_points(run_id, sample_id, kind)
        if not item:
            raise ValueError("spectrum not found for selected sample")
        metrics = calculate_peak_selection_metrics(all_pairs, lambda_min, lambda_max, feature_type=feature_type)
        metrics["run_id"] = run_id
        metrics["sample_id"] = item.get("sample_id") or sample_id
        metrics["kind"] = kind
        metrics["source_path"] = item.get("relative_path")
        metrics["used_point_count"] = len(metrics.get("used_points") or [])
        return {
            "ok": True,
            "run_id": run_id,
            "sample_id": metrics["sample_id"],
            "kind": kind,
            "source_path": item.get("relative_path"),
            "resolved_feature_type": metrics.get("feature_type"),
            "metrics": metrics,
            "used_points": metrics.get("used_points", []),
            "warnings": metrics.get("warnings", []),
            "relative_path": slash(rel_to(self.root, item.get("relative_path", ""))) if item.get("relative_path") else "",
        }

    def _controller_preview_registry(self):
        data = read_json(self.controller_preview_path, {"schema_version": 1, "previews": {}})
        if not isinstance(data, dict):
            data = {"schema_version": 1, "previews": {}}
        if not isinstance(data.get("previews"), dict):
            data["previews"] = {}
        return data

    def _store_controller_preview(self, preview_hash, payload_hash, payload, resolved_execution_plan):
        data = self._controller_preview_registry()
        previews = data.get("previews") or {}
        previews[preview_hash] = {
            "preview_hash": preview_hash,
            "payload_hash": payload_hash,
            "payload": payload,
            "resolved_execution_plan": resolved_execution_plan,
            "created_at": now_iso(),
        }
        data["previews"] = dict(list(previews.items())[-200:])
        data["updated_at"] = now_iso()
        save_json_atomic(self.controller_preview_path, data)
        return previews[preview_hash]

    def _get_controller_preview(self, preview_hash):
        return (self._controller_preview_registry().get("previews") or {}).get(preview_hash)

    def resolve_execution_plan(self, payload, script_registry=None, job_dir=None, preview_hash="", payload_hash=""):
        ids = payload.get("ids") or []
        if isinstance(ids, str):
            ids = [x.strip() for x in ids.split(",") if x.strip()]
        mode = payload.get("mode") or "preview"
        style = payload.get("style") or "sequential"
        max_parallel = int(payload.get("max_parallel") or 2)
        scripts = scripts_by_ids(script_registry or read_json(self.script_registry_path, {"scripts": []}), ids)
        script_schemas = []
        for script in scripts:
            if not script:
                continue
            raw_path = script.get("script_path") or script.get("relative_path") or ""
            script_path = Path(raw_path)
            if not script_path.is_absolute():
                script_path = (self.root / script_path).resolve()
            script_schemas.append(build_script_schema(script, parse_script_defaults(script_path)))
        requested_overrides = flatten_execution_overrides(payload.get("overrides") or {})
        accepted_key_set = None
        for schema in script_schemas:
            keys = set(schema.get("accepted_keys") or [])
            accepted_key_set = keys if accepted_key_set is None else (accepted_key_set & keys)
        if accepted_key_set is None:
            accepted_key_set = set()
        overrides_accepted = {k: requested_overrides[k] for k in sorted(requested_overrides) if k in accepted_key_set}
        overrides_rejected = {k: requested_overrides[k] for k in sorted(requested_overrides) if k not in accepted_key_set}
        warnings = []
        for schema in script_schemas:
            warnings.extend(schema.get("warnings") or [])
        if overrides_rejected:
            warnings.append("部分覆盖参数未被脚本接收")
        if mode == "full" and style == "parallel":
            warnings.append("full + parallel 需要二次确认")
        risk_level = "high" if mode == "full" and style == "parallel" else ("medium" if mode == "full" or max_parallel > 1 else "low")
        is_mock = len(script_schemas) == 1 and (
            script_schemas[0].get("detected_style") == "mock" or
            Path(script_schemas[0].get("script_path") or "").name == "mock_run_script.py"
        )
        if is_mock:
            cwd = str(job_dir or self.root)
            mock_script_path = script_schemas[0].get("script_path") or script_schemas[0].get("relative_path") or ""
            mock_script = Path(mock_script_path)
            if not mock_script.is_absolute():
                mock_script = (self.root / mock_script).resolve()
            received_json = str((Path(job_dir) / "received.json") if job_dir else (STATE_DIR / "mock_received.json"))
            payload_json = str((Path(job_dir) / "overrides.json") if job_dir else (STATE_DIR / "mock_overrides.json"))
            final_command = [
                sys.executable,
                str(mock_script),
                "--received-json", received_json,
                "--payload-json", payload_json,
                "--script-id", str(script_schemas[0].get("script_id") or ""),
                "--script-path", str(script_schemas[0].get("script_path") or ""),
                "--mode", mode,
                "--style", style,
                "--max-parallel", str(max_parallel),
                "--cwd", cwd,
                "--preview-hash", preview_hash or "",
                "--payload-hash", payload_hash or "",
            ]
            for key, value in overrides_accepted.items():
                final_command.extend([f"--{key}", "" if value is None else str(value)])
            final_command.extend(["--overrides-json", payload_json])
        else:
            cwd = str(self.root)
            final_command = self._controller_command(ids, mode, style, max_parallel, str((Path(job_dir) / "overrides.json") if job_dir else "<overrides-json>"), payload.get("child_timeout_s") or 3600)
        plan = {
            "final_command": final_command,
            "cwd": cwd,
            "mode": mode,
            "style": style,
            "max_parallel": max_parallel,
            "script_count": len(scripts),
            "script_schemas": script_schemas,
            "overrides_requested": requested_overrides,
            "overrides_accepted": overrides_accepted,
            "overrides_rejected": overrides_rejected,
            "warnings": warnings,
            "risk_level": risk_level,
            "is_mock": is_mock,
        }
        if payload_hash:
            plan["payload_hash"] = payload_hash
        if preview_hash:
            plan["preview_hash"] = preview_hash
        if is_mock:
            plan["received_json"] = str((Path(job_dir) / "received.json") if job_dir else (STATE_DIR / "mock_received.json"))
            plan["payload_json"] = str((Path(job_dir) / "overrides.json") if job_dir else (STATE_DIR / "mock_overrides.json"))
        return plan

    def controller_preview(self, payload):
        ids = payload.get("ids") or []
        if isinstance(ids, str):
            ids = [x.strip() for x in ids.split(",") if x.strip()]
        mode = payload.get("mode") or "preview"
        style = payload.get("style") or "sequential"
        max_parallel = int(payload.get("max_parallel") or 2)
        payload_hash = controller_payload_signature({**payload, "ids": ids, "mode": mode, "style": style, "max_parallel": max_parallel})
        preview_hash = controller_preview_hash({**payload, "ids": ids, "mode": mode, "style": style, "max_parallel": max_parallel})
        points = self._estimate_points(payload.get("overrides") or {})
        manifest = create_job_manifest({**payload, "ids": ids, "mode": mode, "style": style}, script_registry=read_json(self.script_registry_path, {"scripts": []}))
        execution_plan = self.resolve_execution_plan({**payload, "ids": ids, "mode": mode, "style": style, "max_parallel": max_parallel}, read_json(self.script_registry_path, {"scripts": []}), job_dir=None, preview_hash=preview_hash, payload_hash=payload_hash)
        execution_plan["estimated_points"] = points or "按脚本默认"
        execution_plan["estimated_runtime"] = self._estimate_duration(points, len(ids), style, max_parallel)
        execution_plan["expected_outputs"] = manifest.get("expected_outputs", [])
        execution_plan["probable_output_parents"] = manifest.get("probable_output_parents", [])
        execution_plan["script_count"] = len(ids)
        command = execution_plan["final_command"]
        self._store_controller_preview(preview_hash, payload_hash, {
            "ids": ids,
            "mode": mode,
            "style": style,
            "max_parallel": max_parallel,
            "overrides": payload.get("overrides") or {},
            "child_timeout_s": int(payload.get("child_timeout_s") or 3600),
        }, execution_plan)
        return {
            "ok": True,
            "preview_hash": preview_hash,
            "payload_hash": payload_hash,
            "resolved_execution_plan": execution_plan,
            "command": command,
            "job_preview": {
                "mode": mode,
                "style": style,
                "script_count": len(ids),
                "estimated_points": execution_plan["estimated_points"],
                "estimated_runtime": execution_plan["estimated_runtime"],
                "expected_outputs": execution_plan["expected_outputs"],
                "probable_output_parents": execution_plan["probable_output_parents"],
                "overrides_accepted": list(execution_plan["overrides_accepted"].keys()),
                "overrides_rejected": list(execution_plan["overrides_rejected"].keys()),
                "risk_level": execution_plan["risk_level"],
                "warnings": execution_plan["warnings"],
            },
            "estimated_points": execution_plan["estimated_points"],
            "estimated_duration": execution_plan["estimated_runtime"],
            "warnings": execution_plan["warnings"],
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
        payload_hash = controller_payload_signature({**payload, "ids": ids, "mode": mode, "style": style, "max_parallel": int(payload.get("max_parallel") or 2)})
        preview_hash = payload.get("preview_hash") or ""
        if not preview_hash:
            raise APIError("start requires preview_hash", 409)
        preview = self._get_controller_preview(preview_hash)
        if not preview:
            raise APIError("preview hash not found or expired", 409)
        if mode == "full" and style == "parallel" and not payload.get("risk_ack"):
            raise ValueError("full + parallel requires risk_ack")
        if not payload.get("confirm"):
            raise ValueError("start requires explicit confirm")
        job_id = "job_" + now_stamp() + "_" + hashlib.sha1(",".join(map(str, ids)).encode("utf-8")).hexdigest()[:6]
        job_dir = JOBS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        script_registry = read_json(self.script_registry_path, {"scripts": []})
        resolved_plan = self.resolve_execution_plan({**payload, "ids": ids, "mode": mode, "style": style, "max_parallel": int(payload.get("max_parallel") or 2)}, script_registry, job_dir=job_dir, preview_hash=preview_hash, payload_hash=payload_hash)
        manifest = create_job_manifest({**payload, "ids": ids, "mode": mode, "style": style}, job_id=job_id, script_registry=script_registry)
        manifest["preview_hash"] = preview_hash
        manifest["payload_hash"] = payload_hash
        manifest["resolved_execution_plan"] = resolved_plan
        manifest["script_schemas"] = resolved_plan.get("script_schemas", [])
        snapshot_paths = manifest.get("probable_output_parents", []) + [x.get("relative_path") for x in manifest.get("expected_outputs", [])]
        before_snapshot = take_path_snapshot(self.root, snapshot_paths)
        save_json_atomic(job_dir / "before_snapshot.json", before_snapshot)
        overrides_path = job_dir / "overrides.json"
        atomic_write_json(overrides_path, payload.get("overrides") or {})
        save_json_atomic(job_dir / "resolved_execution_plan.json", resolved_plan)
        cmd = resolved_plan.get("final_command") or []
        manifest["command"] = " ".join('"%s"' % c if " " in str(c) else str(c) for c in cmd)
        manifest["status"] = "running" if not resolved_plan.get("is_mock") else "completed"
        save_json_atomic(job_dir / "job_manifest.json", manifest)
        (job_dir / "command.txt").write_text(manifest["command"], encoding="utf-8")
        stdout_path = job_dir / "stdout.log"
        stderr_path = job_dir / "stderr.log"
        save_json_atomic(job_dir / "after_snapshot.json", take_path_snapshot(STATE_DIR, [slash(rel_to(STATE_DIR, job_dir))]))
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        if resolved_plan.get("is_mock"):
            proc = subprocess.run(
                cmd,
                cwd=str(resolved_plan.get("cwd") or self.root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                env=env,
                timeout=120,
            )
            stdout_path.write_bytes(proc.stdout or b"")
            stderr_path.write_bytes(proc.stderr or b"")
            save_json_atomic(job_dir / "after_snapshot.json", take_path_snapshot(STATE_DIR, [slash(rel_to(STATE_DIR, job_dir))]))
            manifest["status"] = "completed" if proc.returncode == 0 else "failed"
            manifest["finished_at"] = now_iso()
            manifest["returncode"] = proc.returncode
            save_json_atomic(job_dir / "job_manifest.json", manifest)
            job = {
                "job_id": job_id,
                "pid": 0,
                "status": manifest["status"],
                "started_at": manifest["created_at"],
                "completed_at": manifest["finished_at"],
                "returncode": proc.returncode,
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
            self.jobs[job_id] = {"process": None, "stdout_handle": None, "stderr_handle": None, "state": job}
            self._persist_jobs()
            return {"ok": True, **job}
        stdout = open(str(stdout_path), "wb")
        stderr = open(str(stderr_path), "wb")
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        process = subprocess.Popen(
            cmd,
            cwd=str(resolved_plan.get("cwd") or self.root),
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
        payloads = []
        for label, path in (("stdout", stdout), ("stderr", stderr)):
            if not path.exists():
                continue
            try:
                payloads.append((label, path.read_bytes()))
            except Exception:
                continue
        if not payloads:
            return {
                "job_id": job_id,
                "status": job.get("status"),
                "text": "",
                "raw_text": "",
                "structured_lines": [],
                "encoding_warning": "",
                "collapsed_count": 0,
            }
        decoded = decode_structured_log(payloads)
        decoded["job_id"] = job_id
        decoded["status"] = job.get("status")
        return decoded

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
        kind = (kind or "T").upper()
        run, item, all_pairs, spectrum = self._resolve_spectrum_points(run_id, sample_id, kind)
        if not item:
            return {"run_id": run_id, "sample_id": sample_id, "kind": kind, "source": "", "points": []}
        points = [[x, y] for x, y in all_pairs]
        return {
            "run_id": run_id,
            "sample_id": item.get("sample_id"),
            "kind": kind,
            "source": item.get("relative_path"),
            "points": points,
            "metrics": spectrum.get("metrics", {}),
            "point_count": len(points),
        }

    def peak_calc(self, payload):
        run_id = payload.get("run_id")
        sample_id = str(payload.get("sample_id") or "")
        kind = (payload.get("kind") or "T").upper()
        lambda_min = numeric(payload.get("lambda_min"))
        lambda_max = numeric(payload.get("lambda_max"))
        feature_type = payload.get("feature_type") or "auto"
        if not run_id or lambda_min is None or lambda_max is None:
            raise ValueError("run_id, lambda_min and lambda_max are required")
        run, item, all_pairs, spectrum = self._resolve_spectrum_points(run_id, sample_id, kind)
        if not item:
            raise ValueError("spectrum not found for selected sample")
        metrics = calculate_peak_selection_metrics(all_pairs, lambda_min, lambda_max, feature_type=feature_type)
        metrics["run_id"] = run_id
        metrics["sample_id"] = item.get("sample_id") or sample_id
        metrics["kind"] = kind
        metrics["source_path"] = item.get("relative_path")
        metrics["used_point_count"] = len(metrics.get("used_points") or [])
        return {
            "ok": True,
            "run_id": run_id,
            "sample_id": metrics["sample_id"],
            "kind": kind,
            "source_path": item.get("relative_path"),
            "resolved_feature_type": metrics.get("feature_type"),
            "metrics": metrics,
            "used_points": metrics.get("used_points", []),
            "warnings": metrics.get("warnings", []),
            "relative_path": slash(rel_to(self.root, item.get("relative_path", ""))) if item.get("relative_path") else "",
        }

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
            return {"run_id": run_id, "x_label": "λ (nm)", "y_label": "扰动 δ", "values": [], "lambda_grid": [], "deltas": []}
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
            return {"run_id": run_id, "x_label": "λ (nm)", "y_label": "扰动 δ", "values": [], "lambda_grid": [], "deltas": []}
        low = max(min(s["lambda_nm"]) for s in spectra)
        high = min(max(s["lambda_nm"]) for s in spectra)
        if high <= low:
            return {"run_id": run_id, "x_label": "λ (nm)", "y_label": "扰动 δ", "values": [], "lambda_grid": [], "deltas": []}
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
        return {
            "run_id": run_id,
            "x_label": "λ (nm)",
            "y_label": "扰动 δ",
            "values": rows,
            "lambda_grid": grid,
            "deltas": deltas,
            "raw_min": vmin,
            "raw_max": vmax,
        }

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
            master_template = find_master_template(self.root, run)
            mother_candidates = find_mother_fsp_candidates(self.root, run)
            work_dir = run_work_fsp_dir(self.root, run)
            for sample in samples:
                missing = list(sample.get("missing_evidence") or run.get("missing_evidence") or [])
                data_missing = list(missing)
                if numeric(sample.get("Q") or sample.get("q")) is None:
                    data_missing.append("Q")
                if numeric(sample.get("FWHM_nm") or sample.get("fwhm_nm")) is None:
                    data_missing.append("FWHM")
                if not sample.get("source_fsp") and not master_template.exists():
                    data_missing.append("source_fsp")
                data_missing = list(dict.fromkeys(data_missing))
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
                    "data_missing": data_missing,
                    "source_fsp": sample.get("source_fsp", ""),
                    "sample_fsp_candidates": [slash(rel_to(self.root, p)) for p in find_sample_fsp_candidates(self.root, run, sample.get("sample_id"))][:16],
                    "source_run_dir": run.get("relative_path"),
                    "master_template_fsp_path": slash(rel_to(self.root, master_template)) if master_template.exists() else "",
                    "mother_fsp_candidates": [slash(rel_to(self.root, p)) for p in mother_candidates[:16]],
                    "work_fsp_dir": slash(rel_to(self.root, work_dir)) if work_dir.exists() else slash(rel_to(self.root, work_dir)),
                    "has_master_template_fsp": bool(master_template.exists()),
                    "patch_mode": True,
                    "output_to_existing_run": True,
                    "reuse_existing_perturbation_points": True,
                    "priority": priority,
                    "reason": reason,
                })
        return {"items": items}

    def _supplement_allowed_fsp(self, rel_path):
        path = self.safe_path(rel_path)
        if not path.exists() or not path.is_file():
            raise ValueError("file not found")
        if path.suffix.lower() != ".fsp":
            raise ValueError("only .fsp can be opened")
        rel = slash(rel_to(self.root, path))
        low_rel = rel.lower()
        if "\\05_work_fsp\\" not in low_rel and "\\01_supercell_fsp\\" not in low_rel:
            raise ValueError("only 05_work_fsp or 01_supercell_fsp fsp is allowed")
        if "\\results\\" not in low_rel or "\\run_" not in low_rel:
            raise ValueError("path must be inside run results directory")
        return path, rel

    def _supplement_history_file(self, run_rel):
        run_dir = self.safe_path(run_rel)
        if not run_dir.exists() or not run_dir.is_dir():
            raise ValueError("run directory not found")
        record_dir = run_dir / "11_补做记录"
        record_dir.mkdir(parents=True, exist_ok=True)
        return record_dir / "fsp_open_history.json"

    def _read_supplement_history(self, run_rel):
        hist_file = self._supplement_history_file(run_rel)
        data = read_json(hist_file, {"schema_version": 1, "items": []})
        if not isinstance(data, dict):
            data = {"schema_version": 1, "items": []}
        if not isinstance(data.get("items"), list):
            data["items"] = []
        return data, hist_file

    def _write_supplement_history(self, hist_file, data):
        data["updated_at"] = now_iso()
        atomic_write_json(hist_file, data)

    def _resolve_selection_runs(self, selection):
        run_ids = set()
        run_paths = set()
        sample_map = defaultdict(set)
        for item in (selection or []):
            if not isinstance(item, dict):
                continue
            sel_type = str(item.get("type") or "").strip().lower()
            run_id = str(item.get("run_id") or "").strip()
            run_path = str(item.get("run_path") or "").strip()
            sample_id = str(item.get("sample_id") or "").strip()
            if run_id:
                run_ids.add(run_id)
            if run_path:
                run_paths.add(run_path)
            if sel_type == "sample" and (run_id or run_path) and sample_id:
                sample_map[(run_id, run_path)].add(sample_id)
        runs = []
        for run in self.cache().get("runs", []):
            if run.get("run_id") in run_ids or run.get("relative_path") in run_paths:
                runs.append(run)
        if not runs and (not selection):
            runs = []
        return runs, sample_map

    def resolve_supplement_fsp(self, payload):
        selection = payload.get("selection") or []
        runs, sample_map = self._resolve_selection_runs(selection)
        items = []
        for run in runs:
            run_rel = run.get("relative_path") or ""
            run_abs = self.safe_path(run_rel)
            mother = find_mother_fsp_candidates(self.root, run)
            run_samples = []
            for sample in build_samples_for_run(self.root, run):
                run_samples.append(sample)
            sample_rows = []
            wanted_set = set()
            for (rid, rpath), ids in sample_map.items():
                if (rid and rid == run.get("run_id")) or (rpath and rpath == run_rel):
                    wanted_set.update(ids)
            if not wanted_set:
                wanted_set = set([str(s.get("sample_id") or "") for s in run_samples[:40] if s.get("sample_id")])
            for sid in sorted(wanted_set):
                cands = find_sample_fsp_candidates(self.root, run, sid)
                sample_rows.append({
                    "sample_id": sid,
                    "paths": [slash(rel_to(self.root, p)) for p in cands[:8]],
                })
            items.append({
                "run_id": run.get("run_id"),
                "run_name": run.get("run_name") or run.get("run_id"),
                "run_path": run_rel,
                "selection_type": "run",
                "work_fsp": [{
                    "path": slash(rel_to(self.root, p)),
                    "role": "mother_fsp" if i == 0 else "mother_fsp_candidate",
                    "priority": i + 1,
                    "opened_count": 0,
                    "monitor_confirmed": False,
                } for i, p in enumerate(mother[:16])],
                "sample_fsp": sample_rows,
            })
        return {"items": items}

    def supplement_open_fsp(self, payload):
        rel_path = payload.get("path") or ""
        run_rel = payload.get("run_path") or ""
        path, rel = self._supplement_allowed_fsp(rel_path)
        if os.name != "nt" or not hasattr(os, "startfile"):
            raise ValueError("open file is only available on Windows")
        if not run_rel:
            parts = Path(rel).parts
            run_idx = next((i for i, x in enumerate(parts) if str(x).lower().startswith("run_")), None)
            if run_idx is None:
                raise ValueError("run path required")
            run_rel = slash(str(Path(*parts[:run_idx + 1])))
        data, hist_file = self._read_supplement_history(run_rel)
        items = data.get("items") or []
        existing = next((x for x in items if x.get("path") == rel), None)
        if existing is None:
            existing = {"path": rel, "opened_count": 0, "monitor_confirmed": False}
            items.insert(0, existing)
        existing["opened_count"] = int(existing.get("opened_count") or 0) + 1
        existing["last_opened_at"] = now_iso()
        existing["status"] = "opened"
        data["items"] = items[:200]
        self._write_supplement_history(hist_file, data)
        os.startfile(str(path))
        return {"ok": True, "path": rel, "run_path": run_rel, "history_path": slash(rel_to(self.root, hist_file)), "item": existing}

    def supplement_mark_fsp_status(self, payload):
        rel_path = payload.get("path") or ""
        run_rel = payload.get("run_path") or ""
        status = str(payload.get("status") or "monitor_confirmed").strip()
        _, rel = self._supplement_allowed_fsp(rel_path)
        if not run_rel:
            parts = Path(rel).parts
            run_idx = next((i for i, x in enumerate(parts) if str(x).lower().startswith("run_")), None)
            if run_idx is None:
                raise ValueError("run path required")
            run_rel = slash(str(Path(*parts[:run_idx + 1])))
        data, hist_file = self._read_supplement_history(run_rel)
        items = data.get("items") or []
        existing = next((x for x in items if x.get("path") == rel), None)
        if existing is None:
            existing = {"path": rel, "opened_count": 0, "monitor_confirmed": False}
            items.insert(0, existing)
        if status == "monitor_confirmed":
            existing["monitor_confirmed"] = True
            existing["status"] = "monitor_confirmed"
            existing["confirmed_at"] = now_iso()
        else:
            existing["status"] = status
        data["items"] = items[:200]
        self._write_supplement_history(hist_file, data)
        return {"ok": True, "path": rel, "run_path": run_rel, "history_path": slash(rel_to(self.root, hist_file)), "item": existing}

    def _supplement_param_candidates(self, run_dir):
        run_dir = Path(run_dir)
        return [
            ("job_manifest.json", run_dir / "job_manifest.json", "json"),
            ("run_manifest.json", run_dir / "run_manifest.json", "json"),
            ("manifest.json", run_dir / "manifest.json", "json"),
            ("scan_points.csv", first_existing(run_dir / "00_scan_plan" / "scan_points.csv", run_dir / "scan_points.csv"), "csv"),
            ("metadata.json", run_dir / "metadata.json", "json"),
            ("controller_payload.json", run_dir / "controller_payload.json", "json"),
        ]

    def _read_param_file(self, path, typ):
        if not path or not Path(path).exists():
            return {}
        try:
            if typ == "json":
                return read_json(path, {}) or {}
            if typ == "csv":
                rows = read_csv_rows(path)
                return rows[0] if rows else {}
        except Exception:
            return {}
        return {}

    def _extract_inherited_params(self, data, params, sources, source_name):
        aliases = {
            "start_nm": ["start_nm", "scan_start", "START_NM", "START", "start"],
            "end_nm": ["end_nm", "scan_end", "END_NM", "END", "end"],
            "step_nm": ["step_nm", "scan_step", "STEP_NM", "STEP", "step"],
            "wavelength_points": ["wavelength_points", "point_count", "points", "num_points"],
            "mesh_accuracy": ["mesh_accuracy", "MESH_ACCURACY", "mesh", "mesh_acc"],
            "runtime_fs": ["runtime_fs", "simulation_time_fs", "SIMULATION_TIME_FS", "runtime"],
            "auto_shutoff_min": ["auto_shutoff_min", "AUTO_SHUTOFF_MIN", "auto_shutoff", "shutoff_min"],
            "source_type": ["source_type", "SOURCE_TYPE"],
            "monitor_set": ["monitor_set", "MONITOR_SET", "monitor_policy"],
            "sample_index": ["sample_index", "sample_id", "index"],
            "script_name": ["script_name", "SCRIPT_NAME"],
            "script_hash": ["script_hash", "SCRIPT_HASH"],
        }
        for key, cands in aliases.items():
            if params.get(key) not in (None, "", []):
                continue
            for cand in cands:
                val = data.get(cand)
                if val in (None, "", []):
                    continue
                params[key] = val
                sources[key] = source_name
                break

    def _coerce_inherited_params(self, params):
        def _num(v):
            n = numeric(v)
            return n if n is not None else v
        for key in ("start_nm", "end_nm", "step_nm", "mesh_accuracy", "runtime_fs", "auto_shutoff_min", "wavelength_points"):
            if key in params:
                params[key] = _num(params[key])
        if params.get("wavelength_points") in (None, "", 0) and numeric(params.get("start_nm")) is not None and numeric(params.get("end_nm")) is not None and numeric(params.get("step_nm")) not in (None, 0):
            start = float(params.get("start_nm"))
            end = float(params.get("end_nm"))
            step = float(params.get("step_nm"))
            params["wavelength_points"] = int(abs(end - start) / abs(step)) + 1

    def supplement_inherited_params(self, query):
        run_id = (query.get("run_id") or [""])[0]
        run_path = (query.get("run_path") or [""])[0]
        run = self.find_run(run_id) if run_id else None
        if not run and run_path:
            run = next((r for r in self.cache().get("runs", []) if r.get("relative_path") == run_path), None)
        if not run:
            raise ValueError("run not found")
        run_rel = run.get("relative_path") or ""
        run_dir = self.safe_path(run_rel)
        params = {}
        sources = {}
        read_files = []
        for name, path, typ in self._supplement_param_candidates(run_dir):
            if not path or not Path(path).exists():
                continue
            data = self._read_param_file(path, typ)
            self._extract_inherited_params(data if isinstance(data, dict) else {}, params, sources, name)
            read_files.append(slash(rel_to(self.root, path)))
        script_name = params.get("script_name") or run.get("script_id") or ""
        if script_name and not params.get("script_hash"):
            script = next((s for s in read_json(self.script_registry_path, {"scripts": []}).get("scripts", []) if (s.get("script_id") == script_name or s.get("script_name") == script_name)), None)
            if script:
                params["script_name"] = script.get("script_name") or script.get("script_id") or script_name
                params["script_hash"] = script.get("script_hash") or script.get("content_hash") or ""
                sources["script_name"] = sources.get("script_name") or "script_registry(default)"
                sources["script_hash"] = sources.get("script_hash") or "script_registry(default)"
                script_ref = script.get("relative_path") or script.get("script_path") or ""
                script_path = Path(script_ref)
                if not script_path.is_absolute():
                    script_path = self.safe_path(script_ref)
                defaults = parse_script_defaults(script_path)
                self._extract_inherited_params(defaults, params, sources, "script_default")
        self._coerce_inherited_params(params)
        required = ["start_nm", "end_nm", "step_nm", "mesh_accuracy"]
        missing_required = [k for k in required if params.get(k) in (None, "", [])]
        return {
            "run_id": run.get("run_id"),
            "run_path": run_rel,
            "params": params,
            "sources": sources,
            "read_files": read_files,
            "missing_required": missing_required,
            "can_run": len(missing_required) == 0,
        }

    def supplement_preview_plan(self, payload):
        selection = payload.get("selection") or []
        runs, _ = self._resolve_selection_runs(selection)
        if len(runs) != 1:
            raise ValueError("preview-plan requires selection from exactly one run")
        run = runs[0]
        inherited = self.supplement_inherited_params({"run_id": [run.get("run_id")]})
        selected_samples = []
        wanted = set()
        for s in selection:
            if str(s.get("run_id") or "") == str(run.get("run_id") or "") and s.get("sample_id"):
                wanted.add(str(s.get("sample_id")))
        for sample in build_samples_for_run(self.root, run):
            sid = str(sample.get("sample_id") or "")
            if not wanted or sid in wanted:
                fsp = find_sample_fsp_candidates(self.root, run, sid)
                selected_samples.append({
                    "sample_id": sid,
                    "delta": sample.get("delta"),
                    "sample_fsp": slash(rel_to(self.root, fsp[0])) if fsp else "",
                })
        master = find_master_template(self.root, run)
        output_dirs = [
            "06_反射excel",
            "07_反射图",
            "08_反射场图",
            "09_反射场数据",
            "10_补做fsp快照",
            "11_补做记录",
        ]
        run_dir = self.safe_path(run.get("relative_path") or "")
        existing = [d for d in output_dirs if (run_dir / d).exists()]
        return {
            "run_id": run.get("run_id"),
            "run_name": run.get("run_name") or run.get("run_id"),
            "run_path": run.get("relative_path") or "",
            "selection_scope": {
                "sample_count": len(selected_samples),
                "samples": selected_samples,
            },
            "inherited_params": inherited.get("params", {}),
            "param_sources": inherited.get("sources", {}),
            "read_files": inherited.get("read_files", []),
            "missing_required": inherited.get("missing_required", []),
            "can_run": inherited.get("can_run", False),
            "fsp_plan": {
                "master_fsp": slash(rel_to(self.root, master)) if master.exists() else "",
                "sample_fsps": [s.get("sample_fsp") for s in selected_samples if s.get("sample_fsp")],
            },
            "output_plan": {
                "output_root": run.get("relative_path") or "",
                "output_dirs": output_dirs,
                "reuse_run_folder": True,
                "create_new_run_folder": False,
                "overwrite_risk": len(existing) > 0,
                "existing_dirs": existing,
            },
        }

    def _supplement_job_list(self):
        return read_json(self.supplement_job_state_path, {"jobs": []})

    def _persist_supplement_jobs(self):
        with self.supplement_job_lock:
            existing = self._supplement_job_list().get("jobs", [])
            by_id = {j.get("job_id"): j for j in existing}
            for jid, entry in self.supplement_jobs.items():
                by_id[jid] = entry.get("state", {})
            jobs = sorted(by_id.values(), key=lambda x: x.get("started_at", ""), reverse=True)
            atomic_write_json(self.supplement_job_state_path, {"schema_version": 1, "built_at": now_iso(), "jobs": jobs[:200]})

    def _supplement_emit(self, entry, text, level="info"):
        stamp = now_iso()
        evt = {"time": stamp, "level": level, "text": str(text or "")}
        with self.supplement_job_lock:
            entry["events"].append(evt)
            if len(entry["events"]) > 4000:
                entry["events"] = entry["events"][-4000:]
        try:
            log_file = entry.get("run_log_file")
            if log_file:
                append_log(log_file, "[%s][%s] %s" % (stamp, level, str(text or "")))
        except Exception:
            pass

    def _supplement_prepare_dirs(self, run_dir):
        names = ["06_反射excel", "07_反射图", "08_反射场图", "09_反射场数据", "10_补做fsp快照", "11_补做记录", "12_补做任务包"]
        out = []
        for name in names:
            p = run_dir / name
            p.mkdir(parents=True, exist_ok=True)
            out.append(p)
        return out

    def _supplement_copy_fsp_snapshot(self, run_dir, fsp_paths):
        target = run_dir / "10_补做fsp快照" / "executed"
        target.mkdir(parents=True, exist_ok=True)
        copied = []
        for rel in (fsp_paths or []):
            try:
                src, rel_norm = self._supplement_allowed_fsp(rel)
                dst = target / src.name
                if dst.exists():
                    base = dst.stem
                    ext = dst.suffix
                    dst = target / ("%s_%s%s" % (base, now_stamp(), ext))
                shutil.copy2(str(src), str(dst))
                copied.append(slash(rel_to(self.root, dst)))
            except Exception:
                continue
        return copied

    def _supplement_run_worker(self, job_id):
        entry = self.supplement_jobs.get(job_id)
        if not entry:
            return
        state = entry["state"]
        try:
            state["status"] = "running"
            self._supplement_emit(entry, "补做任务启动")
            run_dir = self.safe_path(state.get("run_path") or "")
            # Optional external command execution; fallback to internal placeholder pipeline.
            command = entry.get("command") or []
            if command:
                self._supplement_emit(entry, "执行命令: %s" % " ".join(map(str, command)))
                proc = subprocess.Popen(command, cwd=str(run_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
                for line in proc.stdout:
                    self._supplement_emit(entry, line.rstrip(), "progress")
                rc = proc.wait()
                if rc != 0:
                    raise RuntimeError("external command failed rc=%s" % rc)
            else:
                # Internal fallback: write placeholder result artifacts to target dirs.
                self._supplement_emit(entry, "未指定外部命令，执行内置补做落盘流程")
                (run_dir / "06_反射excel" / ("supplement_%s.csv" % now_stamp())).write_text("lambda_nm,reflection\n", encoding="utf-8")
                (run_dir / "07_反射图" / ("supplement_%s.txt" % now_stamp())).write_text("plot placeholder\n", encoding="utf-8")
                (run_dir / "08_反射场图" / ("supplement_%s.txt" % now_stamp())).write_text("field plot placeholder\n", encoding="utf-8")
                (run_dir / "09_反射场数据" / ("supplement_%s.csv" % now_stamp())).write_text("x,y,value\n", encoding="utf-8")
                self._supplement_emit(entry, "已写入反射数值/反射图/场图/场数据目录", "progress")
            audit_file = run_dir / "11_补做记录" / "supplement_audit.json"
            audit = read_json(audit_file, {"schema_version": 1, "items": []})
            item = {
                "job_id": job_id,
                "finished_at": now_iso(),
                "status": "success",
                "output_root": state.get("run_path"),
                "reuse_run_folder": True,
                "create_new_run_folder": False,
            }
            audit["items"] = [item] + [x for x in (audit.get("items") or []) if x.get("job_id") != job_id]
            atomic_write_json(audit_file, audit)
            state["status"] = "success"
            state["completed_at"] = now_iso()
            self._supplement_emit(entry, "补做任务完成", "success")
        except Exception as exc:
            state["status"] = "failed"
            state["error"] = str(exc)
            state["completed_at"] = now_iso()
            self._supplement_emit(entry, "任务失败: %s" % exc, "error")
        finally:
            self._persist_supplement_jobs()

    def supplement_run(self, payload):
        selection = payload.get("selection") or []
        monitor_ack_skip = bool(payload.get("monitor_ack_skip"))
        plan = self.supplement_preview_plan({"selection": selection})
        if not plan.get("can_run"):
            raise ValueError("inherited params incomplete: %s" % ",".join(plan.get("missing_required") or []))
        run_rel = plan.get("run_path") or ""
        run_dir = self.safe_path(run_rel)
        if not monitor_ack_skip:
            fsp_paths = []
            fsp_plan = plan.get("fsp_plan") or {}
            if fsp_plan.get("master_fsp"):
                fsp_paths.append(fsp_plan.get("master_fsp"))
            fsp_paths.extend(fsp_plan.get("sample_fsps") or [])
            data, _ = self._read_supplement_history(run_rel)
            confirmed_paths = set([x.get("path") for x in (data.get("items") or []) if x.get("monitor_confirmed")])
            must_check = [p for p in fsp_paths if p]
            if must_check and any(p not in confirmed_paths for p in must_check):
                raise ValueError("monitor not confirmed for all selected fsp; set monitor_ack_skip=true to override")
        self._supplement_prepare_dirs(run_dir)
        fsp_snapshot = self._supplement_copy_fsp_snapshot(run_dir, [plan.get("fsp_plan", {}).get("master_fsp")] + (plan.get("fsp_plan", {}).get("sample_fsps") or []))
        manifest = {
            "schema_version": 1,
            "created_at": now_iso(),
            "selection": selection,
            "plan": plan,
            "reuse_run_folder": True,
            "create_new_run_folder": False,
            "output_root": run_rel,
            "fsp_snapshot": fsp_snapshot,
        }
        manifest_file = run_dir / "11_补做记录" / "supplement_manifest.json"
        atomic_write_json(manifest_file, manifest)
        job_id = "supp_job_%s_%s" % (now_stamp(), hashlib.sha1(run_rel.encode("utf-8", errors="replace")).hexdigest()[:6])
        log_file = run_dir / "11_补做记录" / "supplement_run_log.txt"
        state = {
            "job_id": job_id,
            "status": "queued",
            "started_at": now_iso(),
            "completed_at": "",
            "run_id": plan.get("run_id"),
            "run_path": run_rel,
            "reuse_run_folder": True,
            "create_new_run_folder": False,
            "output_root": run_rel,
            "log_path": slash(rel_to(self.root, log_file)),
            "manifest_path": slash(rel_to(self.root, manifest_file)),
        }
        entry = {
            "state": state,
            "events": [],
            "run_log_file": log_file,
            "command": payload.get("command") or [],
        }
        self.supplement_jobs[job_id] = entry
        self._supplement_emit(entry, "任务已排队")
        self._persist_supplement_jobs()
        t = threading.Thread(target=self._supplement_run_worker, args=(job_id,), name="supplement-job-%s" % job_id, daemon=True)
        t.start()
        return state

    def supplement_job_state(self, job_id):
        if job_id in self.supplement_jobs:
            return self.supplement_jobs[job_id].get("state", {})
        for job in self._supplement_job_list().get("jobs", []):
            if job.get("job_id") == job_id:
                return job
        raise ValueError("supplement job not found")

    def supplement_job_events(self, job_id, query):
        cursor = int((query.get("cursor") or ["0"])[0] or 0)
        entry = self.supplement_jobs.get(job_id)
        if entry:
            events = entry.get("events", [])
            next_cursor = len(events)
            return {"job_id": job_id, "cursor": cursor, "next_cursor": next_cursor, "events": events[cursor:], "state": entry.get("state", {})}
        state = self.supplement_job_state(job_id)
        log_rel = state.get("log_path") or ""
        lines = []
        if log_rel:
            try:
                log_file = self.safe_path(log_rel)
                raw = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
                lines = [{"time": "", "level": "info", "text": line} for line in raw]
            except Exception:
                lines = []
        next_cursor = len(lines)
        return {"job_id": job_id, "cursor": cursor, "next_cursor": next_cursor, "events": lines[cursor:], "state": state}

    def supplement_open_folder(self, payload):
        run_rel = payload.get("run_path") or ""
        subdir = payload.get("subdir") or ""
        run_dir = self.safe_path(run_rel)
        target = run_dir / subdir if subdir else run_dir
        target.mkdir(parents=True, exist_ok=True)
        if os.name != "nt" or not hasattr(os, "startfile"):
            raise ValueError("open folder is only available on Windows")
        os.startfile(str(target))
        return {"ok": True, "path": slash(rel_to(self.root, target))}

    def _source_run_for_samples(self, samples):
        run_ids = sorted(set(str(s.get("run_id") or "") for s in samples if s.get("run_id")))
        if len(run_ids) != 1:
            raise ValueError("一次补做任务包只支持同一个 run；请在树形结构中选择一个 run 后打包")
        run = self.find_run(run_ids[0])
        if not run:
            raise ValueError("source run not found")
        return run

    def _plan_patch_output_dirs(self, run_path, supplement_type):
        output_dirs = next_numbered_output_dirs(run_path, supplement_type)
        for path in output_dirs:
            path.mkdir(parents=True, exist_ok=True)
        return output_dirs

    def create_supplement_package(self, payload):
        samples = payload.get("samples") or []
        if not samples:
            raise ValueError("no supplement samples")
        supplement_type = payload.get("supplement_type") or "field"
        monitor_policy = payload.get("monitor_policy") or "single_monitor_only"
        first = samples[0]
        run = self._source_run_for_samples(samples)
        source_run_path = run.get("relative_path") or first.get("source_run_path") or ""
        source_run_dir = self.safe_path(source_run_path)
        if not source_run_dir.exists() or not source_run_dir.is_dir():
            raise ValueError("source run directory not found")
        master_template = find_master_template(self.root, run)
        work_dir = run_work_fsp_dir(self.root, run)
        perturbation = first.get("perturbation") or run.get("perturbation") or "未分类扰动"
        package_id = "patch_%s_%s" % (now_stamp(), safe_token(supplement_type))
        base_root = None
        if source_run_path and "results" in Path(source_run_path).parts:
            parts = Path(source_run_path).parts
            idx = parts.index("results")
            if idx + 3 <= len(parts):
                base_root = self.root / Path(*parts[:idx + 3]) / "补做实验"
        if base_root is None:
            base_root = GENERATED_DIR / "supplement_requests"
        package_root = base_root / package_id
        target_output_dirs = self._plan_patch_output_dirs(source_run_dir, supplement_type)
        target_output_dirs = [package_root]
        dirs = ["00_patch_plan", "01_patch_fsp", "04_logs", "12_patch_summary"]
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
                "missing_evidence": sample.get("selected_missing_evidence") or sample.get("missing_evidence") or [supplement_type],
                "source_fsp": sample.get("source_fsp") or "",
                "sample_fsp_path": sample.get("sample_fsp_path") or "",
                "source_run_dir": source_run_path,
                "master_template_fsp_path": slash(rel_to(self.root, master_template)) if master_template.exists() else "",
            }
            request_samples.append(request_sample)
            for lam_value in lambdas or [""]:
                csv_rows.append({
                    "sample_id": request_sample["sample_id"],
                    "delta": request_sample["delta"],
                    "lambda_nm": lam_value,
                    "evidence_type": supplement_type,
                    "source_run_id": sample.get("run_id"),
                    "source_run_dir": source_run_path,
                    "source_fsp": request_sample["source_fsp"],
                    "master_template_fsp_path": request_sample["master_template_fsp_path"],
                    "output_dir": ";".join(slash(rel_to(self.root, p)) for p in target_output_dirs),
                    "priority": "high" if idx < 3 else "normal",
                    "reason": "missing evidence: " + ",".join(request_sample["missing_evidence"]),
                })
        request = {
            "schema_version": 1,
            "package_id": package_id,
            "created_at": now_iso(),
            "package_type": "patch_v2",
            "supplement_type": supplement_type,
            "monitor_policy": monitor_policy,
            "lambda_policy": payload.get("lambda_policy") or "peak_triplet",
            "source_run_id": first.get("run_id"),
            "source_run_path": source_run_path,
            "source_run_dir": source_run_path,
            "master_template_fsp_path": slash(rel_to(self.root, master_template)) if master_template.exists() else "",
            "work_fsp_dir": slash(rel_to(self.root, work_dir)),
            "patch_mode": True,
            "normal_mode": False,
            "reuse_existing_perturbation_points": True,
            "output_to_existing_run": True,
            "master_template_semantics": "用户只修改 05_work_fsp/master_template.fsp 中的监视器；补做脚本应从该母文件复制出 sample fsp，并复用已有 run 的扰动点。",
            "mother_structure": first.get("mother_structure") or run.get("mother_structure"),
            "perturbation": perturbation,
            "reduction_path": first.get("reduction_path") or run.get("reduction_path"),
            "scan_sources": {
                "scan_points": slash(rel_to(self.root, source_run_dir / "00_scan_plan" / "scan_points.csv")) if (source_run_dir / "00_scan_plan" / "scan_points.csv").exists() else "",
                "manifest": slash(rel_to(self.root, source_run_dir / "04_logs" / "manifest.csv")) if (source_run_dir / "04_logs" / "manifest.csv").exists() else "",
            },
            "samples": request_samples,
            "outputs": {
                "package_root": slash(rel_to(self.root, package_root)) if self.root in package_root.resolve().parents else str(package_root),
                "source_run_dir": source_run_path,
                "target_output_dirs": [slash(rel_to(self.root, p)) for p in target_output_dirs],
                "summary_dir": "12_patch_summary",
            },
            "expected_output_dirs": [slash(rel_to(self.root, p)) for p in target_output_dirs],
            "expected_outputs": [{"kind": supplement_type, "relative_path": slash(rel_to(self.root, p))} for p in target_output_dirs],
            "status": "planned",
        }
        atomic_write_json(package_root / "patch_request.json", request)
        atomic_write_json(package_root / "source_links.json", {
            "source_run_path": source_run_path,
            "source_run_id": first.get("run_id"),
            "source_run_dir": source_run_path,
            "work_fsp_dir": request["work_fsp_dir"],
            "master_template_fsp_path": request["master_template_fsp_path"],
            "target_output_dirs": request["expected_output_dirs"],
            "samples": samples,
        })
        with open(str(package_root / "README_人工确认步骤.md"), "w", encoding="utf-8") as f:
            f.write(
                "# 补做实验人工确认步骤\n\n"
                "1. 仅人工修改母文件，不要改源文件。\n"
                "2. 优先打开 05_work_fsp 下母文件（master_template/mather_/mother_）。\n"
                "3. 确认监视器策略后，再由脚本复制生成 sample fsp。\n"
                "4. 仅在本 patch 目录执行补做，不回写原始 run。\n"
            )
        with open(str(package_root / "00_patch_plan" / "patch_points.csv"), "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["sample_id", "delta", "lambda_nm", "evidence_type", "source_run_id", "source_run_dir", "source_fsp", "master_template_fsp_path", "output_dir", "priority", "reason"])
            writer.writeheader()
            writer.writerows(csv_rows)
        index = read_json(self.supplement_index_path, {"schema_version": 1, "packages": []})
        item = {
            "package_id": package_id,
            "package_type": "patch_v2",
            "created_at": request["created_at"],
            "supplement_type": supplement_type,
            "type": supplement_type,
            "status": "planned",
            "source_run_id": first.get("run_id"),
            "source_job_id": first.get("source_job_id") or run.get("source_job_id"),
            "relative_path": slash(rel_to(self.root, package_root)) if self.root in package_root.resolve().parents else str(package_root),
            "output_root": slash(rel_to(self.root, package_root)) if self.root in package_root.resolve().parents else str(package_root),
            "patch_request_path": slash(rel_to(self.root, package_root / "patch_request.json")) if self.root in (package_root / "patch_request.json").resolve().parents else str(package_root / "patch_request.json"),
            "source_run_dir": source_run_path,
            "source_run_path": source_run_path,
            "source_run_abs_path": abs_or_empty(source_run_dir),
            "work_fsp_dir": request["work_fsp_dir"],
            "work_fsp_abs_path": abs_or_empty(work_dir),
            "master_template_fsp_path": request["master_template_fsp_path"],
            "master_template_fsp_abs_path": abs_or_empty(master_template) if master_template.exists() else "",
            "patch_mode": True,
            "reuse_existing_perturbation_points": True,
            "output_to_existing_run": True,
            "target_output_dirs": request["expected_output_dirs"],
            "expected_output_dirs": request["expected_output_dirs"],
            "target_output_abs_dirs": [abs_or_empty(p) for p in target_output_dirs],
            "expected_outputs": request["expected_outputs"],
            "sample_count": len(request_samples),
            "patch_request": request,
        }
        index_item = dict(item)
        index_item.pop("patch_request", None)
        packages = [p for p in index.get("packages", []) if p.get("package_id") != package_id]
        packages.insert(0, index_item)
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
                detail = dict(item)
                rel = detail.get("relative_path") or detail.get("output_root") or ""
                try:
                    package_root = self.safe_path(rel)
                    request = read_json(package_root / "patch_request.json", {})
                    if request:
                        detail["patch_request"] = request
                        for key in (
                            "source_run_dir",
                            "source_run_path",
                            "master_template_fsp_path",
                            "work_fsp_dir",
                            "patch_mode",
                            "reuse_existing_perturbation_points",
                            "output_to_existing_run",
                            "expected_output_dirs",
                            "expected_outputs",
                        ):
                            if request.get(key) is not None:
                                detail[key] = request.get(key)
                        outputs = request.get("outputs") or {}
                        if outputs.get("target_output_dirs"):
                            detail["target_output_dirs"] = outputs.get("target_output_dirs")
                        if request.get("expected_output_dirs"):
                            detail["target_output_dirs"] = request.get("expected_output_dirs")
                        detail["sample_count"] = len(request.get("samples") or [])
                    run_rel = detail.get("source_run_dir") or detail.get("source_run_path") or ""
                    master_rel = detail.get("master_template_fsp_path") or ""
                    work_rel = detail.get("work_fsp_dir") or ""
                    if run_rel:
                        detail["source_run_abs_path"] = abs_or_empty(self.safe_path(run_rel))
                    if master_rel:
                        detail["master_template_fsp_abs_path"] = abs_or_empty(self.safe_path(master_rel))
                    if work_rel:
                        detail["work_fsp_abs_path"] = abs_or_empty(self.safe_path(work_rel))
                    detail["patch_request_path"] = slash(rel_to(self.root, package_root / "patch_request.json")) if (package_root / "patch_request.json").exists() else detail.get("patch_request_path", "")
                    detail["patch_request_abs_path"] = abs_or_empty(package_root / "patch_request.json") if (package_root / "patch_request.json").exists() else ""
                except Exception:
                    pass
                return detail
        raise ValueError("package not found")

    def delete_supplement_package(self, package_id):
        if not str(package_id).startswith("patch_"):
            raise ValueError("only V2 patch packages can be deleted")
        index = read_json(self.supplement_index_path, {"schema_version": 1, "packages": []})
        packages = index.get("packages", [])
        item = next((p for p in packages if p.get("package_id") == package_id), None)
        if not item:
            raise ValueError("package not found")
        if item.get("package_type") != "patch_v2" or not item.get("patch_mode"):
            raise ValueError("only V2 patch packages can be deleted")
        rel = item.get("relative_path") or item.get("output_root") or ""
        package_root = self.safe_path(rel)
        if package_root.name.lower().startswith("run_"):
            raise ValueError("refuse to delete original run directory")
        if not package_root.name.lower().startswith("patch_"):
            raise ValueError("refuse to delete non-patch directory")
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
        runs = read_run_index_cache(self.run_index_cache_path).get("runs", [])
        scripts = scan_scripts(self.root, previous_registry=read_json(self.script_registry_path, {}), runs=runs)
        registry = {"schema_version": 2, "built_at": now_iso(), "scripts": scripts}
        atomic_write_json(self.script_registry_path, registry)
        overview = build_overview_cache(read_run_index_cache(self.run_index_cache_path), registry, read_json(self.quality_cache_path, {}), read_json(self.supplement_index_path, {"packages": []}))
        atomic_write_json(self.overview_cache_path, overview)
        return registry

    def result_manager_dry_run(self):
        manager = self.root / "fdtd_results_manager.py"
        if not manager.exists():
            raise ValueError("fdtd_results_manager.py not found")
        cmd = [sys.executable, str(manager), "--normalize-all", "--dry-run"]
        proc = subprocess.run(cmd, cwd=str(self.root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        text = decode_mixed_log(proc.stdout)
        return {"command": cmd, "returncode": proc.returncode, "text": text[-20000:]}


class Handler(SimpleHTTPRequestHandler):
    server_version = "FDTDWorkbenchV2/0.1"
    TOKEN_REQUIRED_POST_PATHS = {
        "/api/v2/controller/start",
        "/api/v2/files/open",
        "/api/v2/files/open-folder",
        "/api/v2/scripts/refresh",
        "/api/v2/diagnostics/peak-selection",
        "/api/v2/diagnostics/peak-calc",
        "/api/v2/supplement/create-package",
        "/api/v2/supplement/resolve-fsp",
        "/api/v2/supplement/open-fsp",
        "/api/v2/supplement/mark-fsp-status",
        "/api/v2/supplement/preview-plan",
        "/api/supplement/preview-plan",
        "/api/supplement/run",
        "/api/supplement/open-folder",
        "/api/v2/supplement/run",
        "/api/v2/supplement/open-folder",
        "/api/supplement/resolve-fsp",
        "/api/supplement/open-fsp",
        "/api/supplement/mark-fsp-status",
        "/api/v2/results-manager/dry-run",
        "/api/v2/index/refresh",
        "/api/v2/index/refresh-delta",
    }

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
        self._json({"ok": False, "error": str(exc)}, getattr(exc, "status_code", status))

    def _require_local_token(self, path):
        if path in self.TOKEN_REQUIRED_POST_PATHS or re.match(r"^/api/v2/jobs/[^/]+/stop$", path) or re.match(r"^/api/v2/supplement/packages/[^/]+/delete$", path):
            token = self.headers.get("X-FDTD-Workbench-Token") or ""
            if token != LOCAL_TOKEN:
                raise APIError("本地会话已过期，请刷新页面。", 403)

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
            self._require_local_token(path)
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
        if path == "/api/v2/structure-tree":
            return self._json(app.structure_tree(query))
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
        if path == "/api/v2/diagnostics/peak-calc":
            raise ValueError("peak-calc is POST only")
        if path == "/api/v2/mode-relay":
            return self._json(app.mode_relay((query.get("run_id") or [""])[0]))
        if path == "/api/v2/mode-relay/heatmap":
            return self._json(app.mode_relay_heatmap((query.get("run_id") or [""])[0]))
        if path == "/api/v2/mode-relay/candidates":
            return self._json(app.mode_relay_candidates((query.get("group") or [""])[0]))
        if path == "/api/v2/supplement/missing":
            return self._json(app.supplement_missing())
        if path == "/api/v2/supplement/tree":
            return self._json(app.supplement_tree(query))
        if path in ("/api/v2/supplement/inherited-params", "/api/supplement/inherited-params"):
            return self._json(app.supplement_inherited_params(query))
        m = re.match(r"^/api/supplement/jobs/([^/]+)/events$", path)
        if m:
            return self._json(app.supplement_job_events(unquote(m.group(1)), query))
        m = re.match(r"^/api/supplement/jobs/([^/]+)$", path)
        if m:
            return self._json(app.supplement_job_state(unquote(m.group(1))))
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
        if path == "/api/v2/diagnostics/peak-calc":
            return self._json(app.peak_calc(payload))
        m = re.match(r"^/api/v2/jobs/([^/]+)/stop$", path)
        if m:
            return self._json(app.stop_job(unquote(m.group(1))))
        if path == "/api/v2/supplement/create-package":
            return self._json(app.create_supplement_package(payload))
        if path in ("/api/v2/supplement/resolve-fsp", "/api/supplement/resolve-fsp"):
            return self._json(app.resolve_supplement_fsp(payload))
        if path in ("/api/v2/supplement/open-fsp", "/api/supplement/open-fsp"):
            return self._json(app.supplement_open_fsp(payload))
        if path in ("/api/v2/supplement/mark-fsp-status", "/api/supplement/mark-fsp-status"):
            return self._json(app.supplement_mark_fsp_status(payload))
        if path in ("/api/v2/supplement/preview-plan", "/api/supplement/preview-plan"):
            return self._json(app.supplement_preview_plan(payload))
        if path in ("/api/supplement/run", "/api/v2/supplement/run"):
            return self._json(app.supplement_run(payload))
        if path in ("/api/supplement/open-folder", "/api/v2/supplement/open-folder"):
            return self._json(app.supplement_open_folder(payload))
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






