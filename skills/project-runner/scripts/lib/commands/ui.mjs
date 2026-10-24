// 管理台域命令：启动本地只读 Web 服务，所有数据与生命周期操作复用 CLI 同一实现。
import http from 'node:http';
import { usageError, conflictError } from '../errors.mjs';
import { listRuns, listSources, resolveLogFile, resolveSource, listTree, readProjectFile } from '../log-sources.mjs';
import { parseNamed } from './options.mjs';
import { cmdList, cmdStatus, cmdDoctor } from './diagnostics.mjs';
import { cmdStart, cmdStop, cmdRestart, cmdRemove } from './lifecycle.mjs';

// ---------- 本地只读 Web 管理台（ui，design.md §2.2 / AC08） ----------

// 固定端口 8199 的占用探测：已有 ui 实例的 / 返回本页面 HTML（含可识别标记），
// 据此区分"已有 ui 实例"与"被其他程序占用"
function probeManagerUi(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('id="roBanner"')));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
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
        // 受管启停与移除：复用 CLI 同一实现与全部安全检查（锁、身份核验、未结记录拒绝）；ack 透传 --ack-unresolved
        lifecycle: (ref, op, ack) => {
          const fn = { start: cmdStart, stop: cmdStop, restart: cmdRestart, remove: cmdRemove }[op];
          if (!fn) throw usageError(`不支持的操作：${op}（仅 start|stop|restart|remove）`);
          return fn({ ...ctx, rest: ack ? [ref, '--ack-unresolved', ack] : [ref] }, ref);
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
