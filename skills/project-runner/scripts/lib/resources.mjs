// Managed-process resource sampling (RSS / CPU), one bounded snapshot per call.
// Platform collection lives in lib/probe.mjs -> ps/proc.ps1 (Windows) or
// lib/proc-linux.mjs (Linux); this module turns platform samples into per-run
// aggregates. Command-mode runs aggregate the real target and its descendants
// so npm/vite style launchers report the whole working set.
import { sampleResources, verifyRun, RESOURCE_SAMPLE_INTERVAL_MS } from './probe.mjs';

export { RESOURCE_SAMPLE_INTERVAL_MS };

function sumField(processes, field) {
  let total = 0;
  let any = false;
  for (const p of processes) {
    const v = p[field];
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; any = true; }
  }
  return any ? total : null;
}

function publicProcess(p) {
  return {
    pid: p.pid,
    rssBytes: p.rssBytes ?? null,
    privateBytes: p.privateBytes ?? null,
    cpuPercent: p.cpuPercent ?? null,
    cpuTimeMs: p.cpuTimeMs ?? null,
  };
}

// runs: [{ pid, kind, verified?, creationFileTime?, image? }]
// 返回与输入同序的结果数组；不可采样时返回 { available:false, reason }，绝不抛错。
// verified=true 表示调用方已用同一运行记录完成身份核验（list/status），省去重复 pwsh 调用；
// 未标记时这里再核验一次，避免对 PID 复用后的无关进程采样。
export function sampleRunResources(runs, opts = {}) {
  const inputs = Array.isArray(runs) ? runs : [];
  const out = new Array(inputs.length).fill(null);
  const candidates = [];
  inputs.forEach((run, index) => {
    if (!run || !Number.isInteger(run.pid) || run.pid <= 0) {
      out[index] = { available: false, reason: '无可采样的受管 pid' };
      return;
    }
    if (run.verified !== true) {
      try {
        const v = verifyRun(run);
        if (!v.alive) {
          out[index] = {
            available: false,
            reason: v.reason === 'pidReused' ? 'PID 已被复用，拒绝采样' : '进程已退出，不采样',
          };
          return;
        }
      } catch (e) {
        out[index] = { available: false, reason: `身份核验失败（${e.code ?? e.message}），不采样` };
        return;
      }
    }
    candidates.push({ index, run });
  });
  if (!candidates.length) return out;

  const intervalMs = opts.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS;
  let sampled;
  try {
    sampled = sampleResources(
      candidates.map(({ run }) => ({ id: run.pid, tree: run.kind === 'command' })),
      { intervalMs },
    );
  } catch (e) {
    for (const { index } of candidates) out[index] = { available: false, reason: `资源采样失败：${e.code ?? e.message}` };
    return out;
  }
  if (sampled?.result && sampled.result !== 'ok') {
    for (const { index } of candidates) out[index] = { available: false, reason: `资源采样失败：${sampled.code ?? sampled.result}` };
    return out;
  }

  const procs = new Map((sampled.processes ?? []).filter((p) => p.result === 'ok').map((p) => [p.pid, p]));
  const itemById = new Map((sampled.items ?? []).map((it) => [it.id, it]));
  for (const { index, run } of candidates) {
    const item = itemById.get(run.pid);
    const pids = item?.pids?.length ? item.pids : [run.pid];
    const processes = pids.map((pid) => procs.get(pid)).filter(Boolean);
    const scope = run.kind === 'command' ? 'tree' : 'process';
    if (!processes.length) {
      out[index] = { available: false, scope, reason: '采样期间进程已退出或内存不可读' };
      continue;
    }
    out[index] = {
      available: true,
      scope,
      sampledAt: new Date().toISOString(),
      intervalMs: sampled.intervalMs ?? intervalMs,
      processCount: processes.length,
      rssBytes: sumField(processes, 'rssBytes'),
      privateBytes: sumField(processes, 'privateBytes'),
      cpuPercent: sumField(processes, 'cpuPercent'),
      cpuTimeMs: sumField(processes, 'cpuTimeMs'),
      processes: processes.map(publicProcess),
      ...(item?.truncated ? { truncated: true, note: '后代进程数超过采样上限，仅聚合前 64 个进程' } : {}),
      note: scope === 'tree'
        ? '命令模式：聚合受管目标及其后代进程的单次采样；CPU% 可超过 100'
        : '直连模式：仅采样受管目标进程的单次快照；CPU% 可超过 100',
    };
  }
  return out;
}
