# AC03 分层验证证据（受管 JVM 跨会话存活）

> 关联 issue：#6（验证 AC03）、#17（补验 L3）
> 验证时间：2026-10-18T23:39Z – 2026-10-18T23:57Z（UTC；本机 UTC+8，即 2026-10-19 07:39–07:57）
> L3 补验时间：2026-10-20T09:40Z – 09:42Z（UTC；本机 17:40–17:42），见 §4.5，结果：**通过**
> 验证对象：`skills/project-runner/scripts/manager.mjs`（本次未修改其行为）
> 环境：Windows 11 家庭版 中文版 build 26300（64-bit）· Node v22.22.0 · PowerShell 7.6.7 · JDK 1.8.0_201（`C:\Program Files\Java\jdk1.8.0_201\bin\java.exe`，真实 JDK，非 javapath shim）
> 隔离数据目录：worktree 内 `_ac03_tmp/home-*`（绝对路径，通过 `--home` 传入；测试产物不入库，验证后已删除）

## 0. 结论摘要

| 层级 | 结论 | 依据 |
| --- | --- | --- |
| **L1 父子脱离** | **通过** | `start-new` 的 manager 进程（pid=23756）退出后，受管 JVM（pid=25220）仍被 `Get-Process` 查到，跨 30s 复查仍在；另有一次 ~5 分钟持续存活观测。 |
| **L2 新会话核验** | **通过** | manager 已退出的情况下，用多个**全新 node/pwsh 进程**分别执行 `status`（RUNNING + 创建时间/映像核验 `{"result":"ok"}`）、`logs`（读到该批次自身输出并可与原始文件逐行对照）、`stop`（进程消失、复检为 STOPPED）、`start`（新 runId 新 PID 起实例）。 |
| **L3 真实 pi/Agent 会话退出后存活** | **通过** | 真实嵌套 pi 会话（`pi --print`，真实模型+工具调用）内受管启动探针 JVM（runId=rmvghsoag-2e3f7277，pid=32908），会话正常退出后由会话外全新进程实测：进程存活（Get-Process）、`status=RUNNING` 且 runId/创建时间/映像一致、心跳日志跨退出时刻连续可读、`stop` 生效且状态如实转 STOPPED（§4.5 判据 a–d 全过，2026-10-20）。 |

> 按 issue 要求：**未经验证 L3 不得宣称 AC03 全量通过**。`docs/design.md` 状态行已按此分层如实回写；L3 已于 2026-10-20 补验通过（§4.5），AC03 现为全量通过。

## 1. 验证方法

- 全程使用隔离 `--home <worktree 内绝对路径>`，不触碰真实 `~/.project-runner/`。
- 受管目标为临时最小 Java 长活进程 `Ac03Probe`（每秒输出一行带 PID 与 `Instant` 的心跳，便于对照日志时间线），源码与 `.class` 均为一次性验证产物，验证后随临时目录删除。
- 每层使用**独立的进程**发起（新 node 进程 / 新 pwsh 进程），以证明证据不依赖发起启动的那个 manager 进程。
- 采集脚本一次性顺序执行，输出逐条带 UTC 时间戳（见 §3 原始记录）。

## 2. L1 父子脱离

受管启动结果（`start-new`，2026-10-18T23:46:23Z）：

```text
runId=rmveh56ys-e100d11f  pid=25220  status=RUNNING  managed=true
creationFileTime=134368407847812882
image=C:\Program Files\Java\jdk1.8.0_201\bin\java.exe
appId=a6a89115384e2453
```

manager 进程随即退出；随后核验：

```text
### L1-a: Get-Process -Id 25220        (2026-10-18T23:46:26Z)
Id          : 25220
ProcessName : java
StartTime   : 2026/10/19 7:46:24
Path        : C:\Program Files\Java\jdk1.8.0_201\bin\java.exe

### L1-b: CIM 父进程/创建时间          (2026-10-18T23:46:26Z)
ProcessId       : 25220
ParentProcessId : 23756
CreationDate    : 2026/10/19 7:46:24
ExecutablePath  : C:\Program Files\Java\jdk1.8.0_201\bin\java.exe
CommandLine     : "C:\Program Files\Java\jdk1.8.0_201\bin\java.exe" -Xms8m -Xmx32m ... -cp . Ac03Probe

### L1-c: 父进程（即发起启动的 manager）状态   (2026-10-18T23:46:27Z)
PARENT pid=23756 NOT RUNNING -> manager 已退出，JVM 成为孤儿但存活

### L1-d: 是否仍有承载该 home 的 node manager    (2026-10-18T23:46:27Z)
（空表示没有 manager 在跑）

### L1-e: 30 秒后复查同一 PID                    (2026-10-18T23:46:58Z)
Id          : 25220
ProcessName : java
StartTime   : 2026/10/19 7:46:24
checked at 2026-10-18T23:46:58.5681593Z
```

