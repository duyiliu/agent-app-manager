# AGENTS.md — agent-app-manager

给在本仓库工作的 AI Agent 读的说明书。目录名仍叫 `project-runner`，但**包名、远端仓库、Skill 名都已改成 `agent-app-manager`**（v0.6.0 改名）。不要沿用旧名写新代码、新文档或新分支。

## 项目是什么

统一管理"由 AI Coding Agent 启动并登记"的本地应用：跨 Agent、跨会话的生命周期管理、状态监控、日志和本地 Web 控制台。

- 发布形态是 **Skill**（`skills/agent-app-manager/`），不是 npm 包 —— `package.json` 里 `"private": true`、`dependencies` 为空。
- 仓库是**零依赖的纯 Node ESM 脚本项目**，没有打包产物。`dist/`、`node_modules/` 都不存在。
- 只管**由本 Skill 启动并登记**的应用，不接管外部进程，不声称全机启停。

## 常用命令

Node.js **>= 20**。

```bash
npm run build     # 全部 .mjs/.js/.cjs 的 node --check 语法校验 + 版本一致性校验
npm test          # scripts/test-all.mjs 发现式执行 skills/*/scripts/test/ 下全部冒烟
npm run check     # build + test，提交前跑这个
```

`build` 除了语法校验还有一道**版本漂移闸**：`package.json` 的 `version` 必须与
`skills/agent-app-manager/scripts/lib/constants.mjs` 里的 `MANAGER_VERSION` 完全相等，发版漏改任一处会直接 fail。
发版时两处一起改。

单个冒烟可以直跑，例如 `node skills/agent-app-manager/scripts/test/ui-smoke.mjs`。

## 仓库结构

```text
skills/agent-app-manager/
├── SKILL.md              # Agent 路由与通用边界（这是产品主体，改行为先读这里）
├── references/           # 按需加载：java / python / node / other-stacks / manager / jrebel-setup
└── scripts/
    ├── manager.mjs       # CLI 入口
    ├── log-writer.mjs    # detached 日志转发 / 轮转 / 重启监督
    ├── exit-watcher.mjs  # 命令模式目标的真实退出状态记录
    ├── lib/              # 领域模块，每个文件一件事（detect / launch / locks / logs / probe …）
    ├── manager-ui/       # 管理台页面与本地服务前端
    ├── ps/ + linux/      # 平台适配：Windows PowerShell / Linux pidfd
    └── test/             # 18 个 .mjs：16 个进自动套件，locks-stress 手动压测，platform.mjs 是辅助库
docs/
├── design.md             # 跨项目管理设计与**验收基线**，改能力先读
├── ops/                  # 运维记录
└── verification/         # 验收证据
examples/                 # 三个本地测试项目：spring-boot(18273) / python-flask(18274) / node(18275)
```

运行时数据在 `~/.agent-app-manager/`（Windows: `%USERPROFILE%\.agent-app-manager\`）：
`registry.json`、`runtime/<appId>.json`、`logs/<appId>/<runId>.*.log`、`locks/`。
**升级不清理数据目录**，改动这块要保证旧数据可读。

## 硬约束

1. **不要在 `env` 里放机密。** `env` 的字面值明文写入 registry。机密走系统环境变量 + `envRefs`，或 `envFile`（后者只在启动时读取，不落 registry / runtime / status / UI）。有测试专门守这条（`discovery-redaction-smoke.mjs`）。
2. **开发边界**（README「开发边界」有原文）：Skill 负责理解目标项目，确定性脚本只负责需要可靠重复执行的操作。**不要为了支持更多语言预先引入通用适配框架、Daemon、数据库或 MCP。**
3. **支持范围是 Linux + Windows。macOS 不在支持范围**，不要为它加适配或把它写进文档承诺。CI 上 PR 跑语法 + Linux 全量 + Windows 关键集（约 5 分钟）；Windows 全量（含 `runtime-smoke`）在 push main、发版 tag、每周巡检时跑，PR 打 `ci:windows` 标签可提前触发。改 `ps/`、`proc`、`discovery`、`launch` 这类 Windows 特有路径时，合并前打标签让全量实际跑一遍。
4. **同名升级路径有状态机**：旧 `~/.project-runner/` 会自动复制到新目录并保留旧目录；旧进程还在跑时**暂缓复制**、提示停止后重试；新旧目录并存时升级逻辑不做任何操作。改 `home.mjs` / `legacy-skill.mjs` 前先读这两处的现有分支条件。

## 工作约定

- **中文**：提交信息、文档、代码注释、CLI/UI 文案一律中文（技术标识符、命令、路径除外）。
- **提交信息**用 Conventional Commits，scope 取模块名，正文带 issue 号：
  `feat(ui): 登记备份导出/导入入口（#142）`、`fix(manager): 退出监督、注册表覆盖、日志轮转与 pwsh 探测修复`。
- **分支按 issue 走**：`agent/issue-<N>`，一个 issue 一个分支，改完开 PR 到 `main`。历史上批量修复用 `agent/issue-batch-fixes` / `agent/issue-batch2-fixes`。
- **两个远端**：`origin` = GitHub(`duyiliu/agent-app-manager`)，`gitlab` = 内网 `192.168.1.239`。推之前确认目标远端，别默认全推。
- **改前先看 issue 列表**：`gh issue list`。当前未关 issue 集中在 UI 细节（#161–#168）、manager 健壮性（#170、#173、#174）和文档漂移（#169）。#169 是**已知的文档与实现不一致**（CI 描述、Node 版本、降频口径、design.md 合并残留）—— 引用 README 里这几项时不要当作权威。
- 加新冒烟就放 `skills/agent-app-manager/scripts/test/`，`test-all.mjs` 会自动发现，不用登记。

## 本地验证

`examples/` 下三个示例是改动的现成靶子，端口分别为 18273 / 18274 / 18275，只监听本机、不依赖数据库。
改动涉及启动链路或管理台时，用它们跑一遍真实进程生命周期，别只跑语法校验。

## 待确认

- `docs/design.md` 与 `docs/verification/` 的具体验收清单口径未在此文件复述，涉及跨项目能力时直接读原文。
- `.flowly/project.json` 是 Flowly 看板的本地项目文件（`format: flowly-project`），没有任何脚本读取它，不要当配置源。
