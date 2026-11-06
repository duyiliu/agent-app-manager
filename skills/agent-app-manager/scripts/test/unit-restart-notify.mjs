#!/usr/bin/env node
// 单元测试：restart 策略纯函数与 notify 退出通知钩子（临时 home，无需真实进程）。
// 用法：node scripts/test/unit-restart-notify.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  validateRestartFields, normalizeRestartFields, effectiveRestartSettings,
  isCrashExit, computeRestartDelay, planRestart, exitDescription,
  DEFAULT_MAX_RESTARTS, DEFAULT_BACKOFF_MS, MAX_RESTARTS_LIMIT, MAX_BACKOFF_MS,
} from '../lib/restart.mjs';
import {
  loadGlobalOnExit, resolveOnExit, notifyEnv, runNotifyCommand,
  NOTIFY_COMMAND_MAX,
} from '../lib/notify.mjs';
import { atomicWriteJson } from '../lib/store.mjs';
import { SCHEMA_VERSION } from '../lib/constants.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-unit-restart-notify-'));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

const errsOf = (d) => validateRestartFields(d, []);
const okSettings = { restartPolicy: 'on-failure', maxRestarts: 3, backoffMs: 1000 };

try {
  // ---------- restart.mjs ----------
  check('validateRestartFields：默认缺省合法', () => {
    assert.deepEqual(errsOf({}), []);
    assert.deepEqual(errsOf({ restartPolicy: 'never' }), []);
    assert.deepEqual(errsOf({ restartPolicy: 'on-failure' }), []);
    assert.deepEqual(errsOf({ restartPolicy: 'on-failure', maxRestarts: 0, backoffMs: 0 }), []);
    assert.deepEqual(errsOf({ restartPolicy: 'on-failure', maxRestarts: MAX_RESTARTS_LIMIT, backoffMs: MAX_BACKOFF_MS }), []);
  });
  check('validateRestartFields：非法 policy/限界/越界值', () => {
    assert.deepEqual(errsOf({ restartPolicy: 'always' }), ['restartPolicy 只能是 never 或 on-failure']);
    assert.match(errsOf({ maxRestarts: 1 })[0], /maxRestarts 仅在 restartPolicy=on-failure 时可用/);
    assert.match(errsOf({ backoffMs: 1 })[0], /backoffMs 仅在 restartPolicy=on-failure 时可用/);
    for (const v of [-1, 1.5, '3', MAX_RESTARTS_LIMIT + 1]) {
      assert.match(errsOf({ restartPolicy: 'on-failure', maxRestarts: v })[0], /maxRestarts 需为 0-100 的整数/, `maxRestarts=${v}`);
    }
    for (const v of [-1, 1.5, '100', MAX_BACKOFF_MS + 1]) {
      assert.match(errsOf({ restartPolicy: 'on-failure', backoffMs: v })[0], /backoffMs 需为 0-600000 的整数/, `backoffMs=${v}`);
    }
  });
  check('normalizeRestartFields：never 丢弃限界，on-failure 补默认', () => {
    assert.deepEqual(normalizeRestartFields({}), { restartPolicy: 'never', maxRestarts: null, backoffMs: null });
    assert.deepEqual(normalizeRestartFields({ restartPolicy: 'never', maxRestarts: 5, backoffMs: 9 }),
      { restartPolicy: 'never', maxRestarts: null, backoffMs: null });
    // 断言具体值而不是常量符号：变异体改 DEFAULT_MAX_RESTARTS/DEFAULT_BACKOFF_MS 必须被杀
    assert.deepEqual(normalizeRestartFields({ restartPolicy: 'on-failure' }),
      { restartPolicy: 'on-failure', maxRestarts: 3, backoffMs: 1000 });
    assert.deepEqual(normalizeRestartFields({ restartPolicy: 'on-failure', maxRestarts: 7, backoffMs: 50 }),
      { restartPolicy: 'on-failure', maxRestarts: 7, backoffMs: 50 });
  });
  check('effectiveRestartSettings：非法存量值降级安全默认', () => {
    assert.deepEqual(effectiveRestartSettings(), { restartPolicy: 'never', maxRestarts: 0, backoffMs: 0 });
    assert.deepEqual(effectiveRestartSettings({ restartPolicy: 'bogus' }), { restartPolicy: 'never', maxRestarts: 0, backoffMs: 0 });
    assert.deepEqual(effectiveRestartSettings({ restartPolicy: 'on-failure', maxRestarts: -1, backoffMs: 'x' }),
      { restartPolicy: 'on-failure', maxRestarts: 3, backoffMs: 1000 });
    // 边界两侧：0 是合法值、上限外回落默认（&& 链被翻成 || 时这些必须失败）
    assert.deepEqual(effectiveRestartSettings({ restartPolicy: 'on-failure', maxRestarts: 0, backoffMs: 0 }),
      { restartPolicy: 'on-failure', maxRestarts: 0, backoffMs: 0 });
    assert.deepEqual(effectiveRestartSettings({ restartPolicy: 'on-failure', maxRestarts: MAX_RESTARTS_LIMIT + 1, backoffMs: MAX_BACKOFF_MS + 1 }),
      { restartPolicy: 'on-failure', maxRestarts: 3, backoffMs: 1000 });
    assert.deepEqual(effectiveRestartSettings({ restartPolicy: 'on-failure', maxRestarts: 2, backoffMs: 500 }),
      { restartPolicy: 'on-failure', maxRestarts: 2, backoffMs: 500 });
  });
  check('isCrashExit：信号或非 0 退出码为崩溃，code=0 与证据缺失不算', () => {
    assert.equal(isCrashExit(0, null), false);
    assert.equal(isCrashExit(1, null), true);
    assert.equal(isCrashExit(null, 'SIGTERM'), true);
    assert.equal(isCrashExit(0, 'SIGKILL'), true);
    assert.equal(isCrashExit(null, null), false);
  });
  check('computeRestartDelay：指数增长 + 抖动 + 上限收敛', () => {
    const r0 = () => 0;
    assert.equal(computeRestartDelay(1000, 1, r0), 1000);
    assert.equal(computeRestartDelay(1000, 2, r0), 2000);
    assert.equal(computeRestartDelay(1000, 3, r0), 4000);
    // 非法输入回落默认
    assert.equal(computeRestartDelay(0, 1, r0), DEFAULT_BACKOFF_MS);
    assert.equal(computeRestartDelay(1000, 0, r0), 1000);
    // backoffMs=1 是合法值（>0 边界）：变异体把 >0 改成 >1 时必须失败
    assert.equal(computeRestartDelay(1, 1, r0), 1);
    // 抖动上界：rand→1 时 delay ≈ base*growth*1.5
    assert.equal(computeRestartDelay(1000, 2, () => 0.999999), 3000);
    // 指数顶到 MAX_BACKOFF_MS 上限
    assert.equal(computeRestartDelay(600000, 5, r0), MAX_BACKOFF_MS);
  });
  check('planRestart：stop/dead/restart 决策矩阵', () => {
    assert.deepEqual(planRestart({ restartPolicy: 'never' }, 0, 1, null), { action: 'stop', reason: 'policy-never' });
    assert.deepEqual(planRestart(okSettings, 0, null, null), { action: 'stop', reason: 'exit-evidence-unavailable' });
    assert.deepEqual(planRestart(okSettings, 0, 0, null), { action: 'stop', reason: 'clean-exit' });
    const dead = planRestart(okSettings, 3, 1, null);
    assert.deepEqual(dead, { action: 'dead', reason: 'max-restarts', restartCount: 3 });
    const go = planRestart(okSettings, 1, null, 'SIGKILL', () => 0);
    assert.equal(go.action, 'restart');
    assert.equal(go.reason, 'on-failure');
    assert.equal(go.restartCount, 2);
    assert.equal(go.delayMs, 2000);
    // restartCount 非整数/负数按 0 计（&& 翻 || 后负数会被采信，restartCount 变成 0+(-1+1)=0）
    const first = planRestart(okSettings, 'x', 1, null, () => 0);
    assert.equal(first.restartCount, 1);
    assert.equal(first.delayMs, 1000);
    const neg = planRestart(okSettings, -1, 1, null, () => 0);
    assert.equal(neg.restartCount, 1);
  });
  check('exitDescription：信号优先，缺证为 unknown', () => {
    assert.equal(exitDescription(0, 'SIGTERM'), 'signal=SIGTERM');
    assert.equal(exitDescription(2, null), 'code=2');
    assert.equal(exitDescription(null, null), 'code=unknown');
  });

  // ---------- notify.mjs ----------
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });

  check('loadGlobalOnExit：缺失/损坏/超长按未配置', () => {
    assert.equal(loadGlobalOnExit(home), null);
    fs.writeFileSync(path.join(home, 'config.json'), '{bad json');
    assert.equal(loadGlobalOnExit(home), null);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: 'x'.repeat(NOTIFY_COMMAND_MAX + 1) }));
    assert.equal(loadGlobalOnExit(home), null);
    // 上限两侧用具体值：NOTIFY_COMMAND_MAX=1000 恰收、1001 拒（常量符号自身变异必须被杀）
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: 'x'.repeat(1000) }));
    assert.equal(loadGlobalOnExit(home), 'x'.repeat(1000));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: 'x'.repeat(1001) }));
    assert.equal(loadGlobalOnExit(home), null);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: '  ' }));
    assert.equal(loadGlobalOnExit(home), null);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: 'echo hi' }));
    assert.equal(loadGlobalOnExit(home), 'echo hi');
    fs.unlinkSync(path.join(home, 'config.json'));
  });
  check('resolveOnExit：app.onExit 优先，config.json 兜底', () => {
    const appId = 'a0123456789abcde';
    const writeReg = (app) => atomicWriteJson(path.join(home, 'registry.json'), { schemaVersion: SCHEMA_VERSION, apps: app ? { [appId]: app } : {} });
    writeReg(null);
    assert.equal(resolveOnExit(home, appId), null);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: 'echo global' }));
    assert.deepEqual(resolveOnExit(home, appId), { command: 'echo global', app: null });
    const app = { appId, alias: 'demo', onExit: 'echo app' };
    writeReg(app);
    assert.deepEqual(resolveOnExit(home, appId), { command: 'echo app', app });
    // app.onExit 超长 → 回落全局
    writeReg({ ...app, onExit: 'x'.repeat(NOTIFY_COMMAND_MAX + 1) });
    assert.equal(resolveOnExit(home, appId).command, 'echo global');
    fs.unlinkSync(path.join(home, 'config.json'));
  });
  check('notifyEnv：退出证据映射为 PROJECT_RUNNER_* 变量', () => {
    const app = { alias: 'demo' };
    const cur = {
      runId: 'r1', pid: 4242, endedAt: '2026-01-01T00:00:00Z',
      exitNote: 'note', exit: { code: 7, signal: null },
    };
    assert.deepEqual(notifyEnv('a1', app, cur), {
      PROJECT_RUNNER_APP_ID: 'a1',
      PROJECT_RUNNER_ALIAS: 'demo',
      PROJECT_RUNNER_RUN_ID: 'r1',
      PROJECT_RUNNER_PID: '4242',
      PROJECT_RUNNER_ENDED_AT: '2026-01-01T00:00:00Z',
      PROJECT_RUNNER_EXIT_NOTE: 'note',
      PROJECT_RUNNER_EXIT_CODE: '7',
      PROJECT_RUNNER_EXIT_SIGNAL: '',
    });
    const empty = notifyEnv('a2', null, {});
    assert.equal(empty.PROJECT_RUNNER_PID, '');
    assert.equal(empty.PROJECT_RUNNER_EXIT_CODE, '');
  });
  check('runNotifyCommand：成功/非零/环境变量透传，绝不抛错', () => {
    if (process.platform === 'win32') return; // 断言走 POSIX sh 语义，Windows 分支由集成冒烟覆盖
    assert.equal(runNotifyCommand('exit 0', {}, home), 'ok');
    assert.equal(runNotifyCommand('exit 3', {}, home), 'exit:3');
    const out = path.join(base, 'notify-out.txt');
    assert.equal(runNotifyCommand(
      `printf '%s' "$PROJECT_RUNNER_APP_ID" > ${JSON.stringify(out)}`,
      { PROJECT_RUNNER_APP_ID: 'aenv1' }, home), 'ok');
    assert.equal(fs.readFileSync(out, 'utf8'), 'aenv1');
    // 信号分支：SIGTERM 归类 timeout，其余信号归类 signal:<名>
    assert.equal(runNotifyCommand('kill -TERM $$', {}, home), 'timeout');
    assert.equal(runNotifyCommand('kill -SEGV $$', {}, home), 'signal:SIGSEGV');
  });
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败不判负 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nunit restart/notify ok');
