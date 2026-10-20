---
name: project-runner
description: Agent 驱动的本地项目启动助手：识别并启动 Java/Spring Boot（含 standalone JRebel）、Python、Vue/React/Vite 等 Node 前端与其他主流栈项目，启动、查看日志并验证热更新。用户要求启动本地服务/项目、配置或排查 JRebel、查看运行日志、打开本地 Web 管理台（manager ui，默认固定 http://127.0.0.1:8199）时使用；跨项目运行管理与只读管理台（manager.mjs list/status/start/stop/restart/remove/prune/logs/ui）已实现，用法见第 8 章。
---

# Project Runner · 多语言项目启动 / Standalone JRebel 流程

本 Skill 覆盖三部分能力：Java / JRebel 单项目专项流程（第 0–7 节）、非 Java 主流栈识别与启动（第 1A 节：Python / Node 前端与后端 / 其他真实进程）与跨项目运行管理 `manager.mjs`（第 8 节，已实现）。跨项目管理只操作**由本 Skill 启动并登记**的应用进程，不接管外部进程，不声称全机启停能力。本 Skill 的目标不是提供一条适用于所有项目的固定命令，而是让 AI 先从当前仓库识别项目，再匹配最合适的启动方式。**不要要求用户手工提供可从项目中可靠识别的构建工具、主类、模块 classpath、端口或插件信息。** Java 项目的默认路径是普通 Java 启动（`mode: java`）。**JRebel 是否启用完全按项目实际配置与用户要求决定**：项目已有 JRebel 配置（启动脚本已引用 rebel agent、仓库已提交 `rebel.xml`、构建文件含 JRebel 插件）或用户明确要求时才进入 `mode: jrebel` 路径；其余情况一律普通启动，不做 JRebel 环境检查、不要求 `REBEL_HOME`/`rebel.xml`，不把它当作启动前置条件。非 Java 项目同理：mode 只是登记/展示标签，受管能力取决于能否解析出真实目标进程。

Standalone JRebel 不依赖 IDE 插件。安装路径优先从进程/用户环境变量 `REBEL_HOME` 或 `JREBEL_HOME` 解析；两者均未设置时，检查用户指定路径和平台常见安装目录，不将某台机器的绝对路径当作通用默认值。`REBEL_HOME`/`JREBEL_HOME` 指向安装根目录，`REBEL_BASE`/`-Drebel.base` 指向用户配置、许可和日志目录，两者不可混淆。

## JRebel 环境初始化、安装与授权

当用户要求初始化 standalone JRebel 环境时，按本节从“检查已有环境”开始，补齐缺失项，再验证 agent 与许可。用户只询问安装方法时仅说明，不下载、不解压、不改环境变量；用户明确要求初始化/安装后，先报告计划使用的安装目录、用户级环境变量和许可来源，再执行。不要覆盖已存在的 JRebel 安装或用户配置。

### 初始化前置检查与步骤

**JDK 是用户自行下载和安装的前置依赖，本 skill 不下载、不安装、不升级 JDK。** JRebel 要求 JDK 8 或更高版本；目标项目可能有更高的最低版本要求。初始化与启动前，先确认项目要求、操作系统/CPU 架构，以及真正运行应用的 JDK（不只看 shell 中的 `java -version`，还要检查 `JAVA_HOME`、PATH、JDK 位数和项目启动脚本选用的 `java`）。若 JDK 缺失或版本过低，停止后续安装/启动步骤，告知用户应自行安装兼容版本；安装完成后再继续。若原生 agent 与操作系统/CPU 架构不匹配，先查官方 `agent-setup.md` 是否有兼容 agent 或 `-javaagent` 两段式 bootstrap 回退；确无受支持路径时再停止并报告。不得把 JRebel 安装包误当成 JDK。

1. **检查 JDK 前置条件**：从仓库构建配置/项目约定识别目标 JDK 版本，再检查本机可用 JDK 和启动命令实际选用路径。项目要求优先于通用的“JDK 8+”。不匹配时只报告项目要求与当前检测结果，等待用户安装/切换后再继续；不改 `JAVA_HOME` 或 PATH 来掩盖不匹配。
2. **检查现有 JRebel 环境**：检查进程级/用户级 `REBEL_HOME`、该目录下与操作系统/CPU 架构匹配的 agent 文件、`~/.jrebel/` 用户数据目录及 PATH。只检查路径和文件是否存在，不读取或回显 `jrebel.properties` 的内容。已有可用安装则复用，不重复下载。
3. **获取 standalone 发行包**：如果没有安装且用户已授权安装，从官方稳定版地址下载：<https://dl.zeroturnaround.com/jrebel-stable-nosetup.zip>。解压到用户指定目录；agent 库位于解压目录的 `lib/`。按第 1 步确定的平台和架构选择文件，例如 Windows 64 位通常为 `lib/jrebel64.dll`。下载失败或官方源不可达时停止并报告，不使用未知镜像。
4. **配置安装路径**：将 `REBEL_HOME`（或项目已有约定的 `JREBEL_HOME`）指向解压后的 JRebel 根目录（不是 `lib/`），优先按用户要求设置用户级环境变量；除非用户明确要求，不修改系统级环境变量。当前进程通常不会自动继承刚设置的环境变量，后续启动时可显式提供该变量；验证新会话/进程能解析到正确目录。不得覆盖用户已有的有效值，若值冲突先报告。
5. **初始化用户数据目录**：`REBEL_BASE`/`-Drebel.base` 用于许可、设置与日志，不是安装目录。默认用户目录为 `~/.jrebel/`；如需放置用户提供的 `jrebel.lic`，遵循用户指定位置（默认可放 `~/.jrebel/jrebel.lic`），也可在用户明确要求时配置 `rebel.license` 指向用户提供的许可文件。不要把许可证文件放进项目仓库、提交或复制到共享目录。
6. **配置授权**：发行包下载不代表许可已激活。许可可来自用户提供的 `jrebel.lic`、组织 license server 或官方试用/激活流程。用户明确要求配置时，按其指定方式使用 license 文件或设置 license server；license URL 可能包含 team token，激活码和许可证内容都属于敏感信息，禁止回显、写入日志、仓库或本 skill。交互式激活需要用户本人输入/确认凭据时，交由用户完成。
7. **项目监控配置**：每个命令行项目都必须能在运行 classpath 上找到有效的 `rebel.xml`。先检查现有配置及 Maven/Gradle JRebel 插件能否生成；若缺失，优先给出项目插件生成方案，其次给出拟创建的 `rebel.xml` 路径、监控目录和内容摘要。生成插件配置或手工创建文件都会修改项目，必须先展示具体改动并取得用户对项目文件修改的明确授权；未授权时停在方案，不声称项目初始化完成。若生成/复制文件后需要构建，遵循第 3 节的构建授权规则；构建获授权后再确认文件进入运行 classpath 且监控目录正确。
8. **项目专属插件另行处理**：`jr-mybatisplus` 等不是 standalone JRebel 安装的一部分。只有项目识别确认需要且插件文件已存在，才在该项目启动参数中配置；不要把单项目插件加入全局 `PATH` 或修改通用环境变量。
9. **初始化后验证**：确认安装根目录下存在与目标操作系统/CPU 架构匹配的 agent 文件；由用户明确要求启动的目标 JVM 验证 JRebel banner 和监控目录。分别报告 agent 是否加载、许可是否有效、热加载是否可用；agent 成功加载不等于许可有效。许可无效或不可达时，不声称初始化完成，也不自动去除 agent 降级启动；说明可选择完成官方激活，或经用户明确同意后不带 JRebel 正常启动并采用重启式验证。

