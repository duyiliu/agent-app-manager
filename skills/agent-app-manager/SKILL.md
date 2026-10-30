---
name: agent-app-manager
description: Agent App Manager：统一管理由 AI Coding Agent 启动并登记的本地应用，提供跨 Agent、跨会话的生命周期管理、状态监控、日志和 Web 控制台。
---

# Agent App Manager

默认数据目录为 `~/.agent-app-manager/`；仅有旧 `~/.project-runner/` 时由 manager 自动复制升级，保留旧目录。旧应用或日志进程仍运行时暂缓复制并提示停止后重试；新旧目录并存时升级逻辑不做任何操作。显式 `--home` 和 `start/restart --dry-run` 不复制。`migrate`、`doctor` 和首次升级提示会列出仍存在的旧 `project-runner` Skill 路径（只提示，不自动卸载）；确认新版能查看应用与日志后，再提示用户自行清理旧副本。

**首次运行的升级提示要转述给用户**：管理命令输出中出现"数据目录升级暂缓"、旧数据目录路径或旧 Skill 路径时，把路径和给出的 `migrate` / 删除命令原样报告，不要代执行删除，也不要因此中止当前任务。

本 Skill 覆盖 Java/JRebel 单项目流程（第 0–7 节）、非 Java 主流栈（第 1A 节）与跨项目 `manager.mjs` 管理（第 8 节）。只操作**由本 Skill 启动并登记**的应用，不接管外部进程，不声称全机启停。不要要求用户手工提供可从项目中识别的构建工具、主类、classpath、端口或插件信息。Java 默认 `mode: java`；仅当项目已有 JRebel 配置（启动脚本引用 agent、仓库有 `rebel.xml`、构建文件含插件）或用户明确要求时才用 `mode: jrebel`，否则不做 JRebel 环境检查。非 Java 的 `mode` 只是登记标签，受管能力取决于能否解析真实目标进程。

Standalone JRebel 不依赖 IDE 插件；安装路径、`REBEL_HOME`/`REBEL_BASE` 与授权细节见 [JRebel 初始化与授权参考](references/jrebel-setup.md)。

## JRebel 环境初始化、安装与授权

当用户明确要求初始化或安装 standalone JRebel 时，按需阅读 [JRebel 初始化与授权参考](references/jrebel-setup.md)。仅询问方法时只说明，不下载或修改环境；执行前先报告目标目录、环境变量和许可来源。项目文件修改、下载、环境变量及许可写入均遵循用户授权与不覆盖既有配置的边界。



## 0. 先区分用户要做什么.

管理台的应用详情可按需打开项目内 scenario-test 工作台：默认取项目根 `scenario-test`，缺失或不完整时在项目根内扫描自定义接入目录；直接复用项目 CLI 的 `serve`，同一配置复用同一受管实例；工作台在独立本地端口打开，停止不影响业务进程，打开不会运行场景。缺失文件时不自动安装或升级。

- 用户只问 skill、启动方式、能力或让你分析项目：只检查并说明，不启动服务、不编译、不改配置。用户询问如何安装/初始化时提供步骤，但不下载、不解压、不配置环境。
- 用户要求生成启动方案：执行项目发现并给出匹配结果与命令，不启动服务。
- 用户明确要求启动/重启/验证：先完成项目发现与启动前检查；匹配唯一且关键配置齐全时执行。遇到歧义、配置缺失或存在会影响其他服务的操作时停止并说明，不猜测、不扩大操作范围。
- 用户明确要求编译/场景测试时，才执行相应构建或测试命令；单纯启动不要擅自跑整套测试。

## 1. AI 项目自动发现协议

**先分派栈类型**：Java 标记（`pom.xml`/`build.gradle*`/`.java-version`）→ 阅读 [Java 启动参考](references/java.md)；Python 标记（`pyproject.toml`/`requirements.txt`/`Pipfile`/`manage.py` 等）→ [Python 启动参考](references/python.md)；Node/前端标记（`package.json` 等）→ [Node 启动参考](references/node.md)；其他栈标记（`go.mod`/`.csproj`/`composer.json`/`Cargo.toml` 等）→ [其他栈启动参考](references/other-stacks.md)。混合仓库按用户要启动的目标分别读对应文件，同仓库多应用用 `entry` 区分登记。各栈证据规则与授权边界相同。

从当前工作目录向上定位仓库根目录，先读取根目录及相关模块的 `AGENTS.md`、README/开发说明和已有启动脚本。遵守项目自己的启动约定；发现约定相互冲突时，以仓库当前明确说明为准，并指出冲突。

识别顺序是：先收集“项目允许哪些启动形态 + 硬性要求”，再用“本机此刻的事实”过滤，最后才拼命令。**项目类型不是结论**——识别出 Spring Boot 不推出任何具体命令，只说明插件、fat jar、`-cp` 主类等候选为何可能存在；反过来也不能用本机装了什么反推项目需要什么。证据够用即停（找到启动脚本或对应构建插件即可进入下一步），不必为凑齐检查项做大仓库全量画像。每项标注来源：`[项目]` 仓库事实，可直接采用；`[环境]` 本机事实，必须实测；`[比对]` 两侧必须对齐，不一致时报告而非择一冒充。

