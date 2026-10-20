# Project Runner

**Agent-native 本地开发项目启动与运行管理 Skill**

> 当前可用：Java / Spring Boot、Python、Vue/React/Vite 等 Node 前端及其他主流栈的项目识别与启动、Standalone JRebel 环境初始化、热加载验证，以及 `manager.mjs` 跨项目运行管理 P0 与其 `ui` 统一只读 Web 管理台（日志 + 项目文件；命令与使用规程见 [SKILL.md](skills/project-runner/SKILL.md) 第 8 节，能力与验收基线见 [design.md](docs/design.md)）。
>
> 跨项目能力包括首次启动自动登记、全局列表/状态、已登记应用从任意目录启动、受管进程跨 Agent 会话核验与有界强制启停、按批次查询日志；只管理本 Skill 启动并登记的应用进程，**不接管 IDEA / 手工启动的外部进程**。受管两种形态：直连真实可执行进程（`.exe`/`.com`），或命令模式（`command`+`expectedImage`——manager 拉起脚本命令后在后代中发现唯一真实目标托管，覆盖 `npm run dev`、`mvn spring-boot:run` 等脚本/复合命令）。真实 Agent 会话退出后的跨会话存活终验状态以 [design.md](docs/design.md) 的状态行为准。

## 安装

本仓库是 `project-runner` Skill 的**唯一维护源**，原 `duyiliu/agent-skills` 不再维护 `jrebel-start` 副本。

```bash
npx skills add duyiliu/project-runner --skill project-runner -g
```

安装后以 Agent 实际加载的 Skill 目录为准解析附带脚本；不同运行器的目录不必相同。重新安装或更新不会自动清理旧的 `jrebel-start` 本地副本，请先确认新 Skill 可用，再自行卸载旧版本，避免触发冲突。

## 用途

- **当前项目启动**：读取 `AGENTS.md`、已有脚本及构建配置，确定运行时、模块、入口、profile、端口、启动参数。Java 走 Maven/Gradle 识别；Python 走 venv/依赖声明识别；Vue/React/Vite 等前端把 `package.json` script 解析为真实 `node` 入口进程后受管启动。
- **JRebel**：初始化 / 检查 standalone JRebel、许可与 `rebel.xml`，按已有项目约定启动，验证加载与热更新证据（仅 Java）。
- **跨项目运行管理**：`manager.mjs` 统一登记并管理**本 Skill 启动且具有可信进程身份**的应用进程；支持全局 `list`/`status`、已登记应用从任意目录 `start`、受管实例 `stop`/`restart`、不再需要的登记 `remove`（须无存活受管实例，运行证据保留）、残留回收 `prune`（默认 dry-run）、按运行批次或统一日志源（`logs --src`）查日志，以及跨 Agent 会话核验。只管理本 Skill 启动并记录的应用，**不接管 IDEA / 手工启动的外部进程**；`stop` 为有界强制终止，不承诺优雅关机。
- **本地运行管理台**：`manager ui` 按需启动只读网页（默认固定 `127.0.0.1:8199` + 一次性令牌，`--port 0` 随机端口；Ctrl+C 即退出，无常驻服务），查看全局应用状态、未结记录证据与日志（受管批次、非受管线索、项目 `.tmp` 兼容日志），并浏览所选应用的项目文件；原单项目 Viewer 已移除，能力并入本台。不提供启停操作，启停走 CLI/Agent。
- **非受管启动**：连命令模式也无法定位唯一目标进程的项目脚本仍可按原授权执行，但只记录启动尝试与日志线索并标记为非受管，不承诺跨会话启停。

## 目录

```text
README.md
docs/design.md                   # 跨项目管理设计与验收基线（P0 已实现）
skills/project-runner/
├── SKILL.md
└── scripts/
    ├── manager.mjs              # 跨项目运行管理 P0
    ├── manager-ui/
    │   ├── index.html           # manager ui 只读管理台页面
    │   └── server.mjs           # ui 本地服务（127.0.0.1 + 一次性令牌）
    ├── ps/
    │   └── proc.ps1             # 受管进程身份核验与终止适配
    └── test/
        ├── ui-smoke.mjs         # manager ui 冒烟测试（隔离 --home，不碰真实数据）
        ├── cli-smoke.mjs        # manager CLI 冒烟测试（remove / prune / logs 统一日志源）
        └── runtime-smoke.mjs    # 受管生命周期冒烟（真实 node/python 直连 + 命令模式 + 拒绝路径）
```

## 来源与兼容性

从 [duyiliu/agent-skills](https://github.com/duyiliu/agent-skills) 的 `skills/engineering/jrebel-start/` 和 `work/任务/JRebel跨项目统一运行管理/design.md` 迁移，基础能力来自 [PR #5](https://github.com/duyiliu/agent-skills/pull/5)，设计来自 [PR #6](https://github.com/duyiliu/agent-skills/pull/6)。

- 新 Skill 名称 `project-runner`；保留原项目日志命名 `jrebel-local-*.log`（由 `manager ui` 兼容扫描），不要求改业务仓库。
- 运行数据目录为 `~/.project-runner/`（2026-10-17 由设计初稿的 `~/.jrebel-start/` 更名：管理器已覆盖非 JRebel 的纯 Java 应用，且更名时尚无真实数据，无迁移问题）。
- 项目启动、构建、许可证配置及服务停止都遵循 Skill 中的授权边界；安装 Skill 不等于获得修改业务项目的授权。

## 开发边界

Skill 负责理解目标项目，确定性脚本只负责需要可靠重复执行的操作。不要为了支持更多语言预先引入通用适配框架、Daemon、数据库或 MCP。跨项目能力的验收要求见 [design.md](docs/design.md)。

改动 `manager.mjs` / `manager-ui` 后运行冒烟测试：`node skills/project-runner/scripts/test/ui-smoke.mjs`、`node skills/project-runner/scripts/test/runtime-smoke.mjs` 与 `node skills/project-runner/scripts/test/cli-smoke.mjs`（未安装 pwsh 7 时自动跳过依赖应用锁与身份核验的检查）。
