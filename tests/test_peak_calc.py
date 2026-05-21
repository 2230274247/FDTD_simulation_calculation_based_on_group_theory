from __future__ import annotations

import csv
import json
import math
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server_v2


def patch_runtime_dirs(monkeypatch, base: Path):
    web_dir = base / "project"
    state_dir = base / "runtime_state"
    jobs_dir = state_dir / "jobs"
    run_details_dir = state_dir / "run_details"
    spectrum_cache_dir = state_dir / "spectrum_cache"
    generated_dir = base / "generated"
    template_dir = base / "templates"
    log_dir = base / "logs"
    monkeypatch.setattr(server_v2, "WEB_DIR", web_dir)
    monkeypatch.setattr(server_v2, "STATE_DIR", state_dir)
    monkeypatch.setattr(server_v2, "JOBS_DIR", jobs_dir)
    monkeypatch.setattr(server_v2, "RUN_DETAILS_DIR", run_details_dir)
    monkeypatch.setattr(server_v2, "SPECTRUM_CACHE_DIR", spectrum_cache_dir)
    monkeypatch.setattr(server_v2, "GENERATED_DIR", generated_dir)
    monkeypatch.setattr(server_v2, "TEMPLATE_DIR", template_dir)
    monkeypatch.setattr(server_v2, "LOG_DIR", log_dir)
    for folder in (web_dir, state_dir, jobs_dir, run_details_dir, spectrum_cache_dir, generated_dir, template_dir, log_dir):
        folder.mkdir(parents=True, exist_ok=True)


def write_csv(path: Path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def make_run(tmp_path: Path, name: str, points, delta="0.10"):
    project_root = tmp_path / "project"
    run_path = project_root / name
    spectrum_path = run_path / "02_transmission_excel" / "sample_T.csv"
    scan_points_path = run_path / "00_scan_plan" / "scan_points.csv"
    write_csv(
        spectrum_path,
        ["wavelength_nm", "T"],
        [[lam, val] for lam, val in points],
    )
    write_csv(
        scan_points_path,
        ["sample_id", "delta"],
        [["#1", delta]],
    )
    rel_path = str(run_path.relative_to(project_root)).replace("\\", "/")
    run_id = server_v2.safe_token(run_path.name) + "_" + server_v2.hashlib.sha1(rel_path.encode("utf-8", errors="replace")).hexdigest()[:8]
    server_v2.atomic_write_json(
        server_v2.STATE_DIR / "run_index_cache.json",
        {
            "schema_version": 2,
            "built_at": "2026-05-21T00:00:00",
            "runs": [
                {
                    "run_id": run_id,
                    "run_name": name,
                    "relative_path": rel_path,
                    "group": "C6",
                    "mother_structure": "demo",
                    "perturbation": "demo",
                    "mode": "test",
                    "archive_state": "",
                    "risk_level": "medium",
                    "risk": "medium",
                    "missing_evidence": [],
                    "mtime": spectrum_path.stat().st_mtime,
                    "mtime_iso": "2026-05-21T00:00:00",
                }
            ],
        },
    )
    return project_root, run_path, run_id


def test_peak_calc_and_manual_selection_round_trip(tmp_path, monkeypatch):
    patch_runtime_dirs(monkeypatch, tmp_path)
    points = [
        (640, 0.94),
        (645, 0.90),
        (650, 0.78),
        (655, 0.46),
        (660, 0.22),
        (665, 0.38),
        (670, 0.62),
        (675, 0.82),
        (680, 0.92),
    ]
    project_root, run_path, run_id = make_run(tmp_path, "run_peak_demo", points)
    app = server_v2.WorkbenchApp(project_root, 8787)
    app.run_index_cache_path = server_v2.STATE_DIR / "run_index_cache.json"

    spectrum = app.diagnostics_spectrum(run_id, "#1", "T")
    assert spectrum["point_count"] == len(points)
    assert spectrum["points"][0] == [640, 0.94]

    preview = app.peak_calc(
        {
            "run_id": run_id,
            "sample_id": "#1",
            "kind": "T",
            "lambda_min": 642,
            "lambda_max": 678,
            "feature_type": "auto",
        }
    )
    metrics = preview["metrics"]
    assert preview["ok"] is True
    assert preview["resolved_feature_type"] == "dip"
    assert metrics["lambda0_nm"] == pytest.approx(660, abs=1.0)
    assert metrics["FWHM_nm"] and metrics["FWHM_nm"] > 0
    assert metrics["Q"] and metrics["Q"] > 0
    assert preview["used_points"]
    assert preview["warnings"] == metrics["warnings"]

    saved = app.save_peak_selection(
        {
            "run_id": run_id,
            "sample_id": "#1",
            "kind": "T",
            "lambda_min": 642,
            "lambda_max": 678,
            "feature_type": "auto",
        }
    )
    assert saved["ok"] is True
    target = run_path / "12_analysis_summary" / "v2_peak_selections.json"
    assert target.exists()
    saved_data = json.loads(target.read_text(encoding="utf-8"))
    assert saved_data["selections"][0]["manual_verified"] is True

    detail = app.run_detail(run_id)
    sample = next(row for row in detail["samples"] if str(row.get("sample_id")) == "#1")
    assert sample["manual_verified"] is True
    assert sample["lambda0_nm"] == pytest.approx(saved_data["selections"][0]["metrics"]["lambda0_nm"], abs=1e-6)


def test_peak_calc_supports_forced_peak(tmp_path, monkeypatch):
    patch_runtime_dirs(monkeypatch, tmp_path)
    points = [
        (640, 0.20),
        (645, 0.34),
        (650, 0.56),
        (655, 0.78),
        (660, 0.96),
        (665, 0.82),
        (670, 0.60),
        (675, 0.38),
        (680, 0.26),
    ]
    project_root, _, run_id = make_run(tmp_path, "run_peak_forced", points)
    app = server_v2.WorkbenchApp(project_root, 8787)
    app.run_index_cache_path = server_v2.STATE_DIR / "run_index_cache.json"

    result = app.peak_calc(
        {
            "run_id": run_id,
            "sample_id": "#1",
            "kind": "T",
            "lambda_min": 642,
            "lambda_max": 678,
            "feature_type": "peak",
        }
    )
    assert result["ok"] is True
    assert result["resolved_feature_type"] == "peak"
    assert result["metrics"]["lambda0_nm"] == pytest.approx(660, abs=1.0)
    assert result["metrics"]["used_point_count"] == len(result["used_points"])
