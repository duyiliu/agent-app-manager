# Python 项目启动参考

本文件承接 `SKILL.md` 第 1A 节。执行前遵守 `SKILL.md` 第 0 节意图分流、第 2 节歧义报告、第 3 节构建授权与第 4 节启动前检查；受管形态与包装边界见第 1A 节。

1. **[项目] 依赖与框架**：`requirements.txt`、`pyproject.toml`、`Pipfile`/`poetry.lock`/`uv.lock`、`setup.py`、`environment.yml`（conda）。先读 README/AGENTS.md 的约定命令，再凭依赖声明判断框架（django/flask/fastapi/uvicorn 等），不凭目录名猜。
2. **[比对] 解释器**：优先项目内虚拟环境——Windows 为 `.venv/Scripts/python.exe`、`venv/Scripts/python.exe`，Linux 为 `.venv/bin/python`、`venv/bin/python`（或项目约定的 conda/uv/poetry 环境路径）；其次 PATH `python`（Linux 常用 `python3`）——manager 在 Windows 会跳过/拒绝 `Microsoft\WindowsApps\python*.exe` 应用执行别名（未装应用时为 0 字节 stub），全部候选不可用时按报错改用真实解释器路径。**Windows 的 `py` 启动器是拉起子进程的包装，不得作受管 exe**。venv 或依赖缺失（如 import 失败）时报告所需命令（`python -m venv .venv`、`pip install -r requirements.txt` 等），venv 创建与安装属项目环境改动，按 `SKILL.md` 第 3 节授权规则先报告后执行。
3. **[项目] 入口**：Django（`manage.py` + settings 模块）→ `python manage.py runserver [addr:port]`；Flask → `python -m flask --app <module> run` 或项目自带 `app.py`；FastAPI/ASGI → `python -m uvicorn <module>:<app>`；脚本型 → `python main.py`/`python -m <pkg>`。多入口候选按 `SKILL.md` 第 1 节的歧义规则报告，不任选一个。
4. **[比对] 端口**：以项目配置与启动参数为准；框架默认（Django 8000、Flask 5000、uvicorn 8000）只是候选，不冒充实际监听。
5. **desc 形态**：`exe`=真实解释器（Windows 为 venv 内的 `python.exe`；Linux 为 venv 内的 `bin/python` 或真实 `python3`），`args`=命令去掉解释器后的数组，`cwd`=项目根或项目约定目录，`mode`=`python`，`expectedPort` 有证据才填。
6. **热更新**：uvicorn `--reload`、flask debug 等由项目配置决定，不擅自添加参数；验证方式=改动源文件后看 dev server 输出或页面。