补充长时观测（另一轮隔离 home `_ac03_tmp/home-soak`，pid=28388，2026-10-18T23:52:26Z 启动）：

```text
2026-10-18T23:52:42Z  Id=28388 java StartTime=2026/10/19 7:52:26   parent pid=23628 alive=False
2026-10-18T23:53:12Z  Id=28388 ... n=46/47 心跳，parent pid=23628 NOT RUNNING
2026-10-18T23:54:18Z  Id=28388 ... status=RUNNING run=rmvehcy64-4f1c785d startedAt=2026-10-18T23:52:26.624Z
2026-10-18T23:56:32Z  Id=28388 ... ElapsedMin=4.1   n=244/245 心跳
2026-10-18T23:57:12Z  Id=28388 ... ElapsedMin=4.8   status=RUNNING  n=285 心跳
```

**判读**：L1 通过在「发起启动的 manager 进程已不存在」的前提下连续取得同一 PID 的存活证据，且跨 30 秒与 ~5 分钟两次复查一致。启动辅助进程未成为长子存活依赖。

## 3. L2 全新会话核验 / 日志 / 控制

以下每条均由与启动无关的新进程发起（`[caller] node pid=...` 行用于标明调用者身份）。

### 3.1 `status`（RUNNING + 身份核验）

```text
### L2-a  (2026-10-18T23:46:58Z)
[caller] node pid=19276 at=2026-10-18T23:46:58.959Z
{
  "ok": true, "command": "status",
  "data": {
    "alias": "ac03probe", "appId": "a6a89115384e2453",
    "status": "RUNNING", "managed": true, "pid": 25220,
    "run": { "runId": "rmveh56ys-e100d11f", "phase": "RUNNING",
             "startedAt": "2026-10-18T23:46:24.781Z", "endedAt": null },
    "readinessUntested": true
  }
}
```

两次独立的同句柄身份核验（创建时间 + 映像，各为独立 pwsh 进程）：

```text
### L2-a'  (2026-10-18T23:46:59Z)
$ pwsh -File .../ps/proc.ps1 -Action verify -Id 25220 -CreationFileTime 134368407847812882 -Image "...\jdk1.8.0_201\bin\java.exe"
{"result":"ok"}
### L2-a'' (2026-10-18T23:47:00Z)
{"result":"ok"}
```

### 3.2 `logs`（可读本批次日志）

```text
### L2-b  logs --lines 3        (2026-10-18T23:47:01Z)
"lines": [
  "AC03_PROBE_TICK n=17 pid=25220 at=2026-10-18T23:46:57.068Z epochMs=1792367217068",
  "AC03_PROBE_TICK n=18 pid=25220 at=2026-10-18T23:46:59.074Z epochMs=1792367219074",
  "AC03_PROBE_TICK n=19 pid=25220 at=2026-10-18T23:47:01.081Z epochMs=1792367221081"
], "runId": "rmveh56ys-e100d11f", "stream": "stdout"

### L2-b'  logs --stream stderr (2026-10-18T23:47:01Z)
"lines": []            # 该探针未向 stderr 写入，空属预期

### L2-b''  logs --run rmveh56ys-e100d11f --lines 2  (2026-10-18T23:47:02Z)
"lines": [
  "AC03_PROBE_TICK n=18 pid=25220 at=2026-10-18T23:46:59.074Z epochMs=1792367219074",
  "AC03_PROBE_TICK n=19 pid=25220 at=2026-10-18T23:47:01.081Z epochMs=1792367221081"
]

### L2-b'''  直接读原始日志文件末尾（对照）        (2026-10-18T23:47:02Z)
AC03_PROBE_TICK n=18 pid=25220 at=2026-10-18T23:46:59.074Z epochMs=1792367219074
AC03_PROBE_TICK n=19 pid=25220 at=2026-10-18T23:47:01.081Z epochMs=1792367221081
```

`logs` 输出与原始文件逐行一致，证明读的是该受管批次自身落地的文件，而非重新拼装或猜测路径。

### 3.3 `stop`（可控制）

```text
### L2-c  (2026-10-18T23:47:02Z)
[caller] node pid=15440 at=2026-10-18T23:47:02.996Z
{ "ok": true, "command": "stop",
  "data": { "result": "stopped", "runId": "rmveh56ys-e100d11f", "pid": 25220 } }

### L2-c' (2026-10-18T23:47:04Z)
PID 25220 GONE -> stop 生效
```

