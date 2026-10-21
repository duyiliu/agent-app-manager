// Managed launch pipeline: persist intent → spawn detached log-writer →
// identity capture (direct exe) or descendant discovery (command mode) → record.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './constants.mjs';
import { runtimePath, readRuntimeStrict } from './store.mjs';
import { psProc, COMMAND_DISCOVER_TIMEOUT_MS } from './probe.mjs';
import { resolveExe, newRunId, RUN_LOG_MAX_BYTES } from './desc.mjs';
import { archiveCurrent, writeRuntime, isUnresolvedPhase } from './runtime.mjs';
import { readStderrTailSafe } from './logs.mjs';
import { conflictError } from './errors.mjs';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_WRITER = path.join(SCRIPTS_DIR, 'log-writer.mjs');

// 命令模式的顶层 wrapper：cmd.exe 是真实 exe，同样走候选校验保证不被 shim 冒充
function resolveComspec(cwd) {
  return resolveExe(process.env.ComSpec || 'cmd.exe', cwd);
}

// 目标进程终止后尽力清理仍存活的 cmd wrapper（多数会随子进程退出自然消亡）。
// wrapper 身份在启动时已采集，同句柄核验+终止，失败仅作留证不影响主结果。
export function cleanupWrapper(rt) {
  const cur = rt.current;
  if (!cur?.wrapperPid || !cur.wrapperCreationFileTime || !cur.wrapperImage) return;
  try {
    psProc('terminate', { id: cur.wrapperPid, creationFileTime: cur.wrapperCreationFileTime, image: cur.wrapperImage });
  } catch { /* best-effort */ }
}