需要试用/激活时，使用 standalone 安装目录提供的官方工具（Windows `activate-gui.cmd` / `activate.cmd`，Linux/macOS `activate-gui.sh` / `activate.sh`），或由用户通过 IDE 官方插件的激活向导完成。调用交互式工具前说明它可能访问外网并修改用户许可配置；需要用户输入/确认凭据时交由用户操作。平台 agent 文件名和官方获取说明参考官方 JRebel skill 的 `references/agent-setup.md` 与 `getting-jrebel.md`（本机安装了官方 jrebel skill 时位于其 skill 目录 `references/` 下，源仓库见 GitHub `zeroturnaround/rebel-skills`）。初始化涉及下载、解压、用户级环境变量和授权文件写入；执行前报告精确目标，涉及覆盖既有配置或系统级设置时先取得用户确认。不得将 license server URL、激活码或许可证内容写入本 skill。

## 0. 先区分用户要做什么.

- 用户只问 skill、启动方式、能力或让你分析项目：只检查并说明，不启动服务、不编译、不改配置。用户询问如何安装/初始化时提供步骤，但不下载、不解压、不配置环境。
- 用户要求生成启动方案：执行项目发现并给出匹配结果与命令，不启动服务。
- 用户明确要求启动/重启/验证：先完成项目发现与启动前检查；匹配唯一且关键配置齐全时执行。遇到歧义、配置缺失或存在会影响其他服务的操作时停止并说明，不猜测、不扩大操作范围。
- 用户明确要求编译/场景测试时，才执行相应构建或测试命令；单纯启动不要擅自跑整套测试。

## 1. AI 项目自动发现协议

**先分派栈类型**：检测到 `pom.xml`/`build.gradle*`/`.java-version` 等 Java 标记走本节 Java 清单；检测到 `package.json`/`pyproject.toml`/`requirements.txt`/`Pipfile`/`.csproj`/`go.mod` 等非 Java 标记走第 1A 节；混合仓库（如 Java 后端 + Vue 前端并存）按用户要启动的目标分别走对应清单，同仓库多应用用 `entry` 区分登记。两类证据规则与授权边界完全相同。

从当前工作目录向上定位仓库根目录，先读取根目录及相关模块的 `AGENTS.md`、README/开发说明和已有启动脚本。遵守项目自己的启动约定；发现约定相互冲突时，以仓库当前明确说明为准，并指出冲突。

识别顺序是：先收集“项目允许哪些启动形态 + 硬性要求”，再用“本机此刻的事实”过滤，最后才拼命令。**项目类型不是结论**——识别出 Spring Boot 不推出任何具体命令，只说明插件、fat jar、`-cp` 主类等候选为何可能存在；反过来也不能用本机装了什么反推项目需要什么。证据够用即停（找到脚本或 boot 插件即可进入下一步），不必为凑齐检查项做大仓库全量画像。每项标注来源：`[项目]` 仓库事实，可直接采用；`[环境]` 本机事实，必须实测；`[比对]` 两侧必须对齐，不一致时报告而非择一冒充。

按以下顺序收集证据。优先读取配置和脚本，不凭目录名猜测：

