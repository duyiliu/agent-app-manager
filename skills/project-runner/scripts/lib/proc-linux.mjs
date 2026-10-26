// Linux process probes backed by /proc. Termination delegates to a pidfd helper
// so verification and signaling stay anchored to the same process instance.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TERMINATE_WAIT_MS, COMMAND_DISCOVER_TIMEOUT_MS, EXIT, ManagerError } from './constants.mjs';
import { sleepSync } from './proc.mjs';

const PROC = '/proc';
const PIDFD_TERMINATE = fileURLToPath(new URL('../linux/pidfd-terminate.py', import.meta.url));
const DISCOVER_SETTLE_MS = 1500;
const DISCOVER_POLL_MS = 400;
// 资源采样单次覆盖的进程数上限：命令模式聚合后代时仍保持有界读，不随进程树无限扩张。
export const RESOURCE_MAX_TREE_PIDS = 64;
// 已知包管理器/构建器启动器的命令行特征：同映像单链折叠时只别除命中特征的祖先
// （npm-cli/yarn/pnpm/maven/gradle wrapper，含 npm 重写进程标题后的 "npm run …" 形式）；
// 其余同映像链仍按歧义拒绝。
const LAUNCHER_CMD_RE = /npm-cli\.js|yarn\.js|pnpm(\.cjs|\.js)?|[\\/]\.pnpm[\\/]|plexus[.\-]classworlds|org\.gradle\.wrapper|gradle-launcher|GradleMain|^\s*(?:npm|npx|pnpm|yarn|bun)(?:[ /]|$)|dotnet(?:\.exe)?["']?\s+run(?:\s|$)|php(?:\.exe)?["']?\s+artisan\s+serve(?:\s|$)/i;

function readCmdline(pid) {
  try { return fs.readFileSync(`${PROC}/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); }
  catch { return ''; }
}

let bootIdCache = null;
export function bootId() {
  if (bootIdCache == null) {
    try { bootIdCache = fs.readFileSync(path.join(PROC, 'sys/kernel/random/boot_id'), 'utf8').trim(); }
    catch { bootIdCache = 'boot-unknown'; }
  }
  return bootIdCache;
}

// /proc/<pid>/stat 的 comm 可含空格与括号：先取最后一个 ')'，再按空白切分。
// fields[0]=state, fields[1]=ppid, fields[11]=utime, fields[12]=stime, fields[19]=starttime（第 22 字段）。
function readStat(pid) {
  let raw;
  try { raw = fs.readFileSync(`${PROC}/${pid}/stat`, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return { result: 'notfound' };
    return { result: 'error', code: 'openFailed', message: e.message };
  }
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < 0) return { result: 'error', code: 'statParseFailed', message: `无法解析 /proc/${pid}/stat` };
  const comm = raw.slice(open + 1, close);
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number.parseInt(fields[1], 10);
  // 去掉 pid/comm 后 fields[0] 对应 /proc/<pid>/stat 第 3 字段：utime 为第 14 字段 →
  // fields[11]，stime 为第 15 字段 → fields[12]，starttime 为第 22 字段 → fields[19]。
  const utime = Number.parseInt(fields[11], 10);
  const stime = Number.parseInt(fields[12], 10);
  const starttime = fields[19];
  if (!state || !Number.isInteger(ppid) || !Number.isInteger(utime) || !Number.isInteger(stime) || !starttime) {
    return { result: 'error', code: 'statParseFailed', message: `无法解析 /proc/${pid}/stat` };
  }
  if (state === 'Z' || state === 'X' || state === 'x') return { result: 'exited' };
  return { ok: true, state, ppid, utime, stime, starttime, comm };
}

// /proc/<pid>/exe 在权限不足（yama/hidepid）或内核线程时不可读：降级为 comm 前缀，
// verify 时按同一算法比较；记录中若为 exe 路径而当前不可读，则保守拒绝操作。
function readImage(pid, comm) {
  try {
    return fs.readlinkSync(`${PROC}/${pid}/exe`).replace(/ \(deleted\)$/, '');
  } catch {
    return `comm:${comm}`;
  }
}

function identityOf(pid) {
  const s = readStat(pid);
  if (!s.ok) return s;
  return {
    result: 'ok',
    creationFileTime: `${bootId()}:${s.starttime}`,
    image: readImage(pid, s.comm),
    comm: s.comm,
    starttime: s.starttime,
  };
}

export function capture(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { result: 'error', code: 'badArgs' };
  const id = identityOf(pid);
  if (id.result !== 'ok') return id;
  return { result: 'ok', creationFileTime: id.creationFileTime, image: id.image, comm: id.comm };
}

function verifyIdentity(expected, current) {
  const parts = String(expected.creationFileTime ?? '').split(':');
  if (parts.length !== 2) return { result: 'error', code: 'badArgs' };
  const [boot, starttime] = parts;
  if (boot !== bootId() || starttime !== current.starttime) return { result: 'mismatch', field: 'creationTime' };
  const expectedImage = String(expected.image ?? '');
  if (current.image.startsWith('comm:')) {
    if (expectedImage !== current.image) {
      return { result: 'error', code: 'imageUnreadable', message: '目标进程 exe 不可读，记录中的 image 无法核验；拒绝操作' };
    }
  } else if (expectedImage !== current.image) {
    return { result: 'mismatch', field: 'image' };
  }
  return { result: 'ok' };
}

export function verify(pid, expected) {
  if (!Number.isInteger(pid) || pid <= 0) return { result: 'error', code: 'badArgs' };
  const id = identityOf(pid);
  if (id.result !== 'ok') return id;
  const checked = verifyIdentity(expected, id);
  if (checked.result !== 'ok') return checked;
  return { result: 'ok', creationFileTime: id.creationFileTime, image: id.image };
}

// pidfd 终止原语：helper 先 pidfd_open 锚定进程实例，再核验记录身份，最后在同一
// pidfd 上发信号并等待退出——PID 复用无法进入核验→发信号这个窗口。sig 为信号名。
function pidfdTerminate(pid, expected, waitMs, sig, freeze = false) {
  let lastError = null;
  for (const python of ['python3', 'python']) {
    const r = spawnSync(python, [PIDFD_TERMINATE, String(pid), String(expected.creationFileTime), String(expected.image), String(waitMs), sig, freeze ? '1' : '0'],
      { encoding: 'utf8', timeout: Math.max(0, waitMs) + 5000, windowsHide: true, maxBuffer: 64 * 1024 });
    if (r.error?.code === 'ENOENT') continue;
    if (r.error) {
      lastError = r.error.message;
      break;
    }
    if (r.status !== 0) {
      lastError = (r.stderr || `helper exited with code ${r.status}`).trim();
      break;
    }
    try {
      const result = JSON.parse((r.stdout || '').trim());
      if (result.code === 'pidfdUnsupported') {
        lastError = result.message;
        continue;
      }
      return result;
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      lastError = `无法解析 pidfd 终止结果：${(r.stdout || '').trim()}`;
      break;
    }
  }
  throw new ManagerError('PIDFD_UNAVAILABLE',
    `安全终止 Linux 受管进程需要 Python 3.9+、pidfd_open 与 pidfd_send_signal；${lastError ?? '未找到 python3/python'}`,
    EXIT.DEPENDENCY);
}

export function terminate(pid, expected, waitMs = TERMINATE_WAIT_MS, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !expected?.creationFileTime || !expected?.image) {
    return { result: 'error', code: 'badArgs' };
  }
  return pidfdTerminate(pid, expected, waitMs, 'SIGKILL', options.freeze === true);
}

function childrenByParent(rows) {
  const byParent = new Map();
  for (const [pid, s] of rows) {
    if (!byParent.has(s.ppid)) byParent.set(s.ppid, []);
    byParent.get(s.ppid).push(pid);
  }
  return byParent;
}

function descendantsOf(rootPid, byParent) {
  const found = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    for (const child of byParent.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

// 枚举目标进程当时仍在的后代（PPID 树，含多级）：stop --tree 在终止目标前留证（#39）。
// 只向下遍历，不向上爬、不认领外部进程。返回 [{pid,image,comm}]。
export function descendants(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const rows = snapshotProcesses();
  if (rows.error) return [];
  return descendantsOf(pid, childrenByParent(rows)).map((child) => {
    const s = rows.get(child);
    return { pid: child, image: readImage(child, s.comm), comm: s.comm };
  });
}

// --grace：与 terminate 同一 pidfd 同锚定核验语义，只把信号换成 SIGTERM；
// waitMs 内确认退出 → gracefulTerminated，超时仍存活 → stillAlive，由调用方回退强杀。
export function gracefulTerminate(pid, expected, waitMs) {
  if (!Number.isInteger(pid) || pid <= 0 || !expected?.creationFileTime || !expected?.image) {
    return { result: 'error', code: 'badArgs' };
  }
  const r = pidfdTerminate(pid, expected, waitMs, 'SIGTERM');
  if (r.result === 'terminated') return { result: 'gracefulTerminated' };
  if (r.result === 'terminateTimeout') return { result: 'stillAlive' };
  return r;
}

// --tree：核验目标身份后，快照中的后代逐个复核 starttime 再 SIGKILL——快照到发信号
// 之间若发生 PID 复用，starttime 必不相同，复核不过即跳过不杀；根进程走 terminate()
// 的 pidfd 同锚定核验+终止。新拉起的后代漏网仍是已知限制，记录 killedPids 供人工核验。
export function terminateTree(pid, expected, waitMs = TERMINATE_WAIT_MS) {
  const v = verify(pid, expected);
  if (v.result !== 'ok') return v;
  const rows = snapshotProcesses();
  if (rows.error) return { result: 'error', code: 'procUnreadable', message: rows.error.message };
  const kids = descendantsOf(pid, childrenByParent(rows));
  const killedPids = [];
  for (const k of kids) {
    const s = readStat(k);
    if (!s.ok || s.starttime !== rows.get(k)?.starttime) continue;
    try { process.kill(k, 'SIGKILL'); killedPids.push(k); } catch { /* 已退出/无权限：尽力而为 */ }
  }
  const w = terminate(pid, expected, waitMs);
  return { ...w, killedPids };
}

function snapshotProcesses() {
  let names;
  try { names = fs.readdirSync(PROC); } catch (e) { return { error: e }; }
  const rows = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const s = readStat(pid);
    if (s.ok) rows.set(pid, s);
  }
  return rows;
}

export function discover(rootPid, expectedImage, waitMs = COMMAND_DISCOVER_TIMEOUT_MS) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !expectedImage) {
    return { result: 'error', code: 'badArgs' };
  }
  const deadline = Date.now() + waitMs;
  let foundAt = null;
  for (;;) {
    const rows = snapshotProcesses();
    if (rows.error) return { result: 'error', code: 'procUnreadable', message: rows.error.message };
    // 后续叶子折叠会整体替换（found = leaves），必须可重绑
    let found = [];
    // 锚点自身也参与映像匹配（与 ps/proc.ps1 同语义）：/bin/sh -c 可能 exec 成
    // 真实目标而 pid 不变，此时目标不是自己的后代，仅按后代枚举会错过。
    const root = rows.get(rootPid);
    if (root) {
      const rootImage = readImage(rootPid, root.comm);
      const rootBase = rootImage.startsWith('comm:') ? rootImage.slice(5) : path.basename(rootImage);
      if (rootBase === expectedImage || root.comm === expectedImage) {
        found.push({ pid: rootPid, image: rootImage, comm: root.comm, cmd: readCmdline(rootPid), creationFileTime: `${bootId()}:${root.starttime}` });
      }
    }
    for (const child of descendantsOf(rootPid, childrenByParent(rows))) {
      const s = rows.get(child);
      const image = readImage(child, s.comm);
      const base = image.startsWith('comm:') ? image.slice(5) : path.basename(image);
      if (base === expectedImage || s.comm === expectedImage) {
        found.push({ pid: child, image, comm: s.comm, cmd: readCmdline(child), creationFileTime: `${bootId()}:${s.starttime}` });
      }
    }
    // 已知启动器单链折叠（与 ps/proc.ps1 同规则）：只别除「是其他候选祖先且命令行命中已知
    // 启动器特征」的候选；npm/mvn 与目标同映像单链时折叠到真实目标，其余仍歧义拒绝。
    if (found.length > 1) {
      const parentOf = new Map();
      for (const [pid, s] of rows) parentOf.set(pid, s.ppid);
      const ancestors = new Set();
      for (const f of found) {
        let cur = parentOf.get(f.pid);
        while (Number.isInteger(cur) && cur > 0) {
          ancestors.add(cur);
          if (!parentOf.has(cur)) break;
          cur = parentOf.get(cur);
        }
      }
      const leaves = found.filter((f) => !(ancestors.has(f.pid) && LAUNCHER_CMD_RE.test(f.cmd ?? '')));
      if (leaves.length === 1) found = leaves;
    }
    if (found.length) {
      if (!foundAt) foundAt = Date.now();
      if (Date.now() - foundAt >= DISCOVER_SETTLE_MS) return { result: 'found', candidates: found };
    } else {
      foundAt = null;
      if (!rows.has(rootPid)) return { result: 'wrapperExited', candidates: [] };
      if (Date.now() >= deadline) return { result: 'timeout', candidates: [] };
    }
    sleepSync(DISCOVER_POLL_MS);
  }
}

// ---------- 资源用量采样（RSS / CPU） ----------
// CLK_TCK 只用于把 /proc/<pid>/stat 的 jiffies 换算成秒；缓存一次，
// getconf 不可用时回退到 Linux 常见默认值 100。
let clockTicksCache = null;
function clockTicks() {
  if (clockTicksCache == null) {
    let ticks = NaN;
    try {
      const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (!r.error && r.status === 0) ticks = Number.parseInt(String(r.stdout).trim(), 10);
    } catch { /* 回退默认值 */ }
    clockTicksCache = Number.isInteger(ticks) && ticks > 0 ? ticks : 100;
  }
  return clockTicksCache;
}

// /proc/<pid>/status 通常只有 1-2 KB；仍按上限读，避免异常 procfs 或恶意挂载点造成无界读取。
function readBoundedText(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function readResourceSample(pid) {
  const s = readStat(pid);
  if (!s.ok) return { pid, result: s.result ?? 'error', ...(s.code ? { code: s.code } : {}) };
  const text = readBoundedText(`${PROC}/${pid}/status`, 16 * 1024);
  if (text == null) return { pid, result: 'error', code: 'statusUnreadable' };
  const rssKb = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
  const hwmKb = /^VmHWM:\s+(\d+)\s+kB$/m.exec(text);
  const ticks = s.utime + s.stime;
  return {
    pid,
    result: 'ok',
    starttime: s.starttime,
    rssBytes: rssKb ? Number(rssKb[1]) * 1024 : null,
    peakRssBytes: hwmKb ? Number(hwmKb[1]) * 1024 : null,
    cpuTicks: ticks,
    cpuTimeMs: Math.round(ticks / clockTicks() * 1000),
  };
}

// 单次有界采样：先对全部目标取一次 RSS/CPU 计数，间隔 intervalMs 后再取一次 CPU 计数，
// 用两次差值计算 CPU 利用率（不引入常驻轮询）。items 形如 [{id, tree}]；
// tree=true 时按 PPID 树聚合目标后代（命令模式的真实目标可能再派生 worker）。
export function resources(items, intervalMs = 200) {
  const list = (items ?? [])
    .map((it) => ({ id: Number(it?.id), tree: !!it?.tree }))
    .filter((it) => Number.isInteger(it.id) && it.id > 0);
  if (!list.length) return { result: 'ok', intervalMs, items: [], processes: [] };
  const rows = snapshotProcesses();
  if (rows.error) return { result: 'error', code: 'procUnreadable', message: rows.error.message };
  const byParent = childrenByParent(rows);
  const itemsOut = [];
  const uniquePids = new Set();
  for (const it of list) {
    const pids = [it.id];
    let truncated = false;
    if (it.tree) {
      for (const child of descendantsOf(it.id, byParent)) {
        if (pids.length >= RESOURCE_MAX_TREE_PIDS) { truncated = true; break; }
        pids.push(child);
      }
    }
    itemsOut.push({ id: it.id, pids, ...(truncated ? { truncated: true } : {}) });
    for (const pid of pids) uniquePids.add(pid);
  }
  const interval = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 200;
  const first = new Map([...uniquePids].map((pid) => [pid, readResourceSample(pid)]));
  sleepSync(Math.max(20, interval));
  const second = new Map([...uniquePids].map((pid) => [pid, readStat(pid)]));
  const hz = clockTicks();
  const processes = [];
  for (const pid of uniquePids) {
    const a = first.get(pid);
    if (!a || a.result !== 'ok') { processes.push({ pid, result: a?.result ?? 'error', ...(a?.code ? { code: a.code } : {}) }); continue; }
    const b = second.get(pid);
    if (!b || !b.ok) { processes.push({ pid, result: b?.result ?? 'error', ...(b?.code ? { code: b.code } : {}) }); continue; }
    if (b.starttime !== a.starttime) { processes.push({ pid, result: 'error', code: 'pidReused' }); continue; }
    const deltaTicks = Math.max(0, (b.utime + b.stime) - a.cpuTicks);
    const cpuPercent = Math.round((deltaTicks / hz) / (interval / 1000) * 10000) / 100;
    processes.push({
      pid,
      result: 'ok',
      rssBytes: a.rssBytes,
      peakRssBytes: a.peakRssBytes,
      privateBytes: null,
      cpuPercent,
      cpuTimeMs: a.cpuTimeMs,
    });
  }
  return { result: 'ok', intervalMs: interval, items: itemsOut, processes };
}

function ipv4FromHex(hex) {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return hex; // IPv6 保留 hex，避免臆造格式
  const bytes = [];
  for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return bytes.join('.');
}

function parseNet(file, port) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== '0A') continue; // 0A = TCP LISTEN
    const [addrHex, portHex] = (parts[1] ?? '').split(':');
    if (!portHex || Number.parseInt(portHex, 16) !== port) continue;
    rows.push({ inode: parts[9], localAddress: ipv4FromHex(addrHex), localPort: port, source: path.basename(file) });
  }
  return rows;
}

// 非 root 只能看到同 uid 进程的 fd：定位不到时 pid=null，仅报告端口监听。
function pidBySocketInodes(inodes) {
  const found = new Map();
  if (!inodes.size) return found;
  let names;
  try { names = fs.readdirSync(PROC); } catch { return found; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let fds;
    try { fds = fs.readdirSync(`${PROC}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`${PROC}/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) found.set(m[1], pid);
    }
  }
  return found;
}

// pid→实际监听端口（#107）：先一次性解析 /proc/net/tcp{,6} 的 LISTEN 套接字 inode，
// 再按 /proc/<pid>/fd 的 socket:[inode] 定位归属。只读、只返回本地地址与端口。
function listeningSocketsByInode() {
  const byInode = new Map();
  for (const file of [`${PROC}/net/tcp`, `${PROC}/net/tcp6`]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10 || parts[3] !== '0A') continue; // 0A = TCP LISTEN
      const [addrHex, portHex] = (parts[1] ?? '').split(':');
      const localPort = Number.parseInt(portHex, 16);
      if (!Number.isInteger(localPort) || localPort < 1) continue;
      byInode.set(parts[9], { localAddress: ipv4FromHex(addrHex), localPort, source: path.basename(file) });
    }
  }
  return byInode;
}

function socketInodesForPid(pid) {
  const inodes = new Set();
  let fds;
  try { fds = fs.readdirSync(`${PROC}/${pid}/fd`); } catch { return inodes; }
  for (const fd of fds) {
    let link;
    try { link = fs.readlinkSync(`${PROC}/${pid}/fd/${fd}`); } catch { continue; }
    const m = /^socket:\[(\d+)\]$/.exec(link);
    if (m) inodes.add(m[1]);
  }
  return inodes;
}

// 批量形式供 list 一次解析监听表后按 pid 归属，避免 N 个应用重复读 /proc/net。
export function listeningPortsBatch(pids) {
  const targets = [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0))];
  if (!targets.length) return [];
  const byInode = listeningSocketsByInode();
  if (!byInode.size) return [];
  const out = [];
  for (const pid of targets) {
    const seen = new Set();
    for (const inode of socketInodesForPid(pid)) {
      const row = byInode.get(inode);
      if (!row) continue;
      const key = `${row.localAddress}:${row.localPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, localAddress: row.localAddress, localPort: row.localPort });
    }
  }
  return out;
}

