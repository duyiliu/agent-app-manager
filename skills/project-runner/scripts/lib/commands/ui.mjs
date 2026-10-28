// 本地只读 Web 管理台（ui，design.md §2.2 / AC08）。
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageError, conflictError } from '../errors.mjs';
import { resolveLogFile, listRuns, listSources, resolveSource, listTree, readProjectFile } from '../log-sources.mjs';
import { parseNamed } from './common.mjs';
import { cmdDoctor, portDiagnosis } from './diagnose.mjs';
import { parseGraceMsValue } from './lifecycle.mjs';

const MANAGER_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'manager.mjs');

// ---------- 本地只读 Web 管理台（ui，design.md §2.2 / AC08） ----------

// 固定端口 8199 的占用探测：区分"已有 ui 实例"与"被其他程序占用"。
// 优先 /api/meta（几十字节的版本化 JSON，#82-B4）；旧版实例无此端点时
// 回退首页特征探测。连接失败一律按"非本实例"处理。
function probeManagerUi(port) {
  const get = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
  return (async () => {
    const meta = await get('/api/meta');
    if (meta && meta.status === 200) {
      try {
        const j = JSON.parse(meta.body);
        return j?.ok === true && typeof j?.data?.version === 'string';
      } catch { return false; }
    }
    if (meta == null) return false;
    const page = await get('/');
    return Boolean(page && page.status === 200 && page.body.includes('id="roBanner"'));
  })();
}

// 生命周期操作经 manager.mjs --json 子进程执行：stdout 是同一数据契约的 JSON。
// 子进程退出码即 ManagerError exitCode（1-6），重构错误后 errorStatus 映射不变；
// 180s 超时兜底（CLI 前端 150s abort 通常先到），超时强杀子进程——中断的
// start/stop 按既有语义留下 STARTING/UNKNOWN 未结证据，不静默伪造结果。
function runLifecycleSubprocess(home, op, ref, ack, { tree = false, graceMs = null } = {}) {
  const args = [MANAGER_MJS, '--json', '--home', home, op, ref];
  if (ack) args.push('--ack-unresolved', ack);
  // 仅 stop/restart 接受 --tree/--grace（调用方已校验，这里再按 op 防守一次）。
  if (op === 'stop' || op === 'restart') {
    if (tree) args.push('--tree');
    if (graceMs != null) args.push('--grace', String(graceMs));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(Object.assign(new Error(`${op} ${ref} 子进程超时（180s）已终止；状态可能未落定，请刷新后人工核验`), { code: 'LIFECYCLE_TIMEOUT', exitCode: 4 }));
    }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`manager 子进程拉起失败：${e.message}`), { code: 'LIFECYCLE_SPAWN_FAILED', exitCode: 4 }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out); } catch { /* stdout 非 JSON：走通用错误 */ }
      // prepareLaunchEnv 在任何启动副作用前把机密 env 告警写到 stderr；
      // 成功响应已有结构化告警，失败时也把这一行（不含值）附到错误里，避免 UI 丢失。
      const envWarningLine = String(err).split(/\r?\n/).find((line) => line.startsWith('[project-runner] 警告：'))?.trim() ?? null;
      if (j?.ok === true) {
        const data = j.data ?? {};
        if (envWarningLine && !data.envWarning) {
          data.envWarning = envWarningLine.replace(/^\[project-runner\]\s*/, '');
        }
        return resolve(data);
      }
      const e2 = j?.error ?? {};
      const baseMessage = e2.message || err.trim() || `manager ${op} 异常退出（code=${code}）`;
      const message = envWarningLine && !baseMessage.includes(envWarningLine)
        ? `${baseMessage}\n${envWarningLine}`
        : baseMessage;
      const errObj = Object.assign(
        new Error(message),
        { code: e2.code ?? 'LIFECYCLE_FAILED', exitCode: Number.isInteger(code) && code >= 1 && code <= 6 ? code : 4 },
      );
      if (e2.detail !== undefined) errObj.detail = e2.detail;
      reject(errObj);
    });
  });
}

// 采集类命令（list/health）经 manager.mjs --json 子进程执行：
// 二者内部用 spawnSync 调 pwsh 做全量进程/端口枚举，单次耗时 5-20s。
// 在 ui 主进程里同步执行会冻结事件循环——连 /api/meta 这种零 IO 接口都要
// 排队数秒，页面表现为「整体卡死」。下沉子进程后主进程只做 JSON 转交，
// 事件循环始终可响应；再配合 server.mjs 的单飞+短缓存，避免请求叠加。
function runManagerJson(home, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MANAGER_MJS, '--json', '--home', home, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(Object.assign(new Error(`${args[0]} 采集子进程超时（${timeoutMs}ms）已终止`), { code: 'COLLECT_TIMEOUT', exitCode: 4 }));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`manager 子进程拉起失败：${e.message}`), { code: 'COLLECT_SPAWN_FAILED', exitCode: 4 }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out); } catch { /* stdout 非 JSON：走通用错误 */ }
      if (j?.ok === true) return resolve(j.data ?? {});
      const e2 = j?.error ?? {};
      reject(Object.assign(
        new Error(e2.message || err.trim() || `manager ${args[0]} 异常退出（code=${code}）`),
        { code: e2.code ?? 'COLLECT_FAILED', exitCode: Number.isInteger(code) && code >= 1 && code <= 6 ? code : 4 },
      ));
    });
  });
}

