# FDTD 光谱群论工作台 V2 构建与验收说明

构建日期：2026-05-20

项目根目录：

```text
H:\FDTD outcome\struct\群论_struct
```

V2 目录：

```text
H:\FDTD outcome\struct\群论_struct\结果查看器_html_v2
```

## 启动命令

```powershell
cd /d "H:\FDTD outcome\struct\群论_struct"
python "结果查看器_html_v2\server_v2.py" --root "H:\FDTD outcome\struct\群论_struct" --port 8787
```

浏览器访问：

```text
http://127.0.0.1:8787/
```

停止服务：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

## 核心架构

V2 已按“快速首屏、后台预热、用户优先、增量更新、任务记录”的方式重构。

首屏只调用：

```http
GET /api/v2/bootstrap
```

`bootstrap` 只返回轻量数据，不返回完整 run 明细、资源索引、谱线数组或大 fingerprint 表。

缓存拆分：

```text
runtime_state\index_meta.json
runtime_state\overview_cache.json
runtime_state\run_index_cache.json
runtime_state\script_registry.json
runtime_state\quality_cache.json
runtime_state\supplement_index.json
runtime_state\resource_index_light.json
runtime_state\resource_index_full.json
runtime_state\spectra_index.json
runtime_state\run_details\<run_id>.json
runtime_state\spectrum_cache\<spectrum_id>.json
runtime_state\jobs\<job_id>\
```

后台扫描入口：

```http
POST /api/v2/index/refresh
POST /api/v2/index/refresh-delta
GET  /api/v2/index/status
```

前端预热入口：

```http
POST /api/v2/preload/start
GET  /api/v2/preload/status
GET  /api/v2/preload/next?kind=&limit=
GET  /api/v2/cache/chunk?name=&page=&page_size=
GET  /api/v2/cache/changes?since=
```

## 扫描器实现

`server_v2.py` 已实现统一扫描与缓存模块，主要函数包括：

```text
load_json_safe(path, default)
save_json_atomic(path, data)
safe_join(root, relative_path)
build_file_fingerprint(path)
build_dir_fingerprint(path)
scan_project_incremental(root, previous_meta=None)
scan_changed_run_dirs(root, previous_run_index)
scan_runs_light(root, changed_paths=None)
scan_run_detail(run_path)
scan_scripts(root, previous_registry=None)
scan_spectrum_index(run_detail)
load_or_build_spectrum_cache(spectrum_item)
extract_metrics_from_spectrum(lambda_nm, value)
build_quality_flags(run_detail)
build_missing_evidence(run_detail)
build_top_candidates(run_index, quality_cache)
build_overview_cache(run_index, script_registry, quality_cache, supplement_index)
create_job_manifest(request)
predict_expected_outputs(job_manifest)
take_path_snapshot(paths)
diff_snapshots(before, after)
refresh_delta_from_job(job_id)
refresh_delta_paths(dirty_paths)
update_run_index_for_changed_runs(changed_runs)
update_spectra_index_for_changed_runs(changed_runs)
update_quality_cache_for_changed_runs(changed_runs)
update_overview_cache_incremental(changed_runs, old_overview)
```

扫描安全规则：

```text
不 import FDTD 脚本
不解析 fsp 内容
png/jpg 只登记路径
xlsx/csv 仅在需要时解析谱线
路径访问限制在项目根目录内
不删除原始数据
不移动旧 run
不修改原始 FDTD 小脚本
```

## 控制器参数

`fdtd_master_controller.py` 实际支持：

```text
--mode ask|preview|test|full
--style ask|sequential|parallel
--max-parallel N
--ids 1,3,5-8
--all
--missing-only
--overrides-json JSON字符串或JSON文件路径
--child-timeout-s 秒数
--yes
```

V2 只通过 subprocess 调用，不 import、不执行脚本模块。

## 已实现页面

```text
研究总览
运行控制
结果浏览
光谱诊断
模式接力 / 拓扑候选
质量审计
补做实验
资源浏览
```

页面修复：

```text
修复中文乱码
修复右侧 drawer 默认打开风险
修复异步路由竞态
修复资源预览旧事件残留
修复结果浏览三栏桌面布局
补齐加载、空状态、错误 toast、成功反馈
保留全量重建二次确认，右键“后台刷新”触发
```

## 补做实验验收

已通过网页生成测试任务包：

```text
C6对称结构\六柱环\results\交替两组柱子扰动\补做实验\patch_20260520_161301_field\
```

已生成：

```text
patch_request.json
source_links.json
00_patch_plan\patch_points.csv
01_patch_fsp\
04_logs\
06_reflection_excel\
07_absorption_excel\
08_field_data\
09_phase_data\
10_poynting_data\
12_patch_summary\
```

任务包不覆盖原 run，不修改原 FSP。

## Job Manifest 验收

已通过网页端/接口以 `preview` 模式启动一次受控任务，验证任务记录链路：

```text
runtime_state\jobs\job_20260520_161434_356a19\
```

已生成：

```text
job_manifest.json
before_snapshot.json
after_snapshot.json
delta_files.json
command.txt
stdout.log
stderr.log
overrides.json
```

该任务状态：

```text
status: success
returncode: 0
cache_update_status: done
updated_runs: run_preview_2026年5月20日_16时14分39秒_dbce37b3
```

任务结束后已根据 dirty_paths 增量更新 run_index、quality、spectra、overview 和 resource index。

## 验收数据

当前缓存计数：

```text
runs: 467
scripts: 129
spectra: 1327
files: 9732
```

性能测量：

```text
bootstrap payload: 80506 bytes
bootstrap response: 198 ms
首页首屏：Browser 实测约 1 秒内显示轻量缓存
后台增量刷新：无变化时完成，changed_runs=[]
```

浏览器验收：

```text
Browser 打开 http://127.0.0.1:8787/ 成功
研究总览正常显示 KPI、群覆盖、候选、风险
运行控制可选脚本并预览命令
结果浏览可加载 run 明细和文件列表
光谱诊断可加载 T(λ) 曲线、趋势和质量旗标
模式接力页明确显示“仅为候选筛选”提示
资源浏览可按需预览文件
补做实验可生成 patch 任务包
刷新页面后仍正常
```

移动端说明：

```text
CSS 已保留 920px 与 720px 响应式断点。
当前 Browser 工具未暴露可用 viewport resize API；已在代码层检查移动断点，未使用真实 Chrome。
```

## 验收命令

```powershell
python -m py_compile "H:\FDTD outcome\struct\群论_struct\结果查看器_html_v2\server_v2.py"
node --check "H:\FDTD outcome\struct\群论_struct\结果查看器_html_v2\assets\js\app.js"
node --check "H:\FDTD outcome\struct\群论_struct\结果查看器_html_v2\assets\js\api.js"
```

结果：全部通过。

## 仍需注意

```text
增量刷新仍需要遍历 run 目录 fingerprint，但不会重新解析未变化的谱线。
旧缓存中已有谱线 cache 数量较少，剩余谱线会按需或后台预热逐步生成。
preview 任务会实际创建 preview run 目录，这是 fdtd_master_controller.py 的行为。
没有执行 full/test 大规模仿真验收，避免占用本机内存和长时间任务。
```