1. **[项目] 已有启动入口**：检查 `scripts/`、`bin/` 和仓库说明中的 `start-local-jrebel*.ps1`、shell 脚本、Maven/Gradle 启动任务。若项目已有专用脚本，先读其内容并核对它与 AGENTS.md 一致；它是项目参数的权威入口，优先复用，不复制参数重新拼一份。脚本若会杀进程、改配置、执行远端操作或有其他未授权副作用，不要运行，先解释并停下。
2. **[比对] 构建系统与运行形态**：检查 `pom.xml`、Maven wrapper、`build.gradle`/`build.gradle.kts`、Gradle wrapper、Spring Boot 插件、打包配置，这些是项目事实；`target/classes`/`build/classes`/JAR 是否存在、是否落后于源码则是本机事实。识别单模块或多模块、`-cp` 启动或 `-jar` 启动；多模块时纳入目标应用实际依赖的模块，不要把整个仓库目录盲目塞入 classpath。
3. **[项目] 应用入口**：搜索本仓库源码内的 `@SpringBootApplication`、`@SpringBootConfiguration`、`public static void main` 或 Kotlin `fun main`，再对照构建插件、启动脚本、manifest、已有启动日志确认。唯一候选可自动采用；多个候选时结合模块/配置作判断，仍无法唯一确定则报告候选并停止，不任意选主类。
4. **[比对] JDK**：先从仓库约定、Maven/Gradle toolchain、`maven.compiler.release`/`java.version`、`.java-version`/`.sdkmanrc` 取得项目要求；再检查 `JAVA_HOME`、PATH 与启动脚本实际选用的 `java` 得到本机事实。两者不一致或无法确认时报告，不硬编码本机 java.exe 路径，也不改环境来掩盖不匹配。
5. **[比对] 端口与 profile**：检查 `application*.yml`/`.properties`、环境变量示例、启动参数、容器配置和脚本，取得声明值；实际监听端口只能在启动前探测。若端口由 Nacos、环境变量、远程配置或启动参数决定且本地值无法确认，列出不确定项，不把默认端口冒充为有效端口。
6. **[比对] JRebel 监控目录**：仅当项目证据表明已配置 JRebel（既有启动脚本引用 `-agentpath`/`-javaagent` rebel、仓库内已有 `rebel.xml`、构建文件含 JRebel 插件配置）或用户明确要求 JRebel 时，候选方案才包含它，本项才有检查对象；否则跳过，`mode: java` 即可，不为此补齐环境。命令行启动需要运行 classpath 上存在有效 `rebel.xml`：检查文件是否存在、`<dir>` 是否覆盖目标模块的类与资源目录，并核对该目录与当前构建产物目录一致；同时检查 Maven/Gradle JRebel 插件能否生成。若缺失或路径不匹配，先报告拟采用的生成方式、文件路径和改动摘要；生成插件配置或手工创建/修改项目文件前必须取得用户明确授权。授权前停在方案，不启动并声称热加载已就绪。
7. **[比对] 框架插件与 JVM 参数**：从依赖/插件配置识别 Spring Boot、DevTools、MyBatis-Plus 等；插件文件是否存在、路径是否对应当前机器则属环境事实。只在确实适用且插件文件存在时加对应参数；路径使用环境变量或已确认的本机安装位置，不照抄其他项目绝对路径。MyBatis-Plus 桥接插件缺失时默认告警并可继续 Java 类热加载；只有用户明确要求验证 mapper XML 热加载时，才将缺插件视为该项验证的阻塞。
8. **[比对] 日志和就绪标记**：日志路径、就绪消息与健康检查接口来自项目配置和脚本；当前批次日志文件是否存在、就绪探针此刻是否可达属本机事实。日志入口（`manager ui` / `manager logs`）与就绪探针都必须针对当前仓库和当前应用。

## 1A. 非 Java 项目识别与启动（Python / Node 前端与后端 / 其他栈）

非 Java 项目遵循同一证据纪律：先项目事实、再本机事实、端口不猜默认值、歧义即停。受管按优先级三选一——① **exe 直连**（`exe`+`args` 解析为真实 `.exe`/`.com`，detached 最干净）；② **命令模式**（`command`+`expectedImage`：manager 拉起 cmd wrapper 执行脚本/复合命令，再按 PPID 后代发现唯一真实目标托管，覆盖 `npm run dev`、`mvn spring-boot:run`、`.cmd`/`.ps1` 编排、turbo/nx 等解析不了唯一入口的场景；后代多候选 `DISCOVERY_AMBIGUOUS` 拒绝任选）；③ **非受管登记**（前两者都不行才走，不得伪造托管）。脚本包装、转发 shim、WindowsApps 应用执行别名直接填 `exe` 会被 `CONFIG_INVALID` 拒绝。desc 的 `mode` 取值：`python`、`node`、`proc`（其他真实进程，如 Go 产物、dotnet、php）。

### Python

1. **[项目] 依赖与框架**：`requirements.txt`、`pyproject.toml`、`Pipfile`/`poetry.lock`/`uv.lock`、`setup.py`、`environment.yml`（conda）。先读 README/AGENTS.md 的约定命令，再凭依赖声明判断框架（django/flask/fastapi/uvicorn 等），不凭目录名猜。
2. **[比对] 解释器**：优先项目内虚拟环境 `.venv/Scripts/python.exe`、`venv/Scripts/python.exe`（或项目约定的 conda/uv/poetry 环境路径）；其次 PATH `python`——manager 会跳过/拒绝 `Microsoft\WindowsApps\python*.exe` 应用执行别名（未装应用时为 0 字节 stub），全部候选不可用时按报错改用真实解释器路径。**`py` 启动器是拉起子进程的包装，不得作受管 exe**。venv 或依赖缺失（如 import 失败）时报告所需命令（`python -m venv .venv`、`pip install -r requirements.txt` 等），venv 创建与安装属项目环境改动，按第 3 节授权规则先报告后执行。
3. **[项目] 入口**：Django（`manage.py` + settings 模块）→ `python manage.py runserver [addr:port]`；Flask → `python -m flask --app <module> run` 或项目自带 `app.py`；FastAPI/ASGI → `python -m uvicorn <module>:<app>`；脚本型 → `python main.py`/`python -m <pkg>`。多入口候选按第 1 节第 3 项歧义规则报告，不任选一个。
4. **[比对] 端口**：以项目配置与启动参数为准；框架默认（Django 8000、Flask 5000、uvicorn 8000）只是候选，不冒充实际监听。
5. **desc 形态**：`exe`=真实 `python.exe`（venv 优先），`args`=命令去掉 `python` 后的数组，`cwd`=项目根或项目约定目录，`mode`=`python`，`expectedPort` 有证据才填。

