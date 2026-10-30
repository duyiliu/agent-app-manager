# Java / Spring Boot / JRebel 启动参考

本文件承接 `SKILL.md` 第 1 节 Java 分派。执行前遵守 `SKILL.md` 第 0 节意图分流、第 1 节通用证据规则、第 2 节歧义报告、第 3 节构建授权与第 4 节启动前检查。JRebel 安装、许可与初始化见 [JRebel 初始化与授权参考](jrebel-setup.md)。

## 1. Java 项目发现清单

按以下顺序收集证据；每项标注来源：`[项目]` 仓库事实、`[环境]` 本机事实、`[比对]` 两侧对齐，不一致时报告而非择一冒充。

1. **[项目] 已有启动入口**：检查 `scripts/`、`bin/` 和仓库说明中的 `start-local-jrebel*.ps1`、shell 脚本、Maven/Gradle 启动任务。若项目已有专用脚本，先读其内容并核对它与 AGENTS.md 一致；它是项目参数的权威入口，优先复用，不复制参数重新拼一份。脚本若会杀进程、改配置、执行远端操作或有其他未授权副作用，不要运行，先解释并停下。
2. **[比对] 构建系统与运行形态**：检查 `pom.xml`、Maven wrapper、`build.gradle`/`build.gradle.kts`、Gradle wrapper、Spring Boot 插件、打包配置，这些是项目事实；`target/classes`/`build/classes`/JAR 是否存在、是否落后于源码则是本机事实。识别单模块或多模块、`-cp` 启动或 `-jar` 启动；多模块时纳入目标应用实际依赖的模块，不要把整个仓库目录盲目塞入 classpath。
3. **[项目] 应用入口**：搜索本仓库源码内的 `@SpringBootApplication`、`@SpringBootConfiguration`、`public static void main` 或 Kotlin `fun main`，再对照构建插件、启动脚本、manifest、已有启动日志确认。唯一候选可自动采用；多个候选时结合模块/配置作判断，仍无法唯一确定则报告候选并停止，不任意选主类。
4. **[比对] JDK**：先从仓库约定、Maven/Gradle toolchain、`maven.compiler.release`/`java.version`、`.java-version`/`.sdkmanrc` 取得项目要求；再检查 `JAVA_HOME`、PATH 与启动脚本实际选用的 `java` 得到本机事实。两者不一致或无法确认时报告，不硬编码本机 java.exe 路径，也不改环境来掩盖不匹配。
5. **[比对] 端口与 profile**：检查 `application*.yml`/`.properties`、环境变量示例、启动参数、容器配置和脚本，取得声明值；实际监听端口只能在启动前探测。若端口由 Nacos、环境变量、远程配置或启动参数决定且本地值无法确认，列出不确定项，不把默认端口冒充为有效端口。
6. **[比对] JRebel 监控目录**：仅当项目证据表明已配置 JRebel（既有启动脚本引用 `-agentpath`/`-javaagent` rebel、仓库内已有 `rebel.xml`、构建文件含 JRebel 插件配置）或用户明确要求 JRebel 时，候选方案才包含它，本项才有检查对象；否则跳过，`mode: java` 即可，不为此补齐环境。命令行启动需要运行 classpath 上存在有效 `rebel.xml`：检查文件是否存在、`<dir>` 是否覆盖目标模块的类与资源目录，并核对该目录与当前构建产物目录一致；同时检查 Maven/Gradle JRebel 插件能否生成。若缺失或路径不匹配，先报告拟采用的生成方式、文件路径和改动摘要；生成插件配置或手工创建/修改项目文件前必须取得用户明确授权。授权前停在方案，不启动并声称热加载已就绪。
7. **[比对] 框架插件与 JVM 参数**：从依赖/插件配置识别 Spring Boot、DevTools、MyBatis-Plus 等；插件文件是否存在、路径是否对应当前机器则属环境事实。只在确实适用且插件文件存在时加对应参数；路径使用环境变量或已确认的本机安装位置，不照抄其他项目绝对路径。MyBatis-Plus 桥接插件缺失时默认告警并可继续 Java 类热加载；只有用户明确要求验证 mapper XML 热加载时，才将缺插件视为该项验证的阻塞。
8. **[比对] 日志和就绪标记**：日志路径、就绪消息与健康检查接口来自项目配置和脚本；当前批次日志文件是否存在、就绪探针此刻是否可达属本机事实。日志入口（`manager ui` / `manager logs`）与就绪探针都必须针对当前仓库和当前应用。

