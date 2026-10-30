# Python 测试项目

用于验证 Agent App Manager 对 Flask 项目的识别、受管启动、就绪检查和日志查看。只监听 `127.0.0.1:18274`，不依赖数据库或其他服务，不用于生产。

## 安装与启动

在本目录创建虚拟环境并安装依赖：

```bash
python -m venv .venv
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

Linux：

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app.py
```

也可以让已安装 `agent-app-manager` 的 Agent 启动 `examples/python-demo`，建议别名 `python-demo`。请按本 README 使用虚拟环境中的真实 Python 可执行文件和 `app.py`，设置预期端口 `18274` 及就绪地址 `http://127.0.0.1:18274/api/health`。`detect` 返回的 Flask 命令是候选，需要按此项目端口调整。

手工启动后按 Ctrl+C 退出；受管启动后可通过 `manager ui` 或 `manager status/logs/stop python-demo` 管理。不要同时启动两份。

## 接口

```bash
curl --fail http://127.0.0.1:18274/api/health
curl --fail "http://127.0.0.1:18274/api/hello?name=Runner"
curl --fail -X POST "http://127.0.0.1:18274/api/logs?level=WARN"
```

健康接口返回状态、应用名、PID 和时间；问候接口返回文本及版本；日志接口支持 `INFO`、`WARN`、`ERROR`，其他级别返回 400。代码变更后需重新启动，默认不启用自动重载。