各栈的具体证据清单见对应 reference；先读清单再执行，不要凭记忆补全构建工具、主类、端口或插件信息。

## 1A. 非 Java 项目识别与启动

检测到 Python 标记 → 阅读 [Python 启动参考](references/python.md)；Node/前端标记 → [Node 启动参考](references/node.md)；其他栈标记 → [其他栈启动参考](references/other-stacks.md)。三者的共同边界：

- 受管优先级：`exe` 直连 → `command`+`expectedImage` 命令模式 → 非受管登记；前两者都不行才登记为非受管，不得伪造托管。
- `.cmd`/`.bat`/`.ps1` 包装、WindowsApps 执行别名、Linux `#!` 包装不得直接作为受管 `exe`。
- `mode` 取 `python`、`node`、`proc`；端口只采用项目证据，歧义即停。

## 2. 展示匹配结果与处理不确定项

实际执行启动前，用简短清单向用户说明 AI 识别结果：

- 仓库根目录、构建工具/模块、应用入口；
- 运行时来源及版本（Java 为 JDK；非 Java 为解释器/node/编译产物路径）、目标端口/profile；
- **候选启动形态与取舍**：项目脚本/构建插件/产物直连/命令模式中哪些可用、为何选当前项、其余因何排除（产物过期、脚本含未授权副作用、profile 不符等）；
- 采用的项目启动脚本或生成的启动方式；
- Java 项目还需确定 `mode`：`java` 还是 `jrebel`——按 [Java 启动参考](references/java.md) 第 1 节第 6 项的项目实际配置决定（无 JRebel 配置即 `java`，不做环境补齐）；选 `jrebel` 时才展示 agent、`rebel.xml` 监控目录、可用插件；
- 编译产物是否已存在/是否需要编译、日志文件位置、就绪判据；
- 尚未能确定的配置或已知能力限制。

若关键信息有多个合理候选（例如多个主类、多个有效端口、多个 profile）或发现配置缺失，**不要启动错误目标**。能从源码继续确定就继续检查；仍有歧义时向用户报告具体候选和阻塞原因。

## 3. 编译与启动命令匹配

先完成第 4 节第 1–3 条的阻断判定（已有受管实例、端口占用、端口冲突处理策略），再执行任何编译、资源同步或项目文件改动；已被阻断时停在报告，不先花一轮构建。

- 先判断目标模块的编译产物是否存在且与源码相符。遵循仓库文档指定的构建命令和模块范围；不要默认用 `clean`（它会删除输出）或整个仓库 `install`。
- 启动任务本身不等于授权执行任意构建。如果缺少/过期的 class 文件导致无法启动，说明将执行的精确构建命令及影响；用户已明确要求“编译后启动/验证”时按项目约定执行，否则先停在方案并告知需要构建。
- `manager start/restart` 不会编译；Java 源码变更后先按项目命令增量编译（默认不 `clean`），JRebel 模式确认出现 `Reloading class`，未出现再排查产物。
- 项目脚本存在且安全时，按项目约定调用它。项目脚本通常负责模块 classpath、JVM 参数、插件和日志，skill 不重复实现其内部逻辑。
- Java/Spring Boot 的启动选型、classpath、JRebel 参数与 MyBatis-Plus 插件见 [Java 启动参考](references/java.md) 第 2 节；其他栈见对应 reference。

## 4. 启动前安全检查

本节第 1–3 条是第 3 节编译、资源同步或改项目文件之前的前置阻断条件；第 4–5 条在真正启动前复核。

1. 检查目标端口及已有项目进程。若同一项目已有受管实例正常运行（无论 `mode` 是 `java` 还是 `jrebel`），优先复用它；只有用户已授权本轮编译时才先构建，再按项目模式验证热加载或重启式验证。
2. 若端口被占用，报告 PID、进程信息与日志线索，默认不杀进程、不启动第二份。只有用户明确要求重启/停止且目标进程已核实属于当前项目时才停止；不要只凭端口号猜测进程归属。
3. 不自动选择另一个端口来绕开冲突，因为应用的外部依赖、回调地址或 profile 可能仍指向原端口。只有用户明确要求隔离验证并确认替代端口可用时才采用。
4. 启动日志放在目标仓库 `.tmp/` 下，确保目录存在；通用启动日志命名必须与 `manager ui` 的 `.tmp` 兼容扫描规则匹配：
   - `jrebel-local-<yyyyMMdd-HHmmss>.stdout.log` / `.stderr.log`（Java/JRebel 沿用名）
   - `runner-local-<yyyyMMdd-HHmmss>.stdout.log` / `.stderr.log`（非 Java 项目脚本日志的通用名，同规则被扫描）
5. 不自动修改项目配置、`rebel.xml`、启动脚本、数据库或远程环境。若发现启动所需项目文件缺失，按 [Java 启动参考](references/java.md) 第 1 节第 6 项展示方案并取得明确授权后再改。

