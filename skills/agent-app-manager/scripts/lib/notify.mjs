// 受管进程退出通知钩子（issue #135）：desc `onExit`（登记进注册表）或全局
// `~/.agent-app-manager/config.json` 的 `onExit` 配置的回调命令。触发路径有二：
// ① 查询首次观测到 RUNNING→已退出的落账路径执行一次（运行记录
// `notifiedAt`/`notifyResult` 留证）；② restartPolicy=on-failure 的监督型应用，
// 由 log-writer 在监督 finalize（不重启/clean-exit、重启耗尽 DEAD）时认领执行一次，
// BACKOFF（将自动重启）不触发。人工 stop 走 markStopped 直接落账、不经此路径，不触发。
// 命令只来自本机信任边界内的配置（Skill 写入的 desc 文件 / 本机 config.json），
// 不存在远程/不可信注入面；执行有界超时、失败静默——绝不影响 status/list 主流程。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRegistry } from './store.mjs';

export const NOTIFY_TIMEOUT_MS = 15000;
export const NOTIFY_COMMAND_MAX = 1000;

// 全局兜底：<home>/config.json 的 { "onExit": "<命令>" }。
// 不可读/损坏/超长按未配置处理（辅助路径失败静默）。
export function loadGlobalOnExit(home) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const v = d?.onExit;
    return typeof v === 'string' && v.trim() && v.length <= NOTIFY_COMMAND_MAX ? v : null;
  } catch { return null; }
}

// 应用生效的钩子命令：注册表登记的 app.onExit 优先，全局 config.json 兜底；均无 → null。
// 注册表损坏时按无应用配置处理，仍尝试全局兜底。
export function resolveOnExit(home, appId) {
  let app = null;
  try { app = readRegistry(home).apps?.[appId] ?? null; } catch { /* 按未配置处理 */ }
  const v = app?.onExit;
  if (typeof v === 'string' && v.trim() && v.length <= NOTIFY_COMMAND_MAX) {
    return { command: v, app };
  }
  const g = loadGlobalOnExit(home);
  return g ? { command: g, app } : null;
}

// 回调负载：以 PROJECT_RUNNER_* 环境变量传递（appId/alias/runId/pid/退出说明/退出码与信号/时间）。
// 退出码/信号来自 #102 的退出码记录（cur.exit={code,signal,...}），不可得时为空串。
export function notifyEnv(appId, app, cur) {
  return {
    PROJECT_RUNNER_APP_ID: appId,
    PROJECT_RUNNER_ALIAS: app?.alias ?? '',
    PROJECT_RUNNER_RUN_ID: cur.runId ?? '',
    PROJECT_RUNNER_PID: cur.pid != null ? String(cur.pid) : '',
    PROJECT_RUNNER_ENDED_AT: cur.endedAt ?? '',
    PROJECT_RUNNER_EXIT_NOTE: cur.exitNote ?? '',
    PROJECT_RUNNER_EXIT_CODE: cur.exit?.code != null ? String(cur.exit.code) : '',
    PROJECT_RUNNER_EXIT_SIGNAL: cur.exit?.signal ?? '',
    PROJECT_RUNNER_HOME: '',
  };
}

// 有界同步执行回调命令；返回结果串供 notifyResult 落账，绝不抛错。
export function runNotifyCommand(command, env, home) {
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
  try {
    const r = spawnSync(shell, args, {
      env: { ...process.env, ...env, PROJECT_RUNNER_HOME: home },
      stdio: 'ignore', timeout: NOTIFY_TIMEOUT_MS, windowsHide: true,
      // 回调命令整串交给 cmd 自行解析；Node 默认会对含空格的参数再包引号并转义内部
      // 引号，与 cmd /s /c 的首尾剥引号叠加会拆坏用户命令，故原样传递。
      windowsVerbatimArguments: true,
    });
    if (r.error) return `failed:${r.error.code ?? r.error.message}`;
    if (r.signal) return r.signal === 'SIGTERM' ? 'timeout' : `signal:${r.signal}`;
    return r.status === 0 ? 'ok' : `exit:${r.status}`;
  } catch (e) {
    return `failed:${e.code ?? e.message}`;
  }
}