export function listeningPorts(pid) {
  return listeningPortsBatch([pid]).map(({ localAddress, localPort }) => ({ localAddress, localPort }));
}

export function portOccupants(port) {
  const rows = [...parseNet(`${PROC}/net/tcp`, port), ...parseNet(`${PROC}/net/tcp6`, port)];
  if (!rows.length) return [];
  const pids = pidBySocketInodes(new Set(rows.map((r) => r.inode)));
  return rows.map((row) => {
    const pid = pids.get(row.inode) ?? null;
    const id = pid ? identityOf(pid) : null;
    const ok = id?.result === 'ok';
    return {
      pid,
      processName: ok ? id.comm : null,
      executablePath: ok && !id.image.startsWith('comm:') ? id.image : null,
      commandLine: null,
      startedAt: null,
      localAddress: row.localAddress,
      localPort: row.localPort,
      source: row.source,
      identity: ok ? { result: 'ok', creationFileTime: id.creationFileTime, image: id.image } : null,
      note: pid ? null : '无法在 /proc 中定位监听进程（权限不足或 hidepid）；仅报告端口监听',
    };
  });
}

export function selfIdentity() {
  const r = capture(process.pid);
  if (r.result !== 'ok') {
    throw new ManagerError('IDENTITY_UNAVAILABLE', `无法采集自身进程身份（/proc 不可读）：${JSON.stringify(r)}`, EXIT.DEPENDENCY);
  }
  return r;
}

// 批量核验：与 verify 同语义（boot_id:starttime + image），Linux 侧无 spawn 成本，
// 仅为与 Windows 的 verify-batch 保持同一接口。
export function verifyBatch(items) {
  return (items ?? []).map((it) => {
    try { return verify(it.id ?? it.pid, it); } catch (e) { return { result: 'error', code: 'verifyFailed', message: e.message }; }
  });
}

export function run(action, params = {}) {
  switch (action) {
    case 'verify-batch': return verifyBatch(params.items);
    case 'descendants': return descendants(params.id);
    case 'capture': return capture(params.id);
    case 'verify': return verify(params.id, params);
    case 'terminate': return terminate(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS, { freeze: params.freeze === true });
    case 'terminate-tree': return terminateTree(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS);
    case 'grace': return gracefulTerminate(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS);
    case 'discover': return discover(params.id, params.image, params.waitMs ?? COMMAND_DISCOVER_TIMEOUT_MS);
    case 'listening': return listeningPorts(params.id);
    case 'listening-batch': return listeningPortsBatch(params.ids);
    case 'resources': return resources(params.items, params.intervalMs ?? 200);
    default: return { result: 'error', code: 'unsupportedAction' };
  }
}
