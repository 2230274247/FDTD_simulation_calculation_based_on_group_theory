from __future__ import annotations

import json
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


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def test_delete_patch_package_requires_patch_directory(tmp_path, monkeypatch):
    patch_runtime_dirs(monkeypatch, tmp_path)
    project_root = tmp_path / "project"
    patch_dir = project_root / "patch_20260521_demo"
    patch_dir.mkdir(parents=True, exist_ok=True)
    (patch_dir / "patch_request.json").write_text("{}", encoding="utf-8")
    index_path = server_v2.STATE_DIR / "supplement_index.json"
    package_id = "patch_20260521_demo"
    write_json(index_path, {
        "schema_version": 1,
        "built_at": "2026-05-21T00:00:00",
        "packages": [
            {
                "package_id": package_id,
                "package_type": "patch_v2",
                "patch_mode": True,
                "relative_path": "patch_20260521_demo",
                "output_root": "patch_20260521_demo",
                "source_run_id": "run_source",
                "source_run_dir": "run_source",
            }
        ],
    })
    app = server_v2.WorkbenchApp(project_root, 8787)
    app.supplement_index_path = index_path

    result = app.delete_supplement_package(package_id)

    assert result["ok"] is True
    assert result["deleted"] is True
    assert not patch_dir.exists()
    saved = json.loads(index_path.read_text(encoding="utf-8"))
    assert saved["packages"] == []


def test_delete_patch_package_rejects_original_run(tmp_path, monkeypatch):
    patch_runtime_dirs(monkeypatch, tmp_path)
    project_root = tmp_path / "project"
    run_dir = project_root / "run_original_demo"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "patch_request.json").write_text("{}", encoding="utf-8")
    index_path = server_v2.STATE_DIR / "supplement_index.json"
    package_id = "patch_20260521_tampered"
    write_json(index_path, {
        "schema_version": 1,
        "built_at": "2026-05-21T00:00:00",
        "packages": [
            {
                "package_id": package_id,
                "package_type": "patch_v2",
                "patch_mode": True,
                "relative_path": "run_original_demo",
                "output_root": "run_original_demo",
                "source_run_id": "run_source",
                "source_run_dir": "run_source",
            }
        ],
    })
    app = server_v2.WorkbenchApp(project_root, 8787)
    app.supplement_index_path = index_path

    with pytest.raises(ValueError, match="original run|non-patch"):
        app.delete_supplement_package(package_id)

    assert run_dir.exists()
    saved = json.loads(index_path.read_text(encoding="utf-8"))
    assert len(saved["packages"]) == 1