### Node（Vue / React / Angular / Next / Nuxt / Vite / Node 后端等）

1. **[项目] 包管理器**：`package.json` 的 `packageManager` 字段 > `pnpm-lock.yaml`/`yarn.lock`/`bun.lock(b)`/`package-lock.json`。包管理器只决定"如需安装依赖用什么命令"，不影响受管启动形态。
2. **[项目] 启动脚本**：`package.json` `scripts` 里的 `dev`/`serve`/`start`/`dev:*` 等及 README 约定；多候选时选一个并说明理由，不擅自全试。
3. **[比对] 依赖就绪**：`node_modules` 缺失或明显过期（lockfile 更新于 `node_modules`）时报告所需安装命令，按授权规则处理，不擅自 `install`。
4. **受管启动形态（关键）**：`npm run dev`/`pnpm dev`/`yarn dev` 在 Windows 下经 `.cmd` shim + cmd 包装拉起真实 node——包装进程不是受管目标，`.cmd` 也会被 manager 直接拒绝。**受管做法是把 script 映射为真实 node 入口**：
   - script 形如 `<bin> <args…>`：读 `node_modules/.bin/<bin>.cmd` 里被调用的 js 入口（`%dp0%` 相对路径），或读对应包的 `package.json` `bin` 字段解析。常见映射：vite→`node_modules/vite/bin/vite.js`，vue-cli-service→`node_modules/@vue/cli-service/bin/vue-cli-service.js`，react-scripts→`node_modules/react-scripts/scripts/start.js`，next→`node_modules/next/dist/bin/next`，nuxt→`node_modules/nuxt/bin/nuxt.mjs`，ng→`node_modules/@angular/cli/bin/ng.js`（`.mjs`/`.cjs` 同理）。
   - script 形如 `node <file>`（Node 后端）→ 该文件即 args[0]。
   - 复合命令（`&&` 串联、`cross-env KEY=V <bin>`）：把最终真正拉起服务的那个进程解析出来；`cross-env` 注入的**非敏感字面值**（如 `PORT=3001`）在调用 `start-new` 的进程环境里设置同名变量即可（manager 会把当前环境整体传给子进程），敏感值用 `envRefs` 只记名称。
   - desc（直连）：`exe`=真实 `node.exe`（`where node` 解析；agent 自身运行在 Node 上时直接用 `process.execPath` 更可靠），`args`=[入口 js 路径, 其余参数]，`cwd`=项目根，`mode`=`node`。
   - **解析不了唯一入口时的命令模式**：`command`=`npm run dev`/`pnpm dev`/原始项目命令原样，`expectedImage`=`node.exe`，`mode`=`node`——manager 拉 cmd wrapper 后在后代中自动定位真实 node 进程托管（含 turbo/nx、自定义串联）。若后代出现多个 node.exe（并行编排多服务）→ `DISCOVERY_AMBIGUOUS` 拒绝并报候选，此时才转非受管。
   - 命令模式与直连都不可行 → 报 `UNSUPPORTED_LAUNCH` 类限制说明后按原授权执行项目命令，`record-unmanaged` 登记日志线索（`--log-hints` 指向 `.tmp/runner-local-*` 日志），不伪造托管。
5. **[比对] 端口**：以实际输出/配置为准；`vite.config.*`/`vue.config.js`/`next.config.*`/`.env*` 中的 `server.port`/`PORT` 优先于框架默认（vite 5173、next 3000、ng 4200、vue-cli 8080）。注意 vite 等在端口被占用时可能自动换用下一个端口并在输出中说明——就绪端口以实际输出为准，不是配置文件。`.env*` 只读取值，不改写、不外泄。
6. **热更新**：前端 dev server 的 HMR/文件监听是框架能力，不是本 Skill 承诺；验证方式=改动源文件后看 dev server 输出或页面。Python 同理（uvicorn `--reload`、flask debug 等由项目配置决定，不擅自添加参数）。

### 其他栈（Go / .NET / PHP / Rust 等）

受管形态首选**真实可执行进程**直连：编译产物 exe、`dotnet <app>.dll`、`php -S`/`php artisan serve`（真实 `php.exe`+参数）这类"运行时+产物"形态。`go run`、`dotnet run` 这类工具链命令的目标是子进程——可直接用命令模式（`command`=原命令，`expectedImage`=最终服务进程映像基名如 `dotnet.exe`/`app.exe`/`php.exe`）托管；两者都不行才走非受管登记，`mode`=`proc`。

## 2. 展示匹配结果与处理不确定项

实际执行启动前，用简短清单向用户说明 AI 识别结果：

- 仓库根目录、构建工具/模块、应用入口；
- 运行时来源及版本（Java 为 JDK；非 Java 为解释器/node/编译产物路径）、目标端口/profile；
- **候选启动形态与取舍**：脚本/插件/fat jar/`-cp` 主类中哪些可用、为何选当前项、其余因何排除（产物过期、脚本含未授权副作用、profile 不符等）；
- 采用的项目启动脚本或生成的启动方式；
- `mode` 选型：`java` 还是 `jrebel`——按第 1 节第 6 项的项目实际配置决定（无 JRebel 配置即 `java`，不做环境补齐）；选 `jrebel` 时才展示 agent、`rebel.xml` 监控目录、可用插件；
- 编译产物是否已存在/是否需要编译、日志文件位置、就绪判据；
- 尚未能确定的配置或已知能力限制。

若关键信息有多个合理候选（例如多个主类、多个有效端口、多个 profile）或发现配置缺失，**不要启动错误目标**。能从源码继续确定就继续检查；仍有歧义时向用户报告具体候选和阻塞原因。

## 3. 编译与启动命令匹配

先完成第 4 节第 1–3 条的阻断判定（已有受管实例、端口占用、端口冲突处理策略），再执行任何编译、资源同步或项目文件改动；已被阻断时停在报告，不先花一轮构建。

