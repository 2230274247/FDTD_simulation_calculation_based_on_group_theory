from __future__ import annotations

import json
from pathlib import Path
import sys

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


def test_mock_execution_plan_round_trip(tmp_path, monkeypatch):
    patch_runtime_dirs(monkeypatch, tmp_path)
    project_root = tmp_path / "project"
    fixture = Path(__file__).resolve().parent / "fixtures" / "mock_run_script.py"
    script_registry_path = server_v2.STATE_DIR / "script_registry.json"
    server_v2.atomic_write_json(script_registry_path, {
        "schema_version": 2,
        "built_at": "2026-05-21T00:00:00",
        "scripts": [
            {
                "id": 1,
                "script_id": "mock_script",
                "script_path": str(fixture),
                "relative_path": "tests/fixtures/mock_run_script.py",
                "group": "C6",
                "mother_structure": "六柱环",
                "perturbation": "交替两组柱子扰动",
                "detected_style": "mock",
                "supports_mode": ["preview", "test", "full"],
                "supports_overrides": True,
                "accepted_keys": ["START_NM", "END_NM", "STEP_NM"],
                "default_values": {"START_NM": 630, "END_NM": 670, "STEP_NM": 0.5},
                "warnings": [],
            }
        ],
    })

    app = server_v2.WorkbenchApp(project_root, 8787)
    app.script_registry_path = script_registry_path

    payload = {
        "ids": ["mock_script"],
        "mode": "preview",
        "style": "sequential",
        "max_parallel": 1,
        "overrides": {"*": {"START_NM": 635, "END_NM": 666, "STEP_NM": 0.5}},
        "child_timeout_s": 60,
    }

    preview = app.controller_preview(payload)
    assert preview["ok"] is True
    assert preview["preview_hash"]
    assert preview["payload_hash"]
    plan = preview["resolved_execution_plan"]
    assert plan["final_command"][1].endswith("mock_run_script.py")

    job = app.controller_start({**payload, "preview_hash": preview["preview_hash"], "confirm": True, "risk_ack": False})
    assert job["status"] == "completed"

    job_dir = server_v2.JOBS_DIR / job["job_id"]
    assert (job_dir / "job_manifest.json").exists()
    assert (job_dir / "resolved_execution_plan.json").exists()
    assert (job_dir / "overrides.json").exists()
    assert (job_dir / "before_snapshot.json").exists()
    assert (job_dir / "after_snapshot.json").exists()
    assert (job_dir / "stdout.log").exists()
    assert (job_dir / "stderr.log").exists()
    assert (job_dir / "received.json").exists()

    received = json.loads((job_dir / "received.json").read_text(encoding="utf-8"))
    assert received["payload"]["*"]["START_NM"] == 635
    assert received["payload"]["*"]["END_NM"] == 666
    assert received["payload"]["*"]["STEP_NM"] == 0.5
    assert received["received_params"]["START_NM"] == "635"
    assert received["received_params"]["END_NM"] == "666"
    assert received["received_params"]["STEP_NM"] == "0.5"