停止后由第三个新进程复查状态，确认不谎报 RUNNING：

```text
### L2-d  (2026-10-18T23:47:04Z)
"status": "STOPPED", "pid": null,
"run": { "phase": "STOPPED", "endedAt": "2026-10-18T23:47:04.067Z",
         "exitNote": "terminated(137) 有界强制停止；不保证优雅关机" },
"readinessUntested": false
```

### 3.4 跨会话再次启动（控制闭环）

```text
### L2-e  start（复用已保存配置）    (2026-10-18T23:47:05Z)
"source": "saved-config", "runId": "rmveh62jx-f17e01a9", "pid": 12912, "status": "RUNNING"

### L2-f  第二次实例存活，且其 manager 已退出   (2026-10-18T23:47:06Z)
Id          : 12912
ProcessName : java
StartTime   : 2026/10/19 7:47:05
PARENT pid=2492 NOT RUNNING

### L2-g  清理：stop 第二个实例      (2026-10-18T23:47:07Z)
{ "ok": true, "data": { "result": "stopped", "runId": "rmveh62jx-f17e01a9", "pid": 12912 } }

### L2-h  清理确认                  (2026-10-18T23:47:08Z)
no Ac03Probe process left
```

**判读**：`status` / `logs` / `stop` / `start` 全部由「manager 已退出后的全新进程」完成，覆盖核验、查看日志、控制三类能力，且停止后状态如实转 STOPPED。

## 4. L3 真实 pi/Agent 会话退出后存活（2026-10-20 已补验，通过）

> 本节 §4.1–§4.4 为 2026-10-19 首次验证时留下的方法与旁证记录；§4.5 为按该计划执行的补验结果。

### 4.1 为何本次无法完成

本次任务本身就是一次 pi/Agent run。受管 JVM 的存活需要在**该 run 结束之后**由 run 外的进程观测；run 内的任何自证都只是 L1/L2 的重复，不能替代 L3。

### 4.2 旁证（仅说明风险，不作为通过依据）

本次运行中可观测到运行器自身的 Job Object 语义：

```text
[2026-10-18T23:54:19Z] runnerJob LimitFlags=0x800 [BREAKAWAY_OK]
  job member pids (1): <当前 pwsh>
  CHECK managed pid=28388: inRunnerJob=False
  CHECK managed pid=28388: IsProcessInJob(any job)=yes
  VERDICT: runner job has NO KILL_ON_JOB_CLOSE -> closing the runner job will not terminate its members
```

即：当前 shell 会话所在 Job **未**设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，且受管 JVM 不是该 Job 成员。

> **必须诚实记录的缺口**：受管 JVM 虽然不在 shell 所在 Job，但 `IsProcessInJob(any job)=yes` 表明它仍归属于**另一个未识别的 Job**（很可能是宿主/沙箱为整个 run 创建的 Job）。本次未能取得该 Job 的 `LimitFlags`，因此**无法排除**它在 run 结束时被连带回收；这正是 L3 必须由 run 外进程实测的原因。

> 诚实记录一项限制：为构造「最坏情形」而自行创建 `KILL_ON_JOB_CLOSE` Job 并 `AssignProcessToJobObject` 的补充实验，在本机沙箱/权限条件下未能稳定复现 Job 成员继承（自建 Job 的成员列表始终只含持有者本身），因此该方向的结论**不可采信**，未用于本文件的任何判读。真正有效的核对手段是 run 结束后的进程观测（§4.3）。

### 4.3 补验方法（由宿主/后续会话执行）

前提：本次验证使用的隔离 home 与探针进程会在清理时删除；补验应在真实或新的隔离 home 上重跑一次受管启动，然后**让发起启动的那个 Agent 会话正常结束**。

1. 会话 A（Agent）内启动受管应用，记录输出中的 `runId`、`pid` 与 `--home` 路径：

   ```powershell
   node <skill>\scripts\manager.mjs --home <ABS_HOME> --json start-new --desc <desc.json>
   ```

2. 结束会话 A（关闭/退出该 pi 会话）。

3. 在**会话 A 之外的任意新 shell / 新 Agent 会话**执行并保存输出：

   ```powershell
   # (a) 进程仍在（判据 1）
   Get-Process -Id <pid> | Select-Object Id,ProcessName,StartTime
   # (b) 记录与身份一致（判据 2）
   node <skill>\scripts\manager.mjs --home <ABS_HOME> --json status <alias>
   # (c) 可读日志（判据 3）
   node <skill>\scripts\manager.mjs --home <ABS_HOME> --json logs <alias> --lines 5
   # (d) 可控制（判据 4）
   node <skill>\scripts\manager.mjs --home <ABS_HOME> --json stop <alias>
   ```

