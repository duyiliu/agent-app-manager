# 214 宿主机 sshd 恢复记录（22 端口 Connection refused）

- 主机：`192.168.1.214`（agent-control 宿主，`localhost.localdomain`）
- 系统：CentOS Linux 7 (Core)
- 执行时间：2026-10-22 06:49 CST（宿主机本地时间）
- 执行方式：agent-control 调度器在宿主机上以 root 执行（当时 SSH 不可用，无法人工登录）

> 说明：本机是 CentOS 7，服务名是 **`sshd`**（不是 Debian/Ubuntu 的 `ssh`）；
> `ss`、`iptables`、`sshd` 都在 `/usr/sbin`，调度器默认 `PATH` 不含该目录，因此下文
> 使用绝对路径调用。除恢复动作外未修改任何配置文件，未改动防火墙，未重启 agent-control 服务。

## 1. 诊断（原始输出）

### 1.1 服务状态

```console
# systemctl status sshd --no-pager
● sshd.service - OpenSSH server daemon
   Loaded: loaded (/usr/lib/systemd/system/sshd.service; enabled; vendor preset: enabled)
   Active: inactive (dead) since Thu 2026-10-22 06:19:56 CST; 29min ago
     Docs: man:sshd(8)
           man:sshd_config(5)
  Process: 1060 ExecStart=/usr/sbin/sshd -D $OPTIONS (code=exited, status=0/SUCCESS)
 Main PID: 1060 (code=exited, status=0/SUCCESS)

Oct 22 06:19:48 localhost.localdomain sshd[44664]: Accepted publickey for root from 192.168.1.152 port 52457 ssh2: RSA SHA256:JKFix4r9i9/jwjumsc0ecXu1T+kilkgCgNwRSjYZIQA
...

# systemctl is-enabled sshd; systemctl is-active sshd
enabled
inactive
```

关键点：unit 仍是 `enabled`，但进程已退出；退出状态是 `status=0/SUCCESS`（正常退出，
不是崩溃/OOM/被信号杀死），退出时间 06:19:56，与外部观测到 22 端口开始 refused 的时间吻合。

```console
# systemctl show sshd -p ActiveState -p SubState -p ExecMainStatus \
    -p InactiveEnterTimestamp -p ExecMainExitTimestamp
ExecMainExitTimestamp=Thu 2026-10-22 06:19:56 CST
ExecMainStatus=0
ActiveState=inactive
SubState=dead
InactiveEnterTimestamp=Thu 2026-10-22 06:19:56 CST

# systemctl list-unit-files 'ssh*' --no-pager
UNIT FILE           STATE
sshd-keygen.service static
sshd.service        enabled
sshd@.service       static
sshd.socket         disabled
```

`sshd.socket` 处于 disabled，说明本机没有 socket 激活兜底，服务一停就真的没有监听。

### 1.2 22 端口监听

```console
# /usr/sbin/ss -lntp | grep -E ':22\b' || echo "no listener on 22"
no listener on 22
```

诊断时 22 端口**没有任何监听**，这直接解释了 `Connection refused`。

### 1.3 sshd 日志

```console
# journalctl -u sshd -n 100 --no-pager
Oct 21 23:29:33 localhost.localdomain sshd[51158]: Accepted publickey for root from 192.168.1.152 port 63416 ssh2: RSA SHA256:JKFix4r9i9/jwjumsc0ecXu1T+kilkgCgNwRSjYZIQA
...
Oct 22 06:19:48 localhost.localdomain sshd[44664]: Accepted publickey for root from 192.168.1.152 port 52457 ssh2: RSA SHA256:JKFix4r9i9/jwjumsc0ecXu1T+kilkgCgNwRSjYZIQA
```

日志最后一条是 06:19:48 的正常登录成功记录，之后没有任何 `error`/`fail`/`fatal`，
也没有证书/配置错误。grep 全量日志中的 stop/start/fail/error：

```console
# journalctl -u sshd --no-pager | grep -Ei 'stop|start|fail|error' | tail -20
Oct 10 10:34:26 localhost.localdomain systemd[1]: Starting OpenSSH server daemon...
Oct 10 10:34:27 localhost.localdomain systemd[1]: Started OpenSSH server daemon.
```

（06:19 的停止由 systemd 直接完成，`sshd` 以 0 退出，journal 中无报错行。）

### 1.4 配置文件