无项目脚本时，默认按 Spring Boot 插件 → 已存在且与源码相符的 fat jar → `-cp` 主类的顺序选型。该顺序只是默认偏好，项目约定、profile 要求或产物新鲜度可以推翻它，推翻时在第 2 节说明理由。

- 先判断目标模块的编译产物是否存在且与源码相符。遵循仓库文档指定的构建命令和模块范围；不要默认用 `clean`（它会删除输出）或整个仓库 `install`。
- 启动任务本身不等于授权执行任意构建。如果缺少/过期的 class 文件导致无法启动，说明将执行的精确构建命令及影响；用户已明确要求“编译后启动/验证”时按项目约定执行，否则先停在方案并告知需要构建。
- 项目脚本存在且安全时，按项目约定调用它。项目脚本通常负责模块 classpath、JVM 参数、插件和日志，skill 不重复实现其内部逻辑。
- 无项目脚本时，根据已确认的项目构建结果组装启动命令：Windows classpath 分隔符为 `;`，引用路径和 `-D` 参数；依赖从项目生成的 classpath 或已准备好的依赖目录获取。fat jar 使用 `-jar`。不要把示例中的占位主类或 classpath 当作真实配置。
- 以下 JRebel 参数仅在按第 1 节第 6 项选定 `mode: jrebel` 时添加；`mode: java` 的普通启动一律不带。
- 将 `REBEL_HOME`/`JREBEL_HOME` 展开为实际绝对路径，再传给 `-agentpath`，不要把变量占位符原样传给 JVM。通常优先用平台原生 agent；只有原生 agent 不适用于目标架构时，才按官方 `agent-setup.md` 使用 `-javaagent` 两段式 bootstrap。
- `-Drebel.base` 指向用户配置目录。关闭 Spring DevTools 仅在项目确实使用 DevTools 且项目约定要求时添加。
- MyBatis-Plus 的 mapper XML 热加载可能需要独立桥接插件；按第 1 节第 7 项缺插件策略处理。原生 MyBatis 不因此额外加该桥接插件。

## 4. 启动前安全检查

本节第 1–3 条是第 3 节编译、资源同步或改项目文件之前的前置阻断条件；第 4–5 条在真正启动前复核。

1. 检查目标端口及已有项目进程。若同一项目已有受管实例正常运行（无论 `mode` 是 `java` 还是 `jrebel`），优先复用它；只有用户已授权本轮编译时才先构建，再按项目模式验证热加载或重启式验证。
2. 若端口被占用，报告 PID、进程信息与日志线索，默认不杀进程、不启动第二份。只有用户明确要求重启/停止且目标进程已核实属于当前项目时才停止；不要只凭端口号猜测进程归属。
3. 不自动选择另一个端口来绕开冲突，因为应用的外部依赖、回调地址或 profile 可能仍指向原端口。只有用户明确要求隔离验证并确认替代端口可用时才采用。
4. 启动日志放在目标仓库 `.tmp/` 下，确保目录存在；通用启动日志命名必须与 `manager ui` 的 `.tmp` 兼容扫描规则匹配：
   - `jrebel-local-<yyyyMMdd-HHmmss>.stdout.log` / `.stderr.log`（Java/JRebel 沿用名）
   - `runner-local-<yyyyMMdd-HHmmss>.stdout.log` / `.stderr.log`（非 Java 项目脚本日志的通用名，同规则被扫描）
5. 不自动修改项目配置、`rebel.xml`、启动脚本、数据库或远程环境。若发现启动所需项目文件缺失，按第 1 节第 6 项展示方案并取得明确授权后再改。

## 5. 就绪判定与热加载验证

- 后台启动并将 stdout/stderr 重定向到上述日志文件，勿在前台长时间等待。
- `mode: jrebel` 时先确认日志出现 JRebel banner/监控目录；`mode: java`/`python`/`node`/`proc` 跳过该步。再确认应用自身就绪消息（Java 的 started 日志、vite 的 `Local: http://...`、uvicorn 的 `Application startup complete`、Django 的 `Starting development server at` 等，以项目实际输出为准）或项目明确的 readiness 接口，并核对目标端口监听。端口开放或通用 health 成功只说明进程存活，不足以证明目标业务功能生效。
- 验证具体改动时，按用户要求调用业务接口或既有场景；不擅自执行全量测试、制造/清理业务数据。
- `mode: jrebel` 下 Java 类变更查看 `Reloading class ...` 等日志；mapper XML 是否热加载取决于项目插件配置，查看 `Reloading SQL maps`。若未出现热加载日志，先检查产物同步和监控目录，不直接断言启动失败。`mode: java` 没有热加载，验证方式只能是重新编译并重启，重启前说明服务中断影响。
- **统一日志网页（manager ui）**：先确认 `node --version` 可用，前台启动（路径按实际安装位置解析，无需 cd 到业务目录）：
  ```bash
  node "<当前实际安装的 project-runner Skill 目录>/scripts/manager.mjs" ui [--port N] [--open]
  ```
  打开启动输出里的带令牌 URL（默认固定 `http://127.0.0.1:8199`；令牌每次启动变化，勿转发）；`--open` 在监听成功后用默认浏览器打开该 URL（默认不开：Agent 前台拉起场景不期望弹浏览器；打开失败降级为仅打印 URL，不阻塞 ui）。左侧为已登记应用列表，右侧展示状态、未结记录证据与日志；日志源选择器统一覆盖受管批次（数据目录）、非受管登记线索与项目 `root/.tmp/jrebel-local-*` 兼容日志，默认优先当前批次 stdout，支持增量跟踪、正则过滤与「只看错误」开关（渲染层过滤，清空恢复，无效正则有提示）、着色与暂停续传。顶部"文件"打开所选应用的只读项目文件树与带行号文本预览（UTF-8 前 256KB，二进制仅显示元信息）。`?app=<别名>` 可直达单项目；页面中选择应用后地址会回写 `?app=`，刷新保持选中。日志与文件接口拒绝路径穿越、符号链接，隐藏 `.git`、`node_modules`、`.env*`、常见私钥与许可文件；不提供上传、修改、删除，不承担内容脱敏，仅绑 `127.0.0.1`，禁止对外网开放。8199 被占用时按启动提示复用已有实例或换 `--port`。

  **适用范围**：管理台同时覆盖受管与非受管应用——非受管应用只能查看日志线索与 `.tmp` 兼容日志，不承诺生命周期控制。原单项目 viewer 已移除，其日志与文件树能力并入本台；若 Node 不可用，用下方命令行跟踪或 `manager logs`。

  日志面板支持跟随/恢复跟随、清屏、正则过滤/只看错误与级别着色（JRebel/错误/警告/SQL），向上滚动自动停止跟随；日志仅缓存最近 8000 行，截断会显示提示，不是完整日志归档。文件抽屉扩大了本机可读范围：仅绑定 `127.0.0.1`，不要将端口代理或转发到局域网或公网；目录浏览的过滤不代表所有项目配置都已脱敏。仅本机可信用户使用。

  若无 `.tmp` 或尚无启动日志，文件树仍可使用，日志区显示暂无启动日志。