4. 判读：
   - (a) 能查到该 PID → 会话结束后受管 JVM **存活**；
   - (b) `status=RUNNING` 且 `managed=true`，`run.runId` 与会话 A 记录一致 → 身份核验通过；
   - (c) 能读到会话 A 期间产生的日志行 → 日志可跨会话访问；
   - (d) `result=stopped` 且随后 `Get-Process` 查不到该 PID → 可跨会话控制。

   四条全部满足 = **AC03 L3 通过**。

5. 若 (a) 失败（进程已消失），保留 `status` 输出（`phase=STOPPED`/退出说明）与会话结束时间作为失败现场，结论写「该运行器不具备 AC03 能力」，并按 `docs/design.md` §5 在实际目标运行器上阻塞 Managed 启动，不得宣称兼容。

### 4.4 责任人与时机

- 执行人：宿主调度器（run 结束后）或用户指定的后续 pi/Agent 会话。
- 时机：本 PR 合并前后均可，但不得在补验前把 `docs/design.md` 的 AC03 结论改为「全量通过」。

### 4.5 补验结果（2026-10-20 执行，L3 通过）

**执行方式（与 §4.3 计划的对应关系）**：本次补验由一次性编码执行器 run（agent-control 调度，下称「调度 run」）完成。调度 run 自身无法观察自己 run 结束后的状态（与 §4.1 同理），因此把「会话 A」落实为**一个真实嵌套的 pi 会话**：由调度 run 以 `pi --print --no-session --tools bash` 启动——print 模式一次性运行，具备真实模型（deepseek-v4.1-flash，经 new-api 网关）、真实 bash 工具调用与正常退出，是一条真实的 pi run。会话 A 的唯一动作：执行 `start-new` 受管启动探针 JVM，把启动结果原样写入 `sessionA-record.json`，随后不做任何清理、正常结束（真实 run 退出）。核验在**会话 A 之外**完成（§4.3 第 3 步）：由调度 run 会话发起，每条命令均为全新 node/pwsh 进程。

**环境与隔离**：

- 隔离 home：worktree 内 `_ac03_l3_tmp/home-l3`（绝对路径经 `--home` 传入；探针源码/`.class`、描述 JSON、各时间线文件均在 `_ac03_l3_tmp/`，验证后整体删除不入库）。
- 探针：同 §1 的 `Ac03Probe`（真实 JDK 1.8.0_201 `java.exe`，`-Xms8m -Xmx32m`，每 2s 一行心跳）。
- 本机环境注意：`pwsh` 解析到 WindowsApps 应用别名时 Node `spawnSync` 得 `EPERM`，属本机 shell 环境限制（与被测行为无关）；实验统一在 PATH 前置 `C:\Program Files\PowerShell\7` 后执行。`manager.mjs`/`proc.ps1` 行为未改动。

**时间线（UTC）**：

```text
09:40:03  调度 run 启动会话 A（pi --print --no-session --tools bash）
09:40:05  会话 A 的 pi node 进程 pid=30084
09:40:11  会话 A 内 manager start-new 返回（写入 sessionA-record.json）：
          runId=rmvghsoag-2e3f7277  pid=32908  appId=a063b6087f367c5f
          status=RUNNING  managed=true  image=...jdk1.8.0_201\bin\java.exe
09:40:12  会话 A 进程树快照：pi(30084) → bash(33332) → bash(2368) → node(33556, manager)
          → pwsh(32172, proc.ps1 身份采集)；受管 JVM 同秒创建（CIM CreationDate=09:40:12Z）
09:40:22  会话 A 正常退出（exitCode=0）；复查 pi node 30084 已消失 —— run 真实结束
09:41:45  run 外观测：pid=32908 仍存活（java），其父（manager node 33556）与会话 A 均已不存在
09:42:14  §4.3 判据 (a)–(d) 逐项实测开始（每条均为全新进程发起）
09:42:19  实测结束：(a)–(d) 全部满足；stop 后复査 status=STOPPED
```

**判据逐项（§4.3 第 3、4 步）**：

