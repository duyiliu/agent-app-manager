// Linux process probes backed by /proc: identity (boot_id + starttime), liveness
// verification, same-identity termination, descendant discovery and port diagnosis.
// No pwsh or external binaries; results use the same shape as ps/proc.ps1.
import fs from 'node:fs';
import path from 'node:path';
import { TERMINATE_WAIT_MS, COMMAND_DISCOVER_TIMEOUT_MS, EXIT, ManagerError } from './constants.mjs';

const PROC = '/proc';
const DISCOVER_SETTLE_MS = 1500;
const DISCOVER_POLL_MS = 400;

let bootIdCache = null;
export function bootId() {
  if (bootIdCache == null) {
    try { bootIdCache = fs.readFileSync(path.join(PROC, 'sys/kernel/random/boot_id'), 'utf8').trim(); }
    catch { bootIdCache = 'boot-unknown'; }
  }
  return bootIdCache;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// /proc/<pid>/stat 的 comm 可含空格与括号：先取最后一个 ')'，再按空白切分。
// fields[0]=state, fields[1]=ppid, fields[19]=starttime（第 22 字段）。
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
  const starttime = fields[19];
  if (!state || !Number.isInteger(ppid) || !starttime) {
    return { result: 'error', code: 'statParseFailed', message: `无法解析 /proc/${pid}/stat` };
  }
  if (state === 'Z' || state === 'X' || state === 'x') return { result: 'exited' };
  return { ok: true, state, ppid, starttime, comm };
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

export function terminate(pid, expected, waitMs = TERMINATE_WAIT_MS) {
  const v = verify(pid, expected);
  if (v.result !== 'ok') return v;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    if (e.code === 'ESRCH') return { result: 'notfound' };
    return { result: 'error', code: 'terminateFailed', message: e.message };
  }
  const expectedStart = String(expected.creationFileTime).split(':')[1];
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const s = readStat(pid);
    if (s.result === 'notfound' || s.result === 'exited') return { result: 'terminated' };
    if (!s.ok) return s;
    // 原实例已退出且 PID 被复用：不再触碰新进程。
    if (s.starttime !== expectedStart) return { result: 'terminated' };
    if (Date.now() >= deadline) return { result: 'terminateTimeout' };
    sleepSync(50);
  }
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
    const byParent = new Map();
    for (const [pid, s] of rows) {
      if (!byParent.has(s.ppid)) byParent.set(s.ppid, []);
      byParent.get(s.ppid).push(pid);
    }
    const found = [];
    const queue = [rootPid];
    const seen = new Set();
    while (queue.length) {
      const cur = queue.shift();
      for (const child of byParent.get(cur) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
        const s = rows.get(child);
        const image = readImage(child, s.comm);
        const base = image.startsWith('comm:') ? image.slice(5) : path.basename(image);
        if (base === expectedImage || s.comm === expectedImage) {
          found.push({ pid: child, image, comm: s.comm, creationFileTime: `${bootId()}:${s.starttime}` });
        }
      }
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

export function run(action, params = {}) {
  switch (action) {
    case 'capture': return capture(params.id);
    case 'verify': return verify(params.id, params);
    case 'terminate': return terminate(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS);
    case 'discover': return discover(params.id, params.image, params.waitMs ?? COMMAND_DISCOVER_TIMEOUT_MS);
    default: return { result: 'error', code: 'unsupportedAction' };
  }
}