export async function cmdUi(ctx) {
  const opts = parseNamed(ctx.rest, { '--port': 'value', '--open': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  let port = 8199; // 固定端口契约；--port 0 使用随机端口
  if (opts.has('--port')) {
    port = Number.parseInt(opts.get('--port'), 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw usageError('--port 需要 0-65535 的整数（0 为随机端口）');
  }
  const { startUiServer } = await import('../../manager-ui/server.mjs');
  try {
    await startUiServer({
      home: ctx.home,
      port,
      open: opts.has('--open'), // 默认不开浏览器：Agent 前台拉起场景不期望弹窗
      api: {
        // 这三项是重采集（每次 3 次全量 pwsh 枚举，3-20s），必须走子进程，
        // 否则同步执行会阻塞 ui 事件循环（实测 /api/meta 也从 1ms 退化到 3-8s）。
        list: () => runManagerJson(ctx.home, ['list']),
        // UI 需要 actualPorts，CLI 侧对应 --probe（会顺带做 expectedPort 的 TCP 探测）。
        // sample=true 时追加 --resources：只在用户展开详情时做一次有界 RSS/CPU 采样，
        // 4s 轮询不带，避免把按需采样变成常驻轮询。
        status: (ref, sample) => runManagerJson(ctx.home, ['status', ref, '--probe', ...(sample ? ['--resources'] : [])], { timeoutMs: 30000 })
          .then((data) => { delete data.portListening; delete data.portNote; return data; }),
        health: () => runManagerJson(ctx.home, ['health'], { timeoutMs: 90000 }),
        // 时间序列曲线专用：采样是同步 pwsh，必须走子进程，否则 2s 一次的采样会冻结事件循环。
        sample: (ref) => runManagerJson(ctx.home, ['sample', ref], { timeoutMs: 15000 }),
        listRuns: (ref) => listRuns(ctx.home, ref),
        resolveLogFile: (ref, run, stream) => resolveLogFile(ctx.home, ref, run, stream),
        listSources: (ref) => listSources(ctx.home, ref),
        resolveSource: (ref, src) => resolveSource(ctx.home, ref, src),
        listTree: (ref, p) => listTree(ctx.home, ref, p),
        readFile: (ref, p, offset) => readProjectFile(ctx.home, ref, p, offset),
        doctor: () => cmdDoctor(ctx),
        // 端口诊断复用 CLI 同一只读实现；HTTP 层再按白名单裁剪字段（server.mjs），
        // 避免 commandLine 等敏感内容进入页面。
        port: (port) => portDiagnosis(port),
        // 受管启停与移除：改由 manager.mjs 子进程执行（#82-B1）——start/stop/restart
        // 可能持锁等待与进程核验数十秒，同进程同步执行会冻结 ui 事件循环、
        // 期间全部轮询停摆。--json 输出保证数据契约与直调 cmd* 一致（同一实现）。
        lifecycle: (ref, op, ack, treeRaw, graceRaw) => {
          if (!['start', 'stop', 'restart', 'remove'].includes(op)) throw usageError(`不支持的操作：${op}（仅 start|stop|restart|remove）`);
          // --ack-unresolved 只在支持它的操作上生效；对 stop/restart 明确拒绝而非静默丢弃，
          // 避免调用方误以为未结记录已被确认。
          if (ack && op !== 'start' && op !== 'remove') throw usageError(`${op} 不支持 ack 参数（仅 start/remove 接受 --ack-unresolved）`);
          // tree/grace 是 stop/restart 的专属参数；其他操作携带一律 400，避免静默丢弃。
          const stopLike = op === 'stop' || op === 'restart';
          if (!stopLike && (treeRaw != null || graceRaw != null)) {
            throw usageError(`${op} 不支持 tree/grace 参数（仅 stop/restart 接受）`);
          }
          let tree = false;
          if (treeRaw != null) {
            const raw = String(treeRaw);
            if (!['1', 'true', '0', 'false'].includes(raw)) throw usageError('tree 需要 1/true/0/false');
            tree = raw === '1' || raw === 'true';
          }
          const graceMs = parseGraceMsValue(graceRaw);
          return runLifecycleSubprocess(ctx.home, op, ref, ack, { tree, graceMs });
        },
      },
    });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const ours = await probeManagerUi(port);
    throw conflictError('PORT_IN_USE', ours
      ? `端口 ${port} 已有 manager ui 实例在运行：直接访问 http://127.0.0.1:${port}/，或 --port <N> 换端口另起实例`
      : `端口 ${port} 被其他程序占用：用 --port <N> 换端口（--port 0 为随机端口）`);
  }
}
