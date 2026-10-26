// 本地只读 Web 管理台（ui，design.md §2.2 / AC08）。
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageError, conflictError } from '../errors.mjs';
import { resolveLogFile, listRuns, listSources, resolveSource, listTree, readProjectFile } from '../log-sources.mjs';
import { parseNamed } from './common.mjs';
import { cmdList, cmdStatus, cmdDoctor } from './diagnose.mjs';

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
// 子进程退出码即 ManagerError exitCode（1-5），重构错误后 errorStatus 映射不变；
// 180s 超时兜底（CLI 前端 150s abort 通常先到），超时强杀子进程——中断的
// start/stop 按既有语义留下 STARTING/UNKNOWN 未结证据，不静默伪造结果。
function runLifecycleSubprocess(home, op, ref, ack) {
  const args = [MANAGER_MJS, '--json', '--home', home, op, ref];
  if (ack) args.push('--ack-unresolved', ack);
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
      if (j?.ok === true) return resolve(j.data);
      const e2 = j?.error ?? {};
      const errObj = Object.assign(
        new Error(e2.message || err.trim() || `manager ${op} 异常退出（code=${code}）`),
        { code: e2.code ?? 'LIFECYCLE_FAILED', exitCode: Number.isInteger(code) && code >= 1 && code <= 5 ? code : 4 },
      );
      if (e2.detail !== undefined) errObj.detail = e2.detail;
      reject(errObj);
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
        list: () => cmdList(ctx),
        status: (ref) => cmdStatus(ctx, ref).then((data) => { delete data.portListening; delete data.portNote; return data; }),
        listRuns: (ref) => listRuns(ctx.home, ref),
        resolveLogFile: (ref, run, stream) => resolveLogFile(ctx.home, ref, run, stream),
        listSources: (ref) => listSources(ctx.home, ref),
        resolveSource: (ref, src) => resolveSource(ctx.home, ref, src),
        listTree: (ref, p) => listTree(ctx.home, ref, p),
        readFile: (ref, p, offset) => readProjectFile(ctx.home, ref, p, offset),
        doctor: () => cmdDoctor(ctx),
        // 受管启停与移除：改由 manager.mjs 子进程执行（#82-B1）——start/stop/restart
        // 可能持锁等待与进程核验数十秒，同进程同步执行会冻结 ui 事件循环、
        // 期间全部轮询停摆。--json 输出保证数据契约与直调 cmd* 一致（同一实现）。
        lifecycle: (ref, op, ack) => {
          if (!['start', 'stop', 'restart', 'remove'].includes(op)) throw usageError(`不支持的操作：${op}（仅 start|stop|restart|remove）`);
          // --ack-unresolved 只在支持它的操作上生效；对 stop/restart 明确拒绝而非静默丢弃，
          // 避免调用方误以为未结记录已被确认。
          if (ack && op !== 'start' && op !== 'remove') throw usageError(`${op} 不支持 ack 参数（仅 start/remove 接受 --ack-unresolved）`);
          return runLifecycleSubprocess(ctx.home, op, ref, ack);
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
