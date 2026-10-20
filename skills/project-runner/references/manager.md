# 跨项目运行管理参考

## 8. 跨项目管理（manager.mjs，多项目/跨会话）

定位：全局安装一次本 Skill 后，在任意业务目录用同一数据目录（默认 `~/.project-runner/`）查看与管理**由本 Skill 启动并记录**的 Java 应用。不是全机进程管理器；IDEA/手工 Maven/手工 `java -jar`/Docker 启动的进程一律不接管、不停止，只可在端口冲突诊断时查看。统一入口（路径按实际安装位置解析，无需 cd 到业务目录）：

```bash
node "<安装目录>/scripts/manager.mjs" [--home <隔离数据目录>] [--json] <命令>
# list | status <别名|appId> | start <别名|appId> [--ack-unresolved <runId>] | stop <别名|appId> | restart <别名|appId>
# logs <别名|appId> [--lines N] [--stream stdout|stderr] [--run <runId>] [--follow]
# ui [--port N]　本地只读 Web 管理台（默认固定 127.0.0.1:8199 + 一次性令牌；URL 含令牌勿转发，Ctrl+C 退出）
# 内部入口（Agent 用）：start-new --desc <file> [--ack-unresolved <runId>] | record-unmanaged --desc <file> [--log-hints p1,p2]
```

Agent 使用规程：

1. **首次启动（受管登记）**：按第 1 节完成项目识别、第 3/4 节完成命令匹配与启动前检查后，把经用户确认的启动描述写入临时 JSON 文件并调用 `start-new`。描述字段：`alias`（全局唯一别名，Windows 不区分大小写）、`root`/`cwd`（绝对路径）、`entry`（同仓库多应用时的入口标识，默认 `default`）、`mode`（`jrebel`|`java`）、`exe`（**必须指向真实 JDK bin 的 java.exe**，如 `%JAVA_HOME%\bin\java.exe`；裸名 `java` 会先取 `JAVA_HOME` 再查 PATH，解析到 Oracle javapath 转发 shim 会被拒绝——shim 会让真实 JVM 变成子进程，日志句柄不落地、终止错位）、`args`（字符串数组，直接 JVM 形态：`-cp`/`-jar` + 主类/参数，含 JRebel agent 参数）、`envRefs`（仅环境变量**名称**数组，启动时从当前环境解析，值不落注册表）、`expectedPort`。manager 按“持久化意图 → detached 启动 → 同句柄身份采集 → 登记”原子执行；`start-new` 成功仅代表进程存活（`readinessUntested=true`），就绪与热加载仍按第 5 节用真实证据判定。
2. **非受管启动**：项目只有启动脚本且无法安全定位目标 JVM（包装进程、多 JVM、远端拉起）时，不伪造托管：向用户说明能力限制后按原授权执行脚本，再用 `record-unmanaged` 记录尝试与日志线索（`--log-hints` 传脚本输出的日志路径，只关联不迁移）。用户明确要求“可自动托管”而当前方式做不到时，先报 `UNSUPPORTED_LAUNCH`，不偷偷降级。
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
6. **数据与安全**：注册表/运行记录在 `~/.project-runner/`（`registry.json`、`runtime/`、`logs/`、`locks/`），不进 Git、不进业务项目；损坏或不兼容版本会以退出码 5 拒绝操作并保留原件——此时报告用户人工处置，不要删文件重建。受管日志按启动批次（runId）保存在数据目录；项目脚本自己写的 `.tmp` 日志保持原路径原样。日志入口统一为 `manager ui`（网页，含日志源与文件树）与 `manager logs`（CLI）。注册表不落 Token/密码/明文命令行；日志内容可能含敏感信息，外发前按既有规则检查。
7. **本地管理台（ui，v1 只读）与默认观察入口**：**受管启动（start/start-new）成功后，用户的默认观察入口是 `manager ui`**——它全局展示所有受管应用的状态与按批次日志；**ui 实例数量与项目数无关**：启动 N 个项目不会拉起任何 Web 进程，并行多项目也共用同一个 ui 实例（读共享数据目录，天然全局视角），不要为每个项目各开一个；受管日志在数据目录；原单项目 viewer 已移除，非受管日志线索、`.tmp` 兼容日志与项目文件树都在本台查看（见第 5 节）。用户想"不开终端看一眼"或要求网页时，前台启动 `node <安装目录>/scripts/manager.mjs ui [--port N]`，把打印出的带令牌完整 URL 交给用户；**未启动 ui 时也要在汇报里告知入口**（固定地址 `http://127.0.0.1:8199` + 启动命令 + 令牌每次变化，见第 7 节交付口径），不要只在用户主动问时才说。**默认固定端口 8199**（`--port 0` 为随机端口）：重复启动会提示"已有 ui 实例占用"，此时复用该实例启动终端打印的 URL 或用 `--port` 换端口；8199 被其他程序占用时提示换端口。令牌每次启动都会变化，**固定端口不等于可收藏的固定地址**，URL 仍以启动输出为准。管理台只读展示 list、status（含未结记录证据与 prevRuns）、日志（受管批次、非受管线索、`.tmp` 兼容日志）与所选应用的项目文件，**不提供启停**；未结记录恢复与启停一律走 CLI。URL 含访问令牌，不得转发给他人或写入文件/聊天记录；用完 Ctrl+C 退出，不留常驻进程。数据损坏时管理台原样报错，处置方式同第 6 条。
8. **退出码**：0 成功；1 用法；2 未找到；3 状态冲突（已运行/别名占用/身份不明/配置失效/`UNRESOLVED_RUN`/`ACK_MISMATCH` 等）；4 环境依赖（缺 pwsh 7）；5 数据损坏。`--json` 输出单一稳定对象（`schemaVersion/ok/command/data|error`），脚本化调用优先用它。