export function launchManaged(home, appId, app, opts = {}) {
  const runId = newRunId();
  const logDir = path.join(home, 'logs', appId);
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, `${runId}.stdout.log`);
  const errPath = path.join(logDir, `${runId}.stderr.log`);
  const rt = readRuntimeStrict(home, appId) ?? { schemaVersion: SCHEMA_VERSION, appId, prevRuns: [] };
  if (opts.abandonRunId && rt.current && rt.current.runId === opts.abandonRunId
      && rt.current.managed !== false && isUnresolvedPhase(rt.current.phase)) {
    archiveCurrent(rt, { reason: 'abandoned-by-ack' }); // 显式 ack 的未结旧账：保留证据并注明原因
  } else {
    archiveCurrent(rt); // 旧运行证据归档保留，绝不删账
  }

  const isCommand = !!app.command;
  rt.current = {
    runId, phase: 'STARTING', managed: true, mode: app.mode,
    kind: isCommand ? 'command' : 'direct',
    intentAt: new Date().toISOString(), startedAt: null,
    pid: null, creationFileTime: null, image: null,
    wrapperPid: null, wrapperCreationFileTime: null, wrapperImage: null,
    envResolved: app.envRefs.filter((n) => n in process.env),
    logPaths: { stdout: outPath, stderr: errPath },
    lastError: null, endedAt: null, exitNote: null,
  };
  writeRuntime(home, appId, rt);

  const failUnresolved = (code, message, detail) => {
    writeRuntime(home, appId, rt);
    const stderrTail = readStderrTailSafe(rt.current.logPaths.stderr);
    throw conflictError(code, message, { runId, logPaths: rt.current.logPaths, ...detail, stderrTail });
  };

  let child;
  const pidFile = path.join(logDir, `.${runId}.pid`);
  let spawnError = null;
  try {
    const sinkConfig = path.join(logDir, `.${runId}.sink.json`);
    fs.writeFileSync(sinkConfig, JSON.stringify({
      file: isCommand ? resolveComspec(app.cwd) : app.exe,
      args: isCommand ? ['/d', '/s', '/c', app.command] : app.args,
      cwd: app.cwd, outPath, errPath,
      runtimeFile: runtimePath(home, appId), runId, limit: app.logMaxBytes ?? RUN_LOG_MAX_BYTES, pidFile,
    }));
    // The detached logger owns both output descriptors and launches the application
    // with pipes, allowing safe stdout rotation without touching a live app fd.
    // 命令模式：拉起 cmd wrapper 执行完整命令行；真实目标进程稍后按后代发现确定。
    // 注意 wrapper 不能 detach——Windows 下 detached(无控制台) wrapper 的后代进程
    // stdout 句柄全部失效（实测 echo/node/ping 写入丢失），必须共享父进程控制台。
    // Windows 父退出不杀子进程，wrapper/目标仍会存活；代价是交互终端启动时
    // 共享其控制台（典型 agent 管道调用下 manager 本无控制台，不受影响）。
    child = spawn(process.execPath, [LOG_WRITER, sinkConfig], {
      cwd: app.cwd, detached: !isCommand, windowsHide: true,
      // env 只在内存中合并传给 logger（不写入落盘的 sink 配置，避免把环境变量落成文件）。
      stdio: 'ignore',
      env: { ...process.env, ...(app.env ?? {}) },
    });
    // spawn 的异步 error（EACCES 等）必须有监听，否则会以未捕获事件终止 manager；
    // 具体失败仍由下方身份采集/发现路径统一落账并保留证据
    child.on('error', (err) => { spawnError = err.message; });
    child.unref();
  } catch (e) {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `spawn_failed: ${e.message}`;
    failUnresolved('SPAWN_FAILED', `进程启动失败；意图与证据已保留（runId=${runId}），拒绝自动重试`, { cause: e.message });
  } finally {
    // Logger owns log descriptors; the manager never opens active log files.
  }

  rt.current.startedAt = new Date().toISOString();
  if (isCommand) {
    rt.current.wrapperPid = child.pid;
  } else {
    rt.current.pid = child.pid;
  }

  let cap;
  if (isCommand) {
    try { cap = psProc('capture', { id: child.pid }); }
    catch (e) { cap = { result: 'error', message: e.message }; }
  }
  if (!isCommand) {
    // Capture the managed application, not the logging helper.
    let targetPid = child.pid;
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    try { targetPid = Number(fs.readFileSync(pidFile, 'utf8')) || child.pid; } catch { /* helper startup failed */ }
    rt.current.pid = targetPid;
    try { cap = psProc('capture', { id: targetPid }); } catch (e) { cap = { result: 'error', message: e.message }; }
    if (cap.result === 'ok') {
      rt.current.phase = 'RUNNING';
      rt.current.creationFileTime = cap.creationFileTime;
      rt.current.image = cap.image;
      writeRuntime(home, appId, rt);
      return rt.current;
    }
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `identity_capture_failed: ${JSON.stringify(cap)}${spawnError ? `; spawn_error: ${spawnError}` : ''}`;
    failUnresolved('IDENTITY_CAPTURE_FAILED', `已拉起（pid=${child.pid}）但身份采集失败，标记 UNKNOWN；证据保留，拒绝自动重试`, { pid: child.pid, capture: cap });
  }

  // ---- 命令模式：wrapper 身份留证，随后在后代中发现唯一真实目标 ----
  if (cap.result === 'ok') {
    rt.current.wrapperCreationFileTime = cap.creationFileTime;
    rt.current.wrapperImage = cap.image;
  }

  const waitMs = app.discoverTimeoutMs ?? COMMAND_DISCOVER_TIMEOUT_MS;
  let d;
  try {
    d = psProc('discover', { id: child.pid, image: app.expectedImage, waitMs });
  } catch (e) {
    d = { result: 'error', code: 'discover_failed', message: e.message };
  }

  if (d.result === 'found' && d.candidates.length === 1) {
    let t;
    try {
      t = psProc('capture', { id: d.candidates[0].pid });
    } catch (e) {
      t = { result: 'error', message: e.message };
    }
    if (t.result === 'ok') {
      rt.current.phase = 'RUNNING';
      rt.current.pid = d.candidates[0].pid;
      rt.current.creationFileTime = t.creationFileTime;
      rt.current.image = t.image;
      writeRuntime(home, appId, rt);
      return rt.current;
    }
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `identity_capture_failed(target=${d.candidates[0].pid}): ${JSON.stringify(t)}`;
    failUnresolved('IDENTITY_CAPTURE_FAILED', `已发现目标进程（pid=${d.candidates[0].pid}）但身份采集失败，标记 UNKNOWN；wrapper(pid=${child.pid})证据保留`, { pid: d.candidates[0].pid, wrapperPid: child.pid, capture: t });
  }

  if (d.result === 'found') {
    // 歧义即拒绝：候选清单留证，wrapper 仍在运行由人工决定处置
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `discovery_ambiguous: ${JSON.stringify(d.candidates)}`;
    failUnresolved('DISCOVERY_AMBIGUOUS', `wrapper(pid=${child.pid}) 后代中匹配 ${app.expectedImage} 的进程有 ${d.candidates.length} 个，拒绝任选一个；wrapper 仍在运行，证据已保留`, { wrapperPid: child.pid, expectedImage: app.expectedImage, candidates: d.candidates });
  }

  if (d.result === 'wrapperExited') {
    // wrapper 死了且无目标：命令大概率失败——没有存活进程，落 STOPPED 可直接重试
    rt.current.phase = 'STOPPED';
    rt.current.endedAt = new Date().toISOString();
    rt.current.exitNote = `command wrapper(pid=${child.pid}) 已退出且未发现匹配 ${app.expectedImage} 的目标进程`;
    failUnresolved('SPAWN_FAILED', `命令已退出且未发现目标进程（expectedImage=${app.expectedImage}，详见 stderr 日志）`, { wrapperPid: child.pid });
  }

  if (d.result === 'timeout') {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `discovery_timeout: ${waitMs}ms 内未发现匹配 ${app.expectedImage} 的后代（wrapper pid=${child.pid}）`;
    failUnresolved('DISCOVERY_TIMEOUT', `${waitMs}ms 内未发现匹配 ${app.expectedImage} 的后代进程；wrapper(pid=${child.pid}) 可能仍在启动中，证据保留，拒绝自动重试`, { wrapperPid: child.pid, expectedImage: app.expectedImage });
  }

  rt.current.phase = 'UNKNOWN';
  rt.current.lastError = `discovery_failed: ${JSON.stringify(d)}${spawnError ? `; spawn_error: ${spawnError}` : ''}`;
  failUnresolved('DISCOVERY_FAILED', `后代发现失败（${d.code ?? d.result}），标记 UNKNOWN；wrapper(pid=${child.pid})证据保留`, { wrapperPid: child.pid, detail: d });
}
