# Project Runner

**Agent-native 本地开发项目启动与运行管理 Skill**

> 当前可用：Java / Spring Boot 项目识别、Standalone JRebel 环境初始化、按项目启动和热加载验证，以及单项目只读日志 Viewer。  
> **跨项目状态、统一启停与 `manager.mjs` 目前只有 [v2 设计](docs/design.md)，尚未实现。**  
> 未来可扩展其他语言，但**本次迁移不增加 Node/Python/Go 运行托管能力**。

## 安装

本仓库是 `project-runner` Skill 的**唯一维护源**，原 `duyiliu/agent-skills` 不再维护 `jrebel-start` 副本。

```bash
npx skills add duyiliu/project-runner --skill project-runner -g
```

安装后以 Agent 实际加载的 Skill 目录为准解析附带脚本；不同运行器的目录不必相同。重新安装或更新不会自动清理旧的 `jrebel-start` 本地副本，请先确认新 Skill 可用，再自行卸载旧版本，避免触发冲突。

## 用途

- **当前项目启动**：读取 `AGENTS.md`、已有脚本及 Maven/Gradle 配置，确定 JDK、模块、入口、profile、端口、启动参数。
- **JRebel**：初始化 / 检查 standalone JRebel、许可与 `rebel.xml`，按已有项目约定启动，验证加载与热更新证据。
- **日志工作台**：单项目只读 Viewer，位于 `skills/project-runner/scripts/log-viewer/`；在目标项目目录下启动，默认监听本机 `127.0.0.1:8199`。
- **待实现**：仅登记并管理 Skill 自己启动且具有可信进程身份的 JVM，跨项目与跨 Agent 会话查看和安全启停。**不接管 IDEA / 手动启动的外部进程**。

## 目录

```text
skills/project-runner/
├── SKILL.md
└── scripts/log-viewer/
    ├── server.mjs
    └── index.html
docs/design.md                   # 跨项目管理 v2，非已交付功能
```

## 来源与兼容性

从 [duyiliu/agent-skills](https://github.com/duyiliu/agent-skills) 的 `skills/engineering/jrebel-start/` 和 `work/任务/JRebel跨项目统一运行管理/design.md` 迁移，基础能力来自 [PR #5](https://github.com/duyiliu/agent-skills/pull/5)，设计来自 [PR #6](https://github.com/duyiliu/agent-skills/pull/6)。

- 新 Skill 名称 `project-runner`；保留原项目日志命名 `jrebel-local-*.log` 和 Viewer 行为，不要求改业务仓库。
- 运行数据目录为 `~/.project-runner/`（2026-10-17 由设计初稿的 `~/.jrebel-start/` 更名：管理器已覆盖非 JRebel 的纯 Java 应用，且更名时尚无真实数据，无迁移问题）。
- 项目启动、构建、许可证配置及服务停止都遵循 Skill 中的授权边界；安装 Skill 不等于获得修改业务项目的授权。

## 开发边界

Skill 负责理解目标项目，确定性脚本只负责需要可靠重复执行的操作。不要为了支持更多语言预先引入通用适配框架、Daemon、数据库或 MCP。跨项目能力的验收要求见 [design.md](docs/design.md)。