- **(a) 存活**：`Get-Process -Id 32908` → `java`，`StartTime=2026-10-20 17:40:12`（UTC+8），`Path=C:\Program Files\Java\jdk1.8.0_201\bin\java.exe`。会话 A 退出约 2 分钟后仍存活。
- **(b) 身份核验**：`status --json`（全新 node 进程）→ `status=RUNNING, managed=true`，`run.runId=rmvghsoag-2e3f7277` 与会话 A 记录一致，`creationFileTime=134369628126685988`、`image=...jdk1.8.0_201\bin\java.exe`。
- **(c) 日志**：`logs --lines 5`（全新 node 进程）读到本批次心跳 n=58–62（09:42:07–15Z），与原始日志文件末尾逐行一致；且心跳**跨会话 A 退出时刻连续无中断**：n=5@09:40:20.99Z →（A 于 09:40:22Z 退出）→ n=6@09:40:22.99Z → n=7@09:40:25.00Z → … → n=63@09:42:17.49Z（stop 前最后一跳）。证明读到的是会话 A 期间启动的那个批次自身持续落盘的日志，而非重新拼装。
- **(d) 控制**：`stop --json`（全新 node 进程）→ `{result:"stopped", runId:"rmvghsoag-2e3f7277", pid:32908}`；随后 `Get-Process` 查不到 32908（stop 生效）；再查 `status` 如实转 `STOPPED`（`exitNote=terminated(137) 有界强制停止；不保证优雅关机`），未谎报 RUNNING。

四条全部满足 → **AC03 L3 通过**。结论：该运行器（Windows 11 + Node 22 + pi CLI print 会话）具备 AC03 能力，Managed 启动路径无需按 §5 阻塞。

**Job Object 补充观测（非通过依据，与 §4.2 旁证合并判读）**：

- 受管 JVM `IsProcessInJob(any job)=yes`（仍在某个 Job 中）。用系统句柄表枚举（`NtQuerySystemInformation(SystemExtendedHandleInformation)` + `DuplicateHandle` + `QueryInformationJobObject`）取得全部 115 个可复制 Job 句柄：均**不包含**该 JVM（`IsProcessInJob(jvm, dup)=false`），且这些 Job 的 `LimitFlags=0x0`（无 `KILL_ON_JOB_CLOSE`）。
- 包含该 JVM 的 Job 属主为受保护进程（System/services/svchost 及 3 个无法以 `PROCESS_DUP_HANDLE` 打开的 node 进程，共 167 个属主无法复制句柄），其 `LimitFlags` 仍不可读 —— 与 2026-10-19 §4.2 的旁证限制一致。另注：本机 build 26300 内核将句柄表条目的对象指针隐藏为 0，无法按内核对象去重，故按逐句柄观测聚合。
- 因此「run 结束是否被 Job 连带回收」的最终判据依然是 run 结束后的进程实测；本次实测存活且可控，未发生连带回收。

**诚实记录的边界（不改变结论，但如实说明）**：

1. 会话 A 是真实 pi 会话，但由调度 run 嵌套启动（子进程）。若宿主为整个调度 run 再包一层 `KILL_ON_JOB_CLOSE` 的 Job，该层未被本实验直接检验。可复核的客观事实是：(i) 全部可读 Job 均无 `KILL_ON_JOB_CLOSE`；(ii) 2026-10-19 旁证中运行器 shell 所在 Job `LimitFlags=0x800`（仅 `BREAKAWAY_OK`）；(iii) 本次受管 JVM 在发起会话正常退出后存活并可控。三者共同表明各已知 Job 层均不连带回收后代；若宿主更换运行器或调度层，应按 §4.3 同一判据重验后再宣称 AC03 兼容。
2. 会话 A 有两次失败尝试（desc JSON 转义笔误 → `USAGE`；pwsh 应用别名 `EPERM` → `PWSH_MISSING`），均发生在 `start-new` 真正执行之前，未产生任何受管进程、注册表或运行记录；第三次成功。失败输出保留在时间线文件中，随临时目录一并删除。

## 5. 清理记录

- 2026-10-18/19（L1/L2）：所有受管实例均通过 `manager.mjs --json stop` 停止；清理后 `Get-CimInstance Win32_Process | ? CommandLine -like '*Ac03Probe*'` 返回 `no Ac03Probe process left`。
- 验证脚本、探针源码/`.class`、各隔离 `home-*` 数据目录、临时描述 JSON 全部位于 worktree 内 `_ac03_tmp/`（L3 为 `_ac03_l3_tmp/`），验证完成后整体删除，不入库。
- JVM 因本机内存压力产生过若干 `hs_err_pid*.log`（探针以 `-Xmx32m` 等小参数运行后不再出现），已一并删除。
- 未改动 `manager.mjs` 行为；`node --check skills/project-runner/scripts/manager.mjs` 通过。