- 无需网页时可跟踪最新日志：
  ```bash
  tail -f "$(ls -t .tmp/jrebel-local-*.stdout.log | head -1)" \
    | grep --line-buffered -E "JRebel:|Reloading|ERROR"
  ```
- JRebel 自身的许可证和 agent 错误优先从实际配置的 `REBEL_BASE` / `-Drebel.base` 下查找 `jrebel.log`；若未单独配置，Windows 默认位置通常为 `%USERPROFILE%\.jrebel\jrebel.log`，Linux/macOS 为 `~/.jrebel/jrebel.log`。

## 6. 已知边界与故障处理

1. `rebel.xml`、agent 路径、`-Drebel.*` 与 `jrebel.properties` 是 JVM 启动期配置，修改后必须重启；按第 1 节授权边界处理项目文件，许可配置按初始化步骤处理。
2. 对已正确纳入 JRebel 监控目录且已编译到监控输出的受支持代码变更，通常可热加载，不应无依据地重启；具体仍受 JRebel 与框架插件能力限制。类结构、框架元数据、mapper XML 等情况应按实际日志和项目配置验证，不能把“改代码永不重启”当绝对承诺。
3. 修改 resources（yml/XML/properties）时，先按项目构建命令把资源同步到 JRebel 监控的输出目录；源码目录变更本身不代表运行进程能看到新资源。远程配置或容器挂载资源另行核实。
4. MyBatis-Plus 桥接插件缺失时的默认行为按第 1 节第 7 项处理：告警后可继续 Java 类热加载，XML 热加载验证则报告阻塞。
5. 运行中新增代码路径报 `_jr$$flc$N` 相关 `LambdaConversionException` 且重编译无效，可能是 JRebel lambda 缓存问题。不要反复清理或杀进程；先查日志与已知项目经验，必要时提出不带 agent、换隔离端口验证的方案，不能擅自占用新端口或停掉现有服务。
6. 任何未知脚本在执行前都应阅读检查；“文件名像启动脚本”不代表其安全、正确或适用于当前 profile。

## 7. AI 输出要求

用户要求实际启动时，按顺序报告：项目识别结果 → 启动前检查/是否复用或被端口阻塞 → 启动命令或脚本 → 与 `mode` 对应的启动证据（`jrebel` 的 banner/热加载证据，`java`/`python`/`node`/`proc` 的进程存活+就绪输出证据）与应用就绪证据 → 用户要求的业务验证结果 → **管理台入口**。失败要引用日志证据并说清是否有进程/文件/数据副作用；没有执行的步骤不要声称完成。

**管理台入口是每次汇报的固定项**，不要等用户问。口径：

- ui 已在运行 → 直接给出该实例终端打印的**带令牌完整 URL**（形如 `http://127.0.0.1:8199/?t=<令牌>`），并说明可 `?app=<别名>` 直达某个应用。
- ui 未运行 → 给出固定地址 `http://127.0.0.1:8199`，同时说明它需要先启动 ui（`node "<安装目录>/scripts/manager.mjs" ui`）才能访问，令牌每次启动变化，因此固定端口不等于可直接收藏的 URL。
- 地址含访问令牌，只在当前会话交给用户本人，不转发、不写入文件、不贴进提交信息。

## 8. 跨项目管理（manager.mjs，多项目/跨会话）

定位：全局安装一次本 Skill 后，在任意业务目录用同一数据目录（默认 `~/.project-runner/`）查看与管理**由本 Skill 启动并记录**的应用进程（Java/Python/Node/其他真实进程同理）。不是全机进程管理器；IDEA/手工命令行/Docker 启动的进程一律不接管、不停止，只可在端口冲突诊断时查看。统一入口（路径按实际安装位置解析，无需 cd 到业务目录）：

```bash
node "<安装目录>/scripts/manager.mjs" [--home <隔离数据目录>] [--json] <命令>
# list | status <别名|appId> | start <别名|appId> [--ack-unresolved <runId>] | stop <别名|appId> | restart <别名|appId>
# remove <别名|appId> [--ack-unresolved <runId>]　移除登记（须无存活受管实例；只删注册表条目，运行记录与日志证据保留）
# prune [--dry-run] [--apply]　回收超保留期批次日志/死锁残留/孤儿临时文件（默认 dry-run，--apply 才删除）
# logs <别名|appId> [--lines N] [--stream stdout|stderr|both] [--run <runId>] [--follow] [--src <run:…|hint:N|tmp:…>] [--list-sources]
# ui [--port N] [--open]　本地只读 Web 管理台（默认固定 127.0.0.1:8199 + 一次性令牌；--open 自动打开带令牌 URL，失败仅打印；URL 含令牌勿转发，Ctrl+C 退出）
# 内部入口（Agent 用）：detect --root <dir>（只读候选）| start-new --desc <file> [--ack-unresolved <runId>] | record-unmanaged --desc <file> [--log-hints p1,p2]
```

