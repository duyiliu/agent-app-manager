#!/usr/bin/env node
// 环境契约冒烟：envRefs 启动前校验、envFile 注入不落盘、status/UI 脱敏。
// 用法：node scripts/test/env-smoke.mjs（隔离 --home；核验类断言缺进程探针时跳过）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hasProcessProbe, isWindows } from './platform.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-env-smoke-'));
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const root = fs.realpathSync(proj);

const runAt = (home, args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON（崩溃或文本模式） */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFile = (file, timeoutMs = 8000) => {
  for (let i = 0; i < timeoutMs / 100; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return true;
    sleep(100);
  }
  return false;
};

let failed = 0;
const skipped = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const skipWithoutProbe = (name, fn) => {
  if (!hasProcessProbe()) {
    skipped.push(name);
    console.log(`  skip  ${name}（缺进程探针）`);
    return;
  }
  check(name, fn);
};

const hasPwsh = hasProcessProbe();
if (!hasPwsh) console.log(`（未检测到进程探针 ${isWindows ? 'pwsh 7' : '/proc'}：本次仅执行不依赖核验的断言）`);

try {
  // 1) 缺失 envRefs：一次性列出全部名称，且在注册/日志/运行记录落盘前失败。
  const missingHome = path.join(base, 'missing-home');
  const suffix = process.pid.toString(36).toUpperCase();
  const missing = [`PR_SMOKE_MISSING_ALPHA_${suffix}`, `PR_SMOKE_MISSING_BETA_${suffix}`];
  const missingDesc = path.join(base, 'desc-missing.json');
  fs.writeFileSync(missingDesc, JSON.stringify({
    alias: 'env-smoke-missing', root, entry: 'missing', mode: 'node',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'],
    envRefs: missing,
  }));
  check('缺失 envRefs：ENV_MISSING 且错误包含全部缺失名称', () => {
    const r = runAt(missingHome, ['start-new', '--desc', missingDesc]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error?.code, 'ENV_MISSING');
    for (const name of missing) assert(r.json.error.message.includes(name), `错误未包含 ${name}：${r.json.error.message}`);
  });
  check('缺失 envRefs：拒绝带病启动，不写注册表/运行记录/日志', () => {
    assert.equal(fs.existsSync(path.join(missingHome, 'registry.json')), false, '不应写入注册表');
    const runtimeDir = path.join(missingHome, 'runtime');
    assert(!fs.existsSync(runtimeDir) || fs.readdirSync(runtimeDir).length === 0, '不应写运行记录');
    const logsDir = path.join(missingHome, 'logs');
    assert(!fs.existsSync(logsDir) || fs.readdirSync(logsDir).length === 0, '不应创建运行日志');
  });

  // 2) envFile 注入 + 敏感名脱敏 + envFile 值不落 registry/runtime/status。
  const home = path.join(base, 'home');
  const probeOut = path.join(base, 'probe.json');
  const probeScript = path.join(root, 'probe.js');
  fs.writeFileSync(probeScript, [
    "const fs=require('fs');",
    "fs.writeFileSync(process.argv[2], JSON.stringify({",
    '  token: process.env.PR_SMOKE_ENVFILE_TOKEN,',
    '  plain: process.env.PR_SMOKE_ENVFILE_PLAIN,',
    '  password: process.env.PR_SMOKE_LITERAL_PASSWORD,',
    '  hostRef: process.env.PR_SMOKE_HOST_REF,',
    '}));',
    'setInterval(() => {}, 500);',
  ].join('\n'));
  const envFile = path.join(base, 'app.env');
  const fileToken = 'file-token-value-not-persisted';
  const filePlain = 'file-plain-value-not-persisted';
  fs.writeFileSync(envFile, [
    '# envFile smoke',
    `export PR_SMOKE_ENVFILE_TOKEN="${fileToken}" # 行尾注释`,
    `PR_SMOKE_ENVFILE_PLAIN='${filePlain}' # 行尾注释`,
  ].join('\n'));
  const descFile = path.join(base, 'desc-envfile.json');
  fs.writeFileSync(descFile, JSON.stringify({
    alias: 'env-smoke-envfile', root, entry: 'envfile', mode: 'node',
    exe: process.execPath, args: [probeScript, probeOut],
    envRefs: ['PR_SMOKE_ENVFILE_TOKEN', 'PR_SMOKE_ENVFILE_PLAIN', 'PR_SMOKE_HOST_REF'],
    envFile,
    env: { PR_SMOKE_LITERAL_PASSWORD: 'literal-password-value-not-echoed', PR_SMOKE_PLAIN_LITERAL: 'plain-literal-ok' },
  }, null, 2));
  const hostRef = 'host-ref-value';
  let appId = null;
  skipWithoutProbe('envFile 注入变量且 envRefs 可由 envFile/宿主环境满足；疑似机密 env 非阻断告警', () => {
    const r = runAt(home, ['start-new', '--desc', descFile], { PR_SMOKE_HOST_REF: hostRef });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json.data.status, 'RUNNING');
    assert(r.json.data.envWarnings?.includes('PR_SMOKE_LITERAL_PASSWORD'), `缺少 env 机密告警：${JSON.stringify(r.json.data)}`);
    assert(r.json.data.envWarning?.includes('envRefs') && r.json.data.envWarning.includes('envFile'), `告警未提示改用 envRefs/envFile：${r.json.data.envWarning}`);
    appId = r.json.data.appId;
    assert(waitFile(probeOut), '目标进程未写出 env 探针文件');
    const got = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
    assert.equal(got.token, fileToken, 'envFile 变量未注入目标进程');
    assert.equal(got.plain, filePlain, 'envFile 普通变量未注入目标进程');
    assert.equal(got.password, 'literal-password-value-not-echoed', 'desc.env 覆盖行为异常');
    assert.equal(got.hostRef, hostRef, '宿主 envRefs 未注入目标进程');
  });

  skipWithoutProbe('envFile 值不写入 registry/runtime', () => {
    const regRaw = fs.readFileSync(path.join(home, 'registry.json'), 'utf8');
    const rtRaw = fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8');
    const reg = JSON.parse(regRaw);
    assert.equal(reg.apps[appId].envFile, envFile, 'envFile 路径应持久化供跨会话重启');
    for (const value of [fileToken, filePlain]) {
      assert(!regRaw.includes(value), `registry 泄漏 envFile 值：${value}`);
      assert(!rtRaw.includes(value), `runtime 泄漏 envFile 值：${value}`);
    }
  });

  skipWithoutProbe('status 对敏感 env 名显示 ***，非敏感 env 保持原行为，envFile 值不出现', () => {
    const r = runAt(home, ['status', 'env-smoke-envfile']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.data.env.PR_SMOKE_LITERAL_PASSWORD, '***');
    assert.equal(r.json.data.env.PR_SMOKE_PLAIN_LITERAL, 'plain-literal-ok');
    assert(r.json.data.run.envResolved.includes('PR_SMOKE_ENVFILE_TOKEN'), 'envRefs 应只回显名称');
    const text = JSON.stringify(r.json.data);
    assert(!text.includes('literal-password-value-not-echoed'), 'status 回显了敏感 env 值');
    assert(!text.includes(fileToken) && !text.includes(filePlain), 'status 回显了 envFile 值');
  });

  skipWithoutProbe('清理 envFile 测试实例', () => {
    const r = runAt(home, ['stop', 'env-smoke-envfile']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
if (skipped.length) console.log(`\n${skipped.length} 项跳过（缺进程探针）`);
console.log('\nenv smoke ok');