## 2. 启动方式与 JVM 参数

- 无项目脚本时，默认按 Spring Boot 插件 → 已存在且与源码相符的 fat jar → `-cp` 主类的顺序选型。该顺序只是默认偏好，项目约定、profile 要求或产物新鲜度可以推翻它，推翻时按 `SKILL.md` 第 2 节说明理由。
- 无项目脚本时，根据已确认的项目构建结果组装启动命令：Windows classpath 分隔符为 `;`，Linux 为 `:`；引用路径和 `-D` 参数；依赖从项目生成的 classpath 或已准备好的依赖目录获取。fat jar 使用 `-jar`。不要把示例中的占位主类或 classpath 当作真实配置。
- 改 Java 源码后按 `SKILL.md` 第 3 节增量编译（默认不 `clean`）；`manager start/restart` 不会编译。
- 以下 JRebel 参数仅在按本文件第 1 节第 6 项选定 `mode: jrebel` 时添加；`mode: java` 的普通启动一律不带。
- 将 `REBEL_HOME`/`JREBEL_HOME` 展开为实际绝对路径，再传给 `-agentpath`，不要把变量占位符原样传给 JVM。通常优先用平台原生 agent；只有原生 agent 不适用于目标架构时，才按官方 `agent-setup.md` 使用 `-javaagent` 两段式 bootstrap。
- `-Drebel.base` 指向用户配置目录。关闭 Spring DevTools 仅在项目确实使用 DevTools 且项目约定要求时添加。
- MyBatis-Plus 的 mapper XML 热加载可能需要独立桥接插件；按本文件第 1 节第 7 项缺插件策略处理。原生 MyBatis 不因此额外加该桥接插件。

## 3. 就绪与热加载

- `mode: jrebel` 时先确认日志出现 JRebel banner/监控目录；`mode: java` 跳过该步。再确认应用自身就绪消息（如 started 日志）或项目明确的 readiness 接口，并核对目标端口监听。端口开放或通用 health 成功只说明进程存活，不足以证明业务功能生效。
- `mode: jrebel` 下 Java 类变更查看 `Reloading class ...` 等日志；mapper XML 是否热加载取决于项目插件配置，查看 `Reloading SQL maps`。若未出现热加载日志，先检查产物同步和监控目录，不直接断言启动失败。`mode: java` 没有热加载，验证方式只能是重新编译并重启，重启前说明服务中断影响。
- JRebel 自身的许可证和 agent 错误优先从实际配置的 `REBEL_BASE` / `-Drebel.base` 下查找 `jrebel.log`；若未单独配置，Windows 默认位置通常为 `%USERPROFILE%\.jrebel\jrebel.log`，Linux/macOS 为 `~/.jrebel/jrebel.log`。

## 4. 边界与故障

1. `rebel.xml`、agent 路径、`-Drebel.*` 与 `jrebel.properties` 是 JVM 启动期配置，修改后必须重启；按 `SKILL.md` 第 1 节授权边界处理项目文件，许可配置按初始化步骤处理。
2. 对已正确纳入 JRebel 监控目录且已编译到监控输出的受支持代码变更，通常可热加载，不应无依据地重启；具体仍受 JRebel 与框架插件能力限制。类结构、框架元数据、mapper XML 等情况应按实际日志和项目配置验证，不能把“改代码永不重启”当绝对承诺。
3. 修改 resources（yml/XML/properties）时，先按项目构建命令把资源同步到 JRebel 监控的输出目录；源码目录变更本身不代表运行进程能看到新资源。远程配置或容器挂载资源另行核实。
4. MyBatis-Plus 桥接插件缺失时的默认行为按本文件第 1 节第 7 项处理：告警后可继续 Java 类热加载，XML 热加载验证则报告阻塞。
5. 运行中新增代码路径报 `_jr$$flc$N` 相关 `LambdaConversionException` 且重编译无效，可能是 JRebel lambda 缓存问题。不要反复清理或杀进程；先查日志与已知项目经验，必要时提出不带 agent、换隔离端口验证的方案，不能擅自占用新端口或停掉现有服务。