Agent 使用规程：

1. **首次启动（受管登记）**：先调用 `node "<安装目录>/scripts/manager.mjs" --json detect --root "<仓库根目录>"` 获取只读候选。detect 只扫描仓库证据，不登记、不启动、不写文件；逐项核对 `evidence` 与项目实际约定，对候选补齐/修正解释器、命令、入口、端口等尚未确定信息。候选只是草案，不能替代第 1/1A 节发现、第 3/4 节命令匹配与启动前检查；输出空数组时按原规程手工调查，不编造。确认候选适用于目标后，把经用户确认的启动描述写入临时 JSON 文件并调用 `start-new`。描述字段：`alias`（全局唯一别名，Windows 不区分大小写）、`root`/`cwd`（绝对路径）、`entry`（同仓库多应用时的入口标识，默认 `default`）、`mode`（`jrebel`|`java`|`python`|`node`|`proc`），受管形态二选一——**直连** `exe`+`args`，或**命令模式** `command`+`expectedImage`：
   - `exe`：**必须解析为真实可执行进程**。Java 为真实 JDK bin 的 `java.exe`（裸名 `java` 先取 `JAVA_HOME` 再查 PATH，Oracle javapath 转发 shim 会被拒绝——shim 让真实 JVM 变成子进程导致日志句柄不落地、终止错位）；Python 为 venv/真实 `python.exe`；Node 为 `node.exe`+入口 js。`.cmd`/`.bat`/`.ps1` 包装与 WindowsApps 0 字节 stub 一律拒绝。
   - `command`：完整命令行字符串（`npm run dev`、`mvn spring-boot:run`、`.cmd`/`.ps1` 脚本、复合命令），manager 经 `cmd /d /s /c` 拉起 wrapper 后按 PPID 后代发现目标；`expectedImage` 为目标进程映像基名（`node.exe`/`java.exe`/`dotnet.exe` 等）；可选 `discoverTimeoutMs`（默认 45000，慢启动可调大至 120000）。后代唯一匹配 → 托管；多候选 → `DISCOVERY_AMBIGUOUS` 拒绝并列清单（此时收编命令或转非受管）；wrapper 已退无目标 → `SPAWN_FAILED`；超时 → `DISCOVERY_TIMEOUT` 留证 UNKNOWN。命令模式 wrapper 不 detach，交互终端启动时应用随控制台生命周期；**不接受 args**（参数写进 command 本身）。
   - `args`（仅直连，字符串数组：Java 为 `-cp`/`-jar`+主类/参数含 JRebel agent 参数；Python/Node 为脚本/模块与参数）、`envRefs`（仅环境变量**名称**数组，值不落注册表；manager 启动子进程时把当前环境整体传入，`envRefs` 仅作已解析名称的证据记录——需要注入非敏感字面值时在调用 `start-new` 的进程环境里设置同名变量）、`expectedPort`。manager 按“持久化意图 → 启动 → 同句柄身份采集/后代发现 → 登记”原子执行；`start-new` 成功仅代表进程存活（`readinessUntested=true`），就绪与热加载仍按第 5 节用真实证据判定。
2. **非受管启动**：连命令模式都无法安全定位唯一目标进程（多服务编排触发 `DISCOVERY_AMBIGUOUS`、远端拉起、容器等）时，不伪造托管：向用户说明能力限制后按原授权执行脚本，再用 `record-unmanaged` 记录尝试与日志线索（`--log-hints` 传脚本输出的日志路径，只关联不迁移；非 Java 项目脚本日志按第 4 节放到 `.tmp/runner-local-*`）。用户明确要求“可自动托管”而当前方式做不到时，先报 `UNSUPPORTED_LAUNCH`，不偷偷降级。
3. **再次启动/跨目录**：已登记应用直接 `start <别名>` 复用保存的配置；返回 `CONFIG_INVALID` 说明路径或产物失效，只重新分析**该目标项目**，不全盘扫描。
4. **停止/重启**：仅受管实例可用。语义是**有界强制终止**（Windows 同句柄核验后 TerminateProcess，退出码 137，不杀进程树、无优雅关机），执行前向用户说明；`restart` 先确认旧实例退出才起新实例。UNKNOWN/身份不明/外部进程一律拒绝并保留证据，不自动重试。
4.1 **未结记录与恢复（AC04，不得删账后再起）**：`current` 存在且 `phase` 为 `STARTING`（启动中断/pid 未采集）、`UNKNOWN`（如 `identity_capture_failed`，进程实际可能存活），或任何无法识别的 `phase`（记录被外部改坏等）时，`start`/`start-new` **默认拒绝**，退出码 3、错误码 `UNRESOLVED_RUN`，**不产生任何新进程**（runtime/registry 文件也不被改写）；错误信息给出 `runId`、证据文件（`--home` 下 `runtime/<appId>.json`）与日志路径，以及恢复指引。此时 `status` 仍展示未结记录全量证据（pid/创建时间/映像/日志/`lastError`），文本模式还会列出 `prevRuns` 及 `archiveReason`；`logs --run <旧runId>` 仍可查；**不要删除 runtime 记录或日志来绕过**。
4.2 **显式人工核验后的恢复**：先由用户/AI 用 `status`、`logs --run <runId>` 及系统进程工具核验旧进程；确认已退出后执行 `start <别名> --ack-unresolved <runId>` 或 `start-new --desc <file> --ack-unresolved <runId>`。仅当 `runId` 与未结记录一致时生效，否则 `ACK_MISMATCH`；manager 会二次核验：
   - 未结记录有完整身份证据（pid + 创建时间 + 映像）且进程**仍存活** → 仍然拒绝（`UNRESOLVED_RUN`），禁止第二份实例；
   - PID 存在但缺完整身份证据、无法确认是否原实例 → 拒绝；
   - 核验已退出（或 PID 已复用），或 `STARTING` 且无 pid（无可核验对象）→ 归档旧账后正常启动，`prevRuns` 条目带 `archiveReason=abandoned-by-ack` 以及原 pid/身份/日志证据，绝不静默丢弃；
   - 当前没有 `STARTING`/`UNKNOWN` 未结记录时带 `--ack-unresolved` → `ACK_MISMATCH`（避免误用过期 runId）。
   成功启动的输出会带 `abandonedRunId`/`abandonedReason`，需向用户说明“旧账已被显式放弃、证据保留在 prevRuns”。
