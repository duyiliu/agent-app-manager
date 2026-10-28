# Project Runner

[![CI](https://github.com/duyiliu/project-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/duyiliu/project-runner/actions/workflows/ci.yml)

**Agent 驱动的本地项目启动与运行管理 Skill。**

在业务仓库中让 Agent 识别并启动项目、查看日志和验证热加载。受管应用会统一登记，之后可在其他目录或 Agent 会话中查看状态、启停和查日志；无法安全托管的启动会标记为非受管。附带本机 Web 管理台。

支持 Java / Spring Boot（含 standalone JRebel）、Python、Node / Vue / React / Vite，以及任意可核验身份的真实可执行进程。

## 快速开始

### 1. 安装

本仓库是 `project-runner` Skill 的唯一维护源；原 `duyiliu/agent-skills` 中的 `jrebel-start` 副本已不再维护。

```bash
npx skills add duyiliu/project-runner --skill project-runner -g
```

安装后以 Agent 实际加载的 Skill 目录为准解析脚本，不同运行器的目录不必相同。重新安装或更新不会清理旧的 `jrebel-start` 本地副本；确认新 Skill 可用后再自行卸载旧版本，避免触发冲突。

### 2. 让 Agent 启动项目

在目标仓库中直接说：

> 启动这个项目

Agent 会读取项目说明、已有启动脚本和构建配置，识别启动方式。目标明确且可安全托管时，启动并自动登记；存在多个候选或无法托管时，会先说明情况。运行数据保存在 `~/.project-runner/`。

Java 项目默认 `mode: java`；只有项目已有 JRebel 配置（启动脚本引用 agent、仓库有 `rebel.xml`、构建文件含插件）或你明确要求时，才走 `mode: jrebel` 并检查 standalone JRebel 环境。

### 3. 查看与管理

将下面的路径和 `my-app` 替换为实际 Skill 安装目录和应用别名：

```bash
node "<skill-dir>/scripts/manager.mjs" list
node "<skill-dir>/scripts/manager.mjs" status my-app --ready
node "<skill-dir>/scripts/manager.mjs" logs my-app --lines 100
node "<skill-dir>/scripts/manager.mjs" ui
```

`ui` 默认监听 `http://127.0.0.1:8199`，浏览器打开即可查看全局应用、日志和项目文件。命令在任何目录都能用，不需要 `cd` 到业务仓库。

完整参数见 [manager 参考](skills/project-runner/references/manager.md)，Agent 侧规程见 [SKILL.md](skills/project-runner/SKILL.md) 第 8 节。

## 能力

| 能力 | 说明 |
| --- | --- |
| 项目识别 | 从仓库证据确定运行时、模块、入口、profile、端口和启动参数，不凭记忆补全 |
| 受管启动 | 直连真实可执行进程，或用命令模式托管 `npm run dev`、`mvn spring-boot:run` 等脚本 |
| 跨项目 / 跨会话 | 受管启动自动登记；已登记应用可在任意目录启动，其他 Agent 会话也能核验和操作 |
| 生命周期 | `start` / `stop` / `restart` / `remove`，支持 `--dry-run`、`--wait-ready`、`--tree`、`--grace` |
| 分组批量 | desc `tags` + `--tag`，逐条执行、失败继续、不回滚 |
| 状态与健康 | 进程状态、端口探测、业务就绪证据、资源快照、`health` 总览、`doctor` 自检 |
| 日志 | 按批次查看 stdout / stderr，支持合并、跟随、正则过滤、上下文与时间过滤；统一日志源覆盖非受管线索与项目 `.tmp` |
| 自动重启 | 可选 `restartPolicy=on-failure`，按 `maxRestarts` / `backoffMs` 有界重启，`BACKOFF` / `DEAD` 可见 |
| 退出钩子 | 可选 `onExit`；非监督应用在查询时发现退出后执行，监督应用在结束监督时执行，人工停止不触发 |
| JRebel | 初始化 / 检查 standalone JRebel、许可与 `rebel.xml`，验证加载与热更新证据（仅 Java） |
| 管理台 | 本机 Web 界面，默认只读；启停 / 移除须页面二次确认 |

## 受管范围与状态

只管理**由本 Skill 启动并登记**的进程。IDEA / 手工命令行 / Docker 启动的外部进程不接管、不停止；仅在端口冲突诊断时查看占用信息。默认不修改项目配置、`rebel.xml`、启动脚本或数据库，需要改动时先取得授权。

受管形态二选一：

- **直连**：`exe` + `args`，目标必须是可核验身份的真实可执行文件（Windows `.exe` / `.com`，Linux ELF）。`.cmd` / `.bat` / `.ps1` 包装、WindowsApps 执行别名、`#!` 脚本不能作为 `exe`；这类脚本请用命令模式，或解析到真实解释器。
- **命令模式**：`command` + `expectedImage`。manager 拉起脚本或复合命令后，在后代进程中按映像名发现唯一真实目标并托管。多个候选会拒绝（`DISCOVERY_AMBIGUOUS`），不会任选一个。

两者都无法定位唯一目标时，仍可按原授权执行，但只登记为非受管，不承诺跨会话启停。

| 状态 | 含义 |
| --- | --- |
| `RUNNING` | 进程存活（不等于业务就绪） |
| `STOPPED` | 有退出证据 |
| `STARTING` | 启动进行中 |
| `BACKOFF` | 异常退出后等待自动重启 |
| `DEAD` | 自动重启次数耗尽 |
| `UNKNOWN` | 中断 / 身份不可核验 / 非受管记录 |

`STARTING` / `UNKNOWN` 属于未结记录：默认拒绝 `start` / `remove`。人工核验旧进程已退出后，用 `--ack-unresolved <runId>` 显式放弃旧账，证据保留在 `prevRuns`。不要删除 runtime 记录或日志来绕过。

`stop` 默认是**有界强制终止**，不承诺优雅关机；`--grace <ms>` 先发优雅信号，超时后再强制终止。跨 Agent 会话的存活与验收结论以 [design.md](docs/design.md) 的状态为准。

## 命令速查

`<ref>` 为别名或 `appId`。

| 命令 | 用途 |
| --- | --- |
| `detect --root <dir>` | 只读识别项目并输出启动候选，不登记或启动 |
| `list [--watch [--interval <ms>]]` | 全局应用列表与实时状态；`--watch` 周期输出，JSON 模式为 NDJSON |
| `status <ref> [--probe] [--ready] [--resources] [--watch]` | 单应用详情；`--probe` 实际监听端口，`--ready` 业务就绪，`--resources` 单次 RSS / CPU |
| `status --tag <t>` | 按标签批量查询 |
| `start <ref> [--force] [--dry-run] [--wait-ready [--ready-timeout <ms>]]` | 用已保存配置启动；`--wait-ready` 就绪才返回 0，超时为退出码 6 且进程保持 RUNNING |
| `stop <ref> [--tree] [--grace <ms>]` | 停止受管实例 |
| `restart <ref> [--force] [--tree] [--grace <ms>] [--dry-run]` | 确认退出后重启 |
| `start --tag <t>` / `stop --tag <t>` / `restart --tag <t>` | 按标签批量操作；须检查 `results[].ok`，命令退出码不代表每条都成功 |
| `logs <ref> [--lines N] [--stream ...] [--run <runId>] [--follow] [--src ...] [--grep <regex>] [--since ...]` | 统一日志源查看与过滤 |
| `health` | 全部应用的状态 / 端口 / 就绪总览（只读） |
| `port <N>` | 端口占用诊断（只读，不停止外部进程） |
| `doctor` | 环境与数据自检（只读，不修复） |
| `remove <ref>` | 移除登记；须无存活受管实例，运行证据保留 |
| `prune [--dry-run] [--apply]` | 回收超期日志、死锁残留、孤儿临时文件；默认 dry-run |
| `ui [--port N] [--open]` | 本机 Web 管理台，默认 `127.0.0.1:8199` |

通用参数：`--home <绝对路径>` 使用隔离数据目录，`--json` 输出稳定 JSON。

退出码：`0` 成功、`1` 用法、`2` 未找到、`3` 状态冲突、`4` 环境依赖、`5` 数据损坏或内部错误、`6` 就绪超时。使用 `--wait-ready` 前须配置 `readyLogPattern` 或 `readyUrl`。

## 平台与依赖

| 平台 | 支持情况 |
| --- | --- |
| Windows 11 + PowerShell 7 | 支持；身份核验 / 终止 / 端口诊断走 `ps/proc.ps1` |
| Linux | 支持；走 `/proc`，不依赖 pwsh |
| macOS | 不支持（无 `/proc`），命令以 `PLATFORM_UNSUPPORTED` 拒绝 |

- Node.js 20+（CI 使用 22）。
- Linux 安全停止需要 Python 3.9+ 与内核 pidfd 支持；缺少时明确拒绝终止，不回退到有 PID 复用竞态的 `kill(pid)`。
- 不新增 npm 依赖、Daemon、数据库或 MCP，仅使用 Node 内置模块。

## 本地 Web 管理台

`manager ui` 按需启动，前台常驻，Ctrl+C 即退出；不注册开机自启、不拉起守护进程。默认固定 `127.0.0.1:8199`（`--port 0` 为随机端口），仅本机可访问、无令牌。

- 全局应用状态、未结记录证据与 `prevRuns`、资源曲线（详情展开时按需采样）。
- 日志：受管批次、非受管线索、项目 `.tmp` 兼容日志；支持合并 stdout / stderr、跟随、正则过滤、只看错误、暂停 / 下载。
- 项目文件只读浏览：隐藏 `.git`、`node_modules`、`.env*`、常见私钥与许可文件，拒绝路径穿越与符号链接。
- 生命周期按钮：启动 / 停止 / 重启 / 移除，页面二次确认，与 CLI 同一实现和安全边界。
- 端口诊断：只读查询占用；`PORT_IN_USE` 时展示 PID、名称、路径等白名单字段。

原单项目 Viewer 已移除，能力并入本台。管理台地址仅本机可达，**不要转发**；日志可能含敏感信息，外发前先检查。

## 数据目录

```text
~/.project-runner/                 # Windows: %USERPROFILE%\.project-runner\
├── registry.json                  # 已登记应用与可复用启动描述
├── runtime/<appId>.json           # 当前 / 最近运行实例与证据
├── logs/<appId>/<runId>.*.log     # 受管批次日志
└── locks/                         # 应用锁
```

升级不清理数据目录。`env` 中的字面值会明文保存到注册表，不能用于机密；机密请通过系统环境变量 + `envRefs`，或 `envFile` 传入（后者仅在启动时读取，值不写入 registry / runtime / status / UI）。

## 仓库结构

```text
README.md
docs/
├── design.md                      # 跨项目管理设计与验收基线
├── ops/                           # 运维记录
└── verification/                  # 验收证据
skills/project-runner/
├── SKILL.md                       # Agent 路由与通用边界
├── references/                    # 按需加载：java / python / node / other-stacks / manager / jrebel-setup
└── scripts/
    ├── manager.mjs                # CLI 入口
    ├── log-writer.mjs             # detached 日志转发 / 轮转 / 重启监督
    ├── exit-watcher.mjs           # 命令模式目标的真实退出状态记录
    ├── lib/                       # 领域模块（detect / launch / lifecycle / logs / resources / ...）
    ├── manager-ui/                # 管理台页面、前端脚本与本地服务
    ├── ps/proc.ps1                # Windows 进程适配
    ├── linux/                     # Linux pidfd 终止与退出等待 helper
    └── test/                      # 跨平台冒烟测试
examples/spring-boot-demo/         # 本地测试项目
```

## 本地测试项目

仓库内置 [Spring Boot 测试项目](examples/spring-boot-demo/README.md)：Java 17、Spring Boot 3.3.5，不依赖数据库 / Nacos / Redis，默认只监听 `127.0.0.1:18273`。用于验证项目识别、受管启动、管理台日志、健康检查与 JRebel 热加载；构建和接口检查步骤见该项目 README。

## 开发与测试

改动 `manager.mjs` / `manager-ui` / `lib` 后运行：

```bash
npm test          # 完整冒烟
npm run check     # 全部 .mjs 语法检查 + 脱敏 / 健康 / 环境 / 运行时冒烟
```

`npm test` 依次覆盖：日志轮转、管理台、健康总览、生命周期与未结记录、env / envFile、`--wait-ready`、remove / prune / 统一日志源、日志过滤、管理台日志源跟随、真实进程生命周期。CI 在 `windows-latest` 与 `ubuntu-latest` 上运行语法检查与核心冒烟；macOS 未纳入支持范围。

## 来源与兼容性

从 [duyiliu/agent-skills](https://github.com/duyiliu/agent-skills) 的 `skills/engineering/jrebel-start/` 和 `work/任务/JRebel跨项目统一运行管理/design.md` 迁移，基础能力来自 [PR #5](https://github.com/duyiliu/agent-skills/pull/5)，跨项目管理设计来自 [PR #6](https://github.com/duyiliu/agent-skills/pull/6)。

- Skill 名称 `project-runner`；保留原项目日志命名 `jrebel-local-*.log`（`manager ui` 兼容扫描），不要求改业务仓库。
- 运行数据目录为 `~/.project-runner/`（2026-10-17 由设计初稿的 `~/.jrebel-start/` 更名；更名时尚无真实数据，无迁移问题）。
- 版本号见 `manager.mjs version` 或管理台顶栏徽标，与 Git 标签 `vX.Y.Z` 同步。更新 = 重跑安装命令拉取最新 `main`；固定版本则检出对应 tag 后安装。
- 项目启动、构建、许可证配置及服务停止遵循 Skill 的授权边界；安装 Skill 不等于获得修改业务项目的授权。

## 开发边界

Skill 负责理解目标项目；确定性脚本只负责需要可靠重复执行的操作。不要为了支持更多语言预先引入通用适配框架、Daemon、数据库或 MCP。跨项目能力的验收要求见 [design.md](docs/design.md)。
