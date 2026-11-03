# Agent App Manager

统一管理由 Coding Agent 启动的开发应用，支持跨 Agent、跨项目、跨会话的生命周期管理、状态监控与日志查看。

支持 Windows 和 Linux，覆盖 Java / Spring Boot、Python、Node.js 等项目。应用按需启动，管理台无需常驻后台服务。

## 快速安装

**官方安装：**

```bash
npx skills add duyiliu/agent-app-manager#v0.13.0 --skill agent-app-manager -g
```

**国内加速安装（第三方 skills-cn）：**

```bash
npx skills-cn@latest add duyiliu/agent-app-manager#v0.13.0 --skill agent-app-manager -g -y
```

安装命令默认固定版本；换成其他版本时修改 `#vX.Y.Z` 即可，版本列表见 [GitHub Releases](https://github.com/duyiliu/agent-app-manager/releases)；国内加速命令同样支持指定版本。省略 `#vX.Y.Z` 则安装最新主线。`-g` 表示全局安装，`-y` 表示跳过交互确认；`skills-cn` 为第三方 CLI。安装后根据 Agent 实际加载的 Skill 目录定位脚本，已安装版本可通过 `manager.mjs version` 查看。

## 核心定位与差异化

**Agent-native Application Lifecycle Manager：让任意 Coding Agent 自然地启动、观察和管理真实开发应用。**

Agent 负责理解项目，Agent App Manager 负责可信地执行和持续管理应用。它不是 Agent 会话管理器，也不是替代 PM2、Docker 或 IDE 的通用进程控制台；关注的是**由 Agent 启动并登记的开发应用**在不同项目、不同 Agent 和不同会话之间的生命周期。

- **跨 Agent、跨会话的统一入口**：Claude Code、Codex、OpenCode 等只要能加载本 Skill，就能复用同一份应用登记与运行状态；原会话结束后仍可查看、启停和排查应用。
- **理解与执行分离**：由 Agent 基于仓库证据识别技术栈、启动命令与就绪条件；由确定性脚本执行启动、身份核验、日志采集和生命周期操作，不把进程控制交给模型猜测。
- **面向真实开发应用，而非 Agent 任务**：统一管理 Java / Spring Boot（含 JRebel）、Python、Node / Vue / React / Vite 等项目的进程、端口、就绪状态、日志和依赖；不负责 Agent 任务分配、会话编排或代码审查。
- **轻量、按需、无常驻后台依赖**：不要求先部署 Daemon、数据库或 MCP Server；CLI 与本机 Web 管理台按需使用，应用管理记录独立于单次 Agent 会话。
- **安全边界优先**：只对本 Skill 启动并登记、身份可核验的进程承诺受管启停；IDE、手工命令行和 Docker 启动的外部进程不擅自接管。对身份不明确、状态未结的进程保留证据并要求人工核验，而不是盲目重启或清理。

一句话：**Agent 理解项目，管理器可靠运行应用；Agent 会话可以结束，应用的管理状态不应丢失。**

## 快速使用

### 1. 让 Agent 启动项目

在目标仓库中直接说：

> 启动这个项目

Agent 会读取项目说明、已有启动脚本和构建配置，识别启动方式。目标明确且可安全托管时，启动并自动登记；存在多个候选或无法托管时，会先说明情况。

默认数据目录为 `~/.agent-app-manager/`，可使用 `--home <绝对路径>` 指定隔离数据目录。Skill 名称为 `agent-app-manager`。

Java 项目默认 `mode: java`；只有项目已有 JRebel 配置（启动脚本引用 agent、仓库有 `rebel.xml`、构建文件含插件）或你明确要求时，才走 `mode: jrebel` 并检查 standalone JRebel 环境。

### 2. 查看与管理

将下面的路径和 `my-app` 替换为实际 Skill 安装目录和应用别名：

```bash
node "<skill-dir>/scripts/manager.mjs" list
node "<skill-dir>/scripts/manager.mjs" status my-app --ready
node "<skill-dir>/scripts/manager.mjs" logs my-app --lines 100
node "<skill-dir>/scripts/manager.mjs" ui
```

`ui` 默认监听 `http://127.0.0.1:8199`，浏览器打开即可查看全局应用、日志和项目文件。命令在任何目录都能用，不需要 `cd` 到业务仓库。

在应用详情中，若项目包含 scenario-test 接入目录（默认 `scenario-test`，缺失时自动发现项目内自定义目录）且包含配置、`index.html` 和项目内 CLI，可点击「打开场景测试」启动并打开独立工作台；再次点击会复用，停止工作台不影响业务应用。工作台使用独立的本地端口，新标签被拦截时可点击显示的地址。打开工作台不会自动执行场景。

完整的默认目录优先；默认目录缺失或不完整时查找项目内自定义目录。发现多个完整候选时报告目录歧义，不自动选择。

完整参数见 [manager 参考](skills/agent-app-manager/references/manager.md)，Agent 侧规程见 [SKILL.md](skills/agent-app-manager/SKILL.md) 第 8 节。

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
| 依赖编排 | desc `dependsOn` 声明前置应用，`start` 按拓扑序拉起并检测环；`stop --with-dependents` 按反向依赖序停止 |
| 运行历史 | `status --history` / `--stats` 查看历史批次与运行时长统计 |
| 端口预检 | `start` 前检测 `expectedPort` 是否被占，冲突以 `PORT_IN_USE` 拒绝并指认占用者 |
| 登记备份 | `export` / `import` 导出与重建登记，用于换机或数据目录迁移 |
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
| `status <ref> [--probe] [--ready] [--resources] [--history] [--stats] [--watch]` | 单应用详情；`--probe` 实际监听端口，`--ready` 业务就绪，`--resources` 单次 RSS / CPU，`--history` / `--stats` 历史批次与运行时长统计 |
| `status --tag <t>` | 按标签批量查询 |
| `start <ref> [--force] [--dry-run] [--wait-ready [--ready-timeout <ms>]]` | 用已保存配置启动；`--wait-ready` 就绪才返回 0，超时为退出码 6 且进程保持 RUNNING |
| `stop <ref> [--tree] [--grace <ms>] [--with-dependents]` | 停止受管实例；`--with-dependents` 先按反向依赖序停止依赖方 |
| `restart <ref> [--force] [--tree] [--grace <ms>] [--dry-run]` | 确认退出后重启 |
| `start --tag <t>` / `stop --tag <t>` / `restart --tag <t>` | 按标签批量操作；须检查 `results[].ok`，命令退出码不代表每条都成功 |
| `logs <ref> [--lines N] [--stream ...] [--run <runId>] [--follow] [--src ...] [--grep <regex>] [--since ...]` | 统一日志源查看与过滤 |
| `health` | 全部应用的状态 / 端口 / 就绪总览（只读） |
| `port <N>` | 端口占用诊断（只读，不停止外部进程） |
| `doctor` | 环境与数据自检（只读，不修复） |
| `remove <ref>` | 移除登记；须无存活受管实例，运行证据保留 |
| `export --out <file> [--tag <t>]` | 导出登记清单（含校验和；`envRefs` 只记引用，敏感 env 键不落明文） |
| `import --from <file> [--dry-run] [--force]` | 校验清单后重建登记（只登记不启动；冲突默认跳过，`--force` 覆盖） |
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

- Node.js 20+（CI 使用 20）。
- Linux 安全停止需要 Python 3.9+ 与内核 pidfd 支持；缺少时明确拒绝终止，不回退到有 PID 复用竞态的 `kill(pid)`。
- 不新增 npm 依赖、Daemon、数据库或 MCP，仅使用 Node 内置模块。

## 本地 Web 管理台

`manager ui` 按需启动，前台常驻，Ctrl+C 即退出；不注册开机自启、不拉起守护进程。默认固定 `127.0.0.1:8199`（`--port 0` 为随机端口），仅本机可访问、无令牌。界面只展示已登记应用（含非受管记录）；IDEA / 手工启动且未登记的进程不会出现。

以下截图使用隔离演示数据，展示开发中的管理台界面；左侧包含 Node.js、Python 和 Java 应用。

![浅色管理台总览](docs/images/manager-overview.png)

*浅色主题：应用列表与运行日志。*

![深色管理台总览](docs/images/manager-overview-dark.png)

*深色主题：应用列表与运行日志。*

### 使用细节

1. **连接与刷新**：打开地址后，顶栏显示数据目录与最近连接时间；列表 / 状态约 4 秒、日志尾部约 1 秒自动刷新，页面隐藏时列表/状态/日志/日志源降频至 30 秒、健康与场景入口降频至 60 秒，也可点列表右上角手动刷新。Ctrl+C 退出 `ui` 后地址即不可用，仅关闭浏览器页面不会停止该进程。
2. **选择与筛选应用**：点击卡片切换应用。卡片展示进程状态、受管 / 非受管、就绪状态、模式、标签、pid、端口和内存快照；搜索框支持别名、显示名、ID、模式、端口、路径与标签。`STARTING` / `UNKNOWN` 等未结记录会在卡片和详情中标出，不能直接重复启动。
3. **详情与资源曲线**：点右上角「详情」展开。健康区给出端口监听、业务就绪证据（`readyLogPattern` / `readyUrl`）与诊断信息；`prevRuns` 与未结记录证据也在这里核对。详情展开后每 5 秒采样一次 CPU / RSS，绘制最近 5 分钟的曲线，收起详情即停止采样。

   ![浅色详情与资源曲线](docs/images/manager-detail.png)

   ![深色详情与资源曲线](docs/images/manager-detail-dark.png)

4. **查看日志**：日志源下拉可选当前 / 历史受管批次、非受管线索和项目 `.tmp` 兼容日志。工具栏支持合并 stdout / stderr、正则过滤、只看错误、暂停 / 恢复跟随、清屏和下载；过滤激活时只下载命中行。首次加载时顶部可能出现「从文件起始读取」提示，跟随滚动后移出视口。

5. **只读文件浏览**：点顶部「文件」打开当前应用根目录，可逐层展开、过滤和分页预览文本文件。`.git`、`node_modules`、`.env*`、常见私钥与许可文件不会显示，路径穿越与符号链接会被拒绝。

6. **启动 / 停止 / 重启 / 移除**：详情卡按钮与 CLI 同一实现和安全边界，所有生命周期操作都要在 10 秒内再次点击「确认…」才执行；`--tree` 与优雅退出毫秒数在详情卡内设置，只作用于 stop / restart。非受管应用仅允许移除 STOPPED 登记；`STARTING` / `UNKNOWN` 未结记录需人工核验进程已退出后，点「ack 并启动」并再次确认。
7. **端口诊断与自检**：预期端口旁的「诊断」只读查询占用信息（同 `manager port`），不接管外部进程；顶部「诊断」执行 `manager doctor` 并原样展示结果，不自动修复。

原单项目 Viewer 已移除，能力并入本台。管理台地址仅本机可达，**不要转发**；日志与文件预览可能含敏感信息，外发前先检查。

## 数据目录

```text
~/.agent-app-manager/                 # Windows: %USERPROFILE%\.agent-app-manager\
├── registry.json                  # 已登记应用与可复用启动描述
├── runtime/<appId>.json           # 当前 / 最近运行实例与证据
├── logs/<appId>/<runId>.*.log     # 受管批次日志
└── locks/                         # 应用锁
```

`env` 中的字面值会明文保存到注册表，不能用于机密；机密请通过系统环境变量 + `envRefs`，或 `envFile` 传入（后者仅在启动时读取，值不写入 registry / runtime / status / UI）。

## 仓库结构

```text
README.md
docs/
├── design.md                      # 跨项目管理设计与验收基线
├── images/                        # README 管理台截图
├── ops/                           # 运维记录
└── verification/                  # 验收证据
skills/agent-app-manager/
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

仓库内置三个本地示例，分别用于验证项目识别、受管启动、管理台日志和健康检查：

- [Spring Boot](examples/spring-boot-demo/README.md)：Java 17，端口 `18273`，还可验证 JRebel 热加载。
- [Python / Flask](examples/python-demo/README.md)：端口 `18274`，需安装 Flask。
- [Node.js](examples/node-demo/README.md)：端口 `18275`，只使用 Node.js 内置模块。

三个示例仅监听本机，不依赖数据库；启动和接口检查步骤见各自的 README。

## 开发与测试

[![CI](https://github.com/duyiliu/agent-app-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/duyiliu/agent-app-manager/actions/workflows/ci.yml)

改动 `manager.mjs` / `manager-ui` / `lib` 后运行：

```bash
npm test          # 完整冒烟
npm run check     # 全部 .mjs 语法检查 + 脱敏 / 健康 / 环境 / 运行时冒烟
```

`npm test` / `npm run check` 由 `scripts/test-all.mjs` 发现式执行 `test/` 下全部冒烟：日志轮转、管理台、健康总览、生命周期与未结记录、env / envFile、`--wait-ready`、remove / prune / 统一日志源、日志过滤、管理台日志源跟随、真实进程生命周期等。CI 分三档：PR 上 `ubuntu-latest` 跑全量冒烟（约 3 分钟）、`windows-latest` 跑关键集冒烟（约 4.5 分钟，覆盖生命周期、env 脱敏、发现证据、锁、remove/prune）；`windows-latest` 全量冒烟拆为矩阵并行约 4-5 分钟，只在发版 tag、每周巡检、手动触发时运行（main push 与 PR 均不跑）；macOS 未纳入支持范围。

## 开发边界

Skill 负责理解目标项目；确定性脚本只负责需要可靠重复执行的操作。不要为了支持更多语言预先引入通用适配框架、Daemon、数据库或 MCP。跨项目能力的验收要求见 [design.md](docs/design.md)。