```console
# ls -l /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
-rw-------. 1 root root 3905 Jul 22  2025 /etc/ssh/sshd_config
#（本机无 sshd_config.d 目录，CentOS 7 默认无 drop-in）

# grep -RniE '^(Port|ListenAddress|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
#（无输出：相关指令全部处于注释状态，即使用默认值）

# grep -nE '^[[:space:]]*#?[[:space:]]*(Port|ListenAddress|PermitRootLogin|PasswordAuthentication)' /etc/ssh/sshd_config
17:#Port 22
19:#ListenAddress 0.0.0.0
20:#ListenAddress ::
38:#PermitRootLogin yes
63:#PasswordAuthentication yes
65:PasswordAuthentication yes

# /usr/sbin/sshd -t
#（无输出，退出码 0 → 配置语法 OK）
```

即：端口仍是默认 22，未限制 ListenAddress，配置语法有效，**没有配置错误**。

### 1.5 防火墙

```console
# /usr/sbin/iptables -S INPUT
-P INPUT ACCEPT

# systemctl is-active firewalld; firewall-cmd --state
inactive
not running
```

iptables 仅默认策略 ACCEPT、无任何规则；firewalld 未运行；本机也没有 nft（CentOS 7 不存在）。
**不存在防火墙 REJECT**，因此 refused 只能来自「没有进程监听 22」。

## 2. 根因判断

**sshd 被停止（正常退出），且没有 socket 激活兜底，导致 22 端口无监听，外部连接得到 TCP RST（Connection refused）。**

判定依据：

1. `sshd.service` 状态为 `inactive (dead)`、`ExecMainStatus=0`、`ExecMainExitTimestamp=2026-10-22 06:19:56` —— 进程是干净退出的，不是崩溃/OOM。
2. 停止前的最后日志是正常 publickey 登录成功，之后无 error/fatal。
3. 配置有效（`sshd -t` 通过），端口为默认 22，无 ListenAddress 限制。
4. 防火墙未启用、无拦截规则，排除 REJECT。
5. 停止时刻（06:19:56）之后 22 端口即无监听，与外部观测一致。

关于「谁停的」：`status=0/SUCCESS` 说明不是自身故障退出（`sshd -D` 崩溃会是非 0/信号），
更符合**外部主动 stop**（人工或自动化动作）。本次未进一步追查操作来源；
若再次出现，建议排查是否有批量运维脚本/自动化误 stop sshd。

## 3. 执行的修复

按 issue 要求，优先使用最小动作：unit 本身仍是 `enabled`，无需改配置，直接拉起服务。

```console
# systemctl enable --now sshd
#（无输出，退出码 0）
```

- 未修改 `/etc/ssh` 下任何文件（配置本就正确）。
- 未关闭/修改防火墙（防火墙本就没开）。
- 未重启/停止 agent-control 服务，未改动 8788 相关配置。

## 4. 验证结果

```console
# systemctl is-enabled sshd; systemctl is-active sshd
enabled
active

# /usr/sbin/ss -lntp | grep ':22'
LISTEN     0      128          *:22                       *:*                   users:(("sshd",pid=52738,fd=3))
LISTEN     0      128       [::]:22                    [::]:*                   users:(("sshd",pid=52738,fd=4))

# timeout 3 bash -c '</dev/tcp/127.0.0.1/22' && echo "22 listening ok"
22 listening ok

# systemctl status sshd --no-pager
● sshd.service - OpenSSH server daemon
   Loaded: loaded (/usr/lib/systemd/system/sshd.service; enabled; vendor preset: enabled)
   Active: active (running) since Thu 2026-10-22 06:49:41 CST; 4s ago
 Main PID: 52738 (sshd)
           └─52738 /usr/sbin/sshd -D
```

同时确认调度器服务未受影响：

```console
# curl -s -o /dev/null -w 'health http=%{http_code}\n' --max-time 3 http://127.0.0.1:8788/api/health
health http=401
```

`401` 与恢复前外部观测一致，说明 agent-control 服务一直在正常运行，未被打断。

**结论：sshd 已恢复，22 端口监听正常，SSH 可重新登录。**

## 5. 结论与后续

- 本次属「无需人工到 VMware 控制台」的情形：磁盘/只读/二进制均未发现问题（配置校验通过、服务能正常拉起）。
- 修复动作只有一条 `systemctl enable --now sshd`，服务已恢复为 `enabled + active`。
- 遗留关注点：本次为**外部主动停止**导致的停机，非配置缺陷；如需彻底防止复发，应确认停止来源，或评估启用 `sshd.socket` 作为兜底（本次未改动，避免超出 issue 范围）。