## 5. 就绪判定与热加载验证

- 后台启动并将 stdout/stderr 重定向到上述日志文件，勿在前台长时间等待。
- 受管 `start`/`start-new`/`restart` 可加 `--wait-ready [--ready-timeout <ms>]`（默认 60s）：启动前必须已配置 `readyLogPattern`/`readyUrl`，否则用法错误且不产生进程；进程 RUNNING 后同步轮询就绪，READY 才返回 0，超时返回退出码 6/`READY_TIMEOUT` 且进程保持 RUNNING，进程提前退出立即失败。等待期从本批次日志起点增量扫描（上限 `logMaxBytes`），不会漏掉超出 5000 行尾部窗口的早期标记。
- 再确认应用自身就绪消息（Java 的 started 日志、vite 的 `Local: http://...`、uvicorn 的 `Application startup complete`、Django 的 `Starting development server at` 等，以项目实际输出为准）或项目明确的 readiness 接口，并核对目标端口监听。端口开放或通用 health 成功只说明进程存活，不足以证明目标业务功能生效。
- 验证具体改动时，按用户要求调用业务接口或既有场景；不擅自执行全量测试、制造/清理业务数据。
- Java/JRebel 的 banner、`Reloading class`、mapper XML 与 `jrebel.log` 位置见 [Java 启动参考](references/java.md) 第 3 节；`mode: java` 没有热加载，验证方式只能是重新编译并重启，重启前说明服务中断影响。
- **统一日志网页（manager ui）**：本 Skill 执行任何受管操作（detect/start-new/start/stop/restart/record-unmanaged）时，先后台确保 ui 已运行并把固定地址 `http://127.0.0.1:8199` 交给用户，不等用户询问：
  ```bash
  node "<当前实际安装的 agent-app-manager Skill 目录>/scripts/manager.mjs" ui [--port N]
  ```
  该命令前台常驻，须以 detached/后台方式拉起；退出码 3 表示已有实例，直接复用地址；启动前确认 `node --version` 可用。日志源、文件树、生命周期按钮、`?app=` 直达与安全边界详见 [manager 参考](references/manager.md) 第 7 节。
- 无需网页时可跟踪最新日志：
  ```bash
  tail -f "$(ls -t .tmp/jrebel-local-*.stdout.log | head -1)" \
    | grep --line-buffered -E "JRebel:|Reloading|ERROR"
  ```

## 6. 已知边界与故障处理

- 任何未知脚本在执行前都应阅读检查；“文件名像启动脚本”不代表其安全、正确或适用于当前 profile。
- **锁冲突 `LOCK_BUSY`（退出码 3）要重试**：另一个 manager 正在操作同一应用或注册表，通常毫秒级结束。退避重试（0.5s / 1s / 2s，最多 3 次），不要直接当失败报给用户；3 次仍忙再看 `error.detail`（含 `pid`/`op`/`file`），确认该进程已退出后删除锁文件再重试。`LOCK_UNWRITABLE`（退出码 5）、`ALREADY_RUNNING`、`PORT_IN_USE` 不重试。
- Java/JRebel 的 `rebel.xml`、agent、资源同步、mapper XML 与 lambda 缓存问题见 [Java 启动参考](references/java.md) 第 4 节。

## 7. AI 输出要求

用户要求实际启动时，按顺序报告：项目识别结果 → 启动前检查/是否复用或被端口阻塞 → 启动命令或脚本 → 与 `mode` 对应的启动证据（`jrebel` 的 banner/热加载证据，`java`/`python`/`node`/`proc` 的进程存活+就绪输出证据）与应用就绪证据 → 用户要求的业务验证结果 → **管理台入口**。失败要引用日志证据并说清是否有进程/文件/数据副作用；没有执行的步骤不要声称完成。

**管理台入口是每次汇报的固定项**，不要等用户问。口径：

- ui 未运行 → 先后台拉起（见上节），给出 `http://127.0.0.1:8199`（或 `--port` 端口），并说明可 `?app=<别名>` 直达某个应用；地址固定可收藏。
- ui 已在运行 → 直接给同一固定地址。
- 地址仅本机可达；页面可启停受管应用、日志可能含敏感信息，不转发、不写入文件、不贴进提交信息。

## 8. 跨项目管理（manager.mjs，多项目/跨会话）

跨项目命令、数据、安全与恢复规程见 [manager 参考](references/manager.md)。常用路径：只读 `detect --root <仓库根目录>` 取候选 → `start-new` 登记 → `list/status/start/stop/restart/logs` 管理；`start/restart --dry-run` 可预览；`status --resources` 取单次资源快照；`--tag` 批量逐条执行，必须检查 `results[].ok`。只操作本 Skill 启动并登记的应用，不接管外部进程；UNKNOWN/STARTING 未结记录不得绕过或删除。命令模式失败且 wrapper 证据完整时用 `cleanup-wrapper` 只清理 wrapper，目标候选/后代须按进程证据人工处置。`manager ui` 入口见第 5 节。