5. **状态解读**：`RUNNING`=进程存活（不等于业务就绪）；`STOPPED` 有退出证据；`STARTING`=启动进行中；`UNKNOWN`=中断/身份不可核验/非受管记录。`STARTING`/`UNKNOWN` 的受管记录属于未结记录，重启受 4.1/4.2 约束。PID/端口仅有证据才填写；JRebel 是否验证、业务是否就绪与本状态分开表述，不互相冒充。
6. **数据与安全**：注册表/运行记录在 `~/.project-runner/`（`registry.json`、`runtime/`、`logs/`、`locks/`），不进 Git、不进业务项目；损坏或不兼容版本会以退出码 5 拒绝操作并保留原件——此时报告用户人工处置，不要删文件重建。受管日志按启动批次（runId）保存在数据目录；项目脚本自己写的 `.tmp` 日志保持原路径原样。日志入口统一为 `manager ui`（网页，含日志源与文件树）与 `manager logs`（CLI，`--src`/`--list-sources` 复用与 ui 相同的统一日志源解析）。注册表不落 Token/密码/明文命令行；日志内容可能含敏感信息，外发前按既有规则检查。
6.1 **移除登记（remove）**：应用不再需要时用 `remove <别名|appId>` 从注册表移除。仅允许无存活受管实例时移除：current 为 RUNNING 且核验存活一律拒绝（退出码 3，`INSTANCE_RUNNING`，先 `stop` 再 `remove`）；STARTING/UNKNOWN 未结记录默认拒绝（`UNRESOLVED_RUN`），人工核验已退出后用 `--ack-unresolved <runId>` 显式放弃（规则同 4.2）。remove 只删注册表条目，`runtime/<appId>.json` 与 `logs/<appId>/` 证据一律保留；成功后 `list` 不再显示该应用，`status`/`logs` 按“未登记”报 NOT_FOUND（证据文件仍在数据目录，可人工查看）。不要用删 registry.json/runtime 文件的方式“移除”。
6.2 **残留回收（prune）**：`prune [--dry-run] [--apply]` 回收三类残留——`logs/<appId>/` 超保留期历史批次日志（保留 current 与 prevRuns（≤20，PREV_RUNS_KEEP）引用的 runId，其余回收）、`locks/*.lock.stale-*` 死锁回收残留、数据目录内 `.tmp-<pid>-<hex>` 原子写孤儿临时文件。**默认 dry-run** 只打印将删内容，确认后加 `--apply` 才真正删除；绝不删 current 运行日志与 runtime/registry 证据，绝不触碰数据目录之外的文件；运行记录损坏时按 DATA_* 契约整体拒绝（退出码 5），不删任何文件。逐应用在应用锁内判定，锁忙/损坏或缺 pwsh 时跳过该应用并注明；不要在 prune 之外手工批量删 `logs/` 下的文件。
7. **本地管理台（ui，v1 只读）与默认观察入口**：**受管启动（start/start-new）成功后，用户的默认观察入口是 `manager ui`**——它全局展示所有受管应用的状态与按批次日志；**ui 实例数量与项目数无关**：启动 N 个项目不会拉起任何 Web 进程，并行多项目也共用同一个 ui 实例（读共享数据目录，天然全局视角），不要为每个项目各开一个；受管日志在数据目录；原单项目 viewer 已移除，非受管日志线索、`.tmp` 兼容日志与项目文件树都在本台查看（见第 5 节）。用户想"不开终端看一眼"或要求网页时，前台启动 `node <安装目录>/scripts/manager.mjs ui [--port N]`，把打印出的带令牌完整 URL 交给用户；**未启动 ui 时也要在汇报里告知入口**（固定地址 `http://127.0.0.1:8199` + 启动命令 + 令牌每次变化，见第 7 节交付口径），不要只在用户主动问时才说。**默认固定端口 8199**（`--port 0` 为随机端口）：重复启动会提示"已有 ui 实例占用"，此时复用该实例启动终端打印的 URL 或用 `--port` 换端口；8199 被其他程序占用时提示换端口。令牌每次启动都会变化，**固定端口不等于可收藏的固定地址**，URL 仍以启动输出为准。管理台只读展示 list、status（含未结记录证据与 prevRuns）、日志（受管批次、非受管线索、`.tmp` 兼容日志）与所选应用的项目文件，**不提供启停**；未结记录恢复与启停一律走 CLI。URL 含访问令牌，不得转发给他人或写入文件/聊天记录；用完 Ctrl+C 退出，不留常驻进程。数据损坏时管理台原样报错，处置方式同第 6 条。
8. **退出码**：0 成功；1 用法；2 未找到；3 状态冲突（已运行/别名占用/身份不明/配置失效/`UNRESOLVED_RUN`/`ACK_MISMATCH` 等）；4 环境依赖（缺 pwsh 7）；5 数据损坏。`--json` 输出单一稳定对象（`schemaVersion/ok/command/data|error`），脚本化调用优先用它。
