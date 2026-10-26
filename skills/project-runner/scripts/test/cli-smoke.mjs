#!/usr/bin/env node
// manager CLI 冒烟测试（remove / prune / logs 统一日志源）：隔离 --home + 临时记录与日志，
// 不触碰真实注册表与业务进程。覆盖：remove 的 RUNNING 拒绝/未结记录 ack 流程/证据保留、
// prune 默认 dry-run/三类残留回收/DATA_* 契约、logs --src/--list-sources/--stream both。
// 用法：node scripts/test/cli-smoke.mjs   （无外部依赖，Node 22+；未安装 pwsh 7 时
// 自动跳过依赖应用锁与进程身份核验的生命周期检查）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { hasProcessProbe, isWindows } from './platform.mjs';
import { psProc } from '../lib/probe.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = path.resolve(SCRIPT_DIR, '..', 'manager.mjs');

// manager 的 resolveHome 对 home 做 realpathSync.native（展开 8.3 短名等），
// 测试路径统一用 realpath 后的基目录，保证与 CLI 输出可直接比较
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cli-smoke-')));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
const hintFile = path.join(base, 'hint', 'nohup.out');
for (const d of [
  path.join(home, 'runtime'), path.join(home, 'logs', 'aok'), path.join(home, 'logs', 'astuck'),
  path.join(home, 'logs', 'aun'), path.join(home, 'locks'), proj, path.join(proj, '.tmp'),
  path.dirname(hintFile),
]) fs.mkdirSync(d, { recursive: true });

const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
// 受管应用 aok：current=rkeep1（STOPPED），prevRuns=[rkeep2]；rold1/rold2 超出保留期（可回收）
const aokLogs = path.join(home, 'logs', 'aok');
w(path.join(aokLogs, 'rkeep1.stdout.log'), 'keep1 stdout A\nkeep1 stdout B\n');
w(path.join(aokLogs, 'rkeep1.stdout.log.1'), 'rotated keep1 stdout\n');
w(path.join(aokLogs, 'rkeep1.stderr.log'), 'keep1 stderr E1\nkeep1 stderr E2\n');
w(path.join(aokLogs, 'rkeep2.stdout.log'), 'keep2 stdout\n');
w(path.join(aokLogs, 'rold1.stdout.log'), 'old1 beyond retention\n');
w(path.join(aokLogs, 'rold1.stdout.log.1'), 'old1 rotated beyond retention\n');
w(path.join(aokLogs, 'rold2.stderr.log'), 'old2 beyond retention\n');
w(path.join(aokLogs, '.rkeep1.pid'), '123\n');
w(path.join(aokLogs, '.rold1.pid'), '123\n');
w(path.join(aokLogs, '.rold1.sink.json'), '{}\n');
w(path.join(aokLogs, 'notes.txt'), '不是批次日志，必须保留\n');
let externalPruneFiles = [];
if (process.platform !== 'win32') {
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const outsideDirLog = path.join(outside, 'rold1.stdout.log');
  const outsideFileLog = path.join(outside, 'outside.log');
  w(outsideDirLog, 'external directory log\n');
  w(outsideFileLog, 'external symlink log\n');
  w(path.join(home, 'runtime', 'asymlink.json'), JSON.stringify({ schemaVersion: 1, appId: 'asymlink', current: null, prevRuns: [] }));
  fs.symlinkSync(outside, path.join(home, 'logs', 'asymlink'), 'dir');
  fs.symlinkSync(outsideFileLog, path.join(aokLogs, 'rold3.stdout.log'), 'file');
  externalPruneFiles = [outsideDirLog, outsideFileLog];
}
w(path.join(proj, '.tmp', 'jrebel-local-20261020-100000.stdout.log'), 'tmp line A\ntmp line B\n');
w(path.join(proj, 'pom.xml'), '<project/>\n');
w(hintFile, 'hint line 1\nhint line 2\n');
// 死锁残留（应回收）与普通 .lock（绝不可回收）
w(path.join(home, 'locks', 'azombie.lock.stale-1700000000000'), '{"pid":999999}\n');
w(path.join(home, 'locks', 'alive.lock'), '{"pid":1,"creationFileTime":"1"}\n');
// 孤儿临时文件：旧的应回收，近期的可能是进行中的原子写（跳过）
const oldTmp1 = path.join(home, 'runtime', '.tmp-1234-deadbeef');
const oldTmp2 = path.join(aokLogs, '.tmp-5678-cafe01');
const recentTmp = path.join(home, '.tmp-777-beef02');
w(oldTmp1, 'x');
w(oldTmp2, 'x');
w(recentTmp, 'x');
const oldTime = new Date(Date.now() - 10 * 60 * 1000);
for (const f of [oldTmp1, oldTmp2]) fs.utimesSync(f, oldTime, oldTime);

const root = fs.realpathSync(proj);
const regApp = (appId, alias, mode = 'java') => ({
  appId, alias, displayName: alias, root, entry: 'default', cwd: root, mode,
  exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null,
  configRevision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const registryApps = { aok: regApp('aok', 'ok'), astuck: regApp('astuck', 'stuck'), aun: regApp('aun', 'unman') };
// dry-run 预览：直连/命令模式/非法 cwd 三个只读样本（不启动进程）
registryApps.adry = {
  ...regApp('adry', 'dry', 'proc'),
  exe: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
  envRefs: ['PR_DRY_SECRET', 'PR_DRY_MISSING'],
};
registryApps.adrycmd = {
  ...regApp('adrycmd', 'drycmd', 'node'),
  command: 'node server.js', expectedImage: isWindows ? 'node.exe' : 'node',
};
registryApps.abad = {
  ...regApp('abad', 'badcwd', 'proc'),
  cwd: path.join(base, 'missing-cwd'), exe: process.execPath,
};

const probeOk = hasProcessProbe();
if (probeOk) {
  // RUNNING 拒绝移除的受管应用：预登记 arun（别名 busy），运行记录在检查时用真实存活进程写入
  fs.mkdirSync(path.join(home, 'logs', 'arun'), { recursive: true });
  w(path.join(home, 'logs', 'arun', 'rrun1.stdout.log'), 'running log line\n');
  registryApps.arun = regApp('arun', 'busy');
}
w(path.join(home, 'registry.json'), JSON.stringify({ schemaVersion: 1, apps: registryApps }));

const rt = (id, cur, prev = []) => w(path.join(home, 'runtime', `${id}.json`), JSON.stringify({ schemaVersion: 1, appId: id, current: cur, prevRuns: prev }));
const now = '2026-01-01T00:00:00Z';
rt('aok', {
  runId: 'rkeep1', phase: 'STOPPED', managed: true, mode: 'java', intentAt: now, startedAt: now,
  pid: 99999, creationFileTime: '0', image: 'java.exe', envResolved: [],
  logPaths: { stdout: path.join(aokLogs, 'rkeep1.stdout.log'), stderr: path.join(aokLogs, 'rkeep1.stderr.log') },
  lastError: null, endedAt: now, exitNote: 'smoke',
}, [{ runId: 'rkeep2', phase: 'STOPPED', managed: true, startedAt: now, endedAt: now, archivedAt: now }]);
rt('astuck', {
  runId: 'rstuck1', phase: 'STARTING', managed: true, mode: 'java', intentAt: now, startedAt: null,
  pid: null, creationFileTime: null, image: null, envResolved: [], logPaths: null,
  lastError: null, endedAt: null,
});
rt('aun', {
  runId: 'runman1', phase: 'UNKNOWN', managed: false, mode: 'java', intentAt: now, startedAt: now,
  pid: null, creationFileTime: null, image: null, envResolved: [], logPaths: null,
  logHints: [hintFile], lastError: null, endedAt: null, note: '非受管',
});
rt('adry', {
  runId: 'rdry1', phase: 'STOPPED', managed: true, mode: 'proc', intentAt: now, startedAt: now,
  pid: null, creationFileTime: null, image: null, envResolved: [],
  logPaths: { stdout: path.join(home, 'logs', 'adry', 'rdry1.stdout.log'), stderr: path.join(home, 'logs', 'adry', 'rdry1.stderr.log') },
  lastError: null, endedAt: now, exitNote: 'smoke',
});

// dry-run 零写入快照：整个 home 的文件内容/目录清单都不应变化
const homeSnapshot = () => fs.readdirSync(home, { recursive: true }).map((rel) => {
  const p = path.join(home, String(rel));
  return fs.statSync(p).isFile() ? `${rel}:${fs.readFileSync(p).toString('base64')}` : `${rel}/`;
}).sort();

// 直接 import manager 数据层：验证 CLI --src 与 ui（同一 resolveSource）读到相同内容
const mgr = await import(pathToFileURL(MANAGER).href);

const run = (args) => new Promise((res) => {
  const c = spawn(process.execPath, [MANAGER, '--home', home, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  // JSON 信封始终走 stdout；stderr 只做诊断展示（如运行器警告），不参与解析
  c.on('exit', (code) => res({ code, text: out + err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
});
const registryOnDisk = () => JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));

// watch 常驻输出收集器：凑齐条件后主动关闭读端（制造 EPIPE）或发送 SIGINT，
// 再等待子进程退出，验证退出码与是否有残留监听/锁。
const watchCollect = (args, { human = false, interrupt = false, until, timeoutMs = 20000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [MANAGER, '--home', home, ...(human ? [] : ['--json']), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  let closing = false;
  const lines = [];
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    reject(new Error(`watch 未在 ${timeoutMs}ms 内达到条件或退出：\nstdout=${lines.join('\n')}\nstderr=${stderr}`));
  }, timeoutMs);
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) lines.push(line);
    }
    if (closing || !until(lines, buf)) return;
    closing = true;
    if (interrupt) {
      try { child.kill('SIGINT'); } catch { /* 已退出 */ }
    } else {
      // 关闭下游读端：下一次写 stdout 必须触发 EPIPE 并让 watch 干净退出
      child.stdout.removeAllListeners('data');
      child.stdout.destroy();
    }
  });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, lines, stderr });
  });
});

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

console.log(probeOk ? `进程探针可用（${isWindows ? 'pwsh 7' : '/proc'}）：执行全部检查` : '未检测到进程探针：跳过依赖应用锁/身份核验的生命周期检查');

// ---------- detect 只读启动描述候选 ----------
const detectRoot = path.join(base, 'detect-fixtures');
const viteRoot = path.join(detectRoot, 'vite-app');
const mavenRoot = path.join(detectRoot, 'maven-app');
const flaskRoot = path.join(detectRoot, 'flask-app');
const entryRoot = path.join(detectRoot, 'entry-app');
const emptyRoot = path.join(detectRoot, 'empty');
const pnpmRoot = path.join(detectRoot, 'pnpm-app');
const gradleRoot = path.join(detectRoot, 'gradle-app');
const fastapiRoot = path.join(detectRoot, 'fastapi-app');
for (const d of [viteRoot, mavenRoot, flaskRoot, emptyRoot, entryRoot, pnpmRoot, gradleRoot, fastapiRoot]) fs.mkdirSync(d, { recursive: true });
w(path.join(entryRoot, 'server.js'), 'console.log("entry")\n');
w(path.join(viteRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }));
w(path.join(pnpmRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' }, packageManager: 'pnpm@9.0.0' }));
w(path.join(pnpmRoot, 'vite.config.ts'), 'export default { server: { port: 5174 } }\n');
w(path.join(gradleRoot, 'build.gradle.kts'), 'plugins { id("org.springframework.boot") version "3.3.0" }\n');
w(path.join(gradleRoot, 'gradlew'), '');
fs.mkdirSync(path.join(gradleRoot, 'src/main/resources'), { recursive: true });
w(path.join(gradleRoot, 'src/main/resources/application.properties'), 'server.port=8888\n');
w(path.join(fastapiRoot, 'requirements.txt'), 'fastapi>=0.100\n');
w(path.join(fastapiRoot, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
w(path.join(mavenRoot, 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
w(path.join(mavenRoot, 'mvnw'), '');
w(path.join(flaskRoot, 'requirements.txt'), 'Flask==3.0\n');
w(path.join(flaskRoot, 'app.py'), 'app = None\n');
await check('detect vite/maven/flask 生成与 start-new schema 对齐的候选', async () => {
  const before = fs.readFileSync(path.join(home, 'registry.json'), 'utf8');
  const r = await run(['detect', '--root', detectRoot, '--json']);
  assert.equal(r.code, 0, r.text);
  const rows = r.json.data.candidates;
  assert.equal(rows.length, 7);
  const vite = rows.find((x) => x.desc.command === 'npm run dev');
  assert(vite, '缺 npm vite 候选');
  assert.equal(vite.desc.expectedImage, isWindows ? 'node.exe' : 'node');
  const maven = rows.find((x) => x.evidence.rule.startsWith('maven-spring-boot'));
  assert.equal(maven.desc.command, isWindows ? 'mvnw.cmd spring-boot:run' : './mvnw spring-boot:run');
  assert.equal(maven.desc.mode, 'java');
  const flask = rows.find((x) => x.evidence.rule === 'flask-app.py');
  assert.equal(flask.desc.command, isWindows ? 'python -m flask --app app run' : 'python3 -m flask --app app run');
  assert.equal(flask.desc.mode, 'python');
  const entry = rows.find((x) => String(x.evidence.rule).startsWith('entry-file:'));
  assert(entry, `缺入口文件候选：${rows.map((x) => x.evidence.rule).join(', ')}`);
  assert.equal(entry.confidence, 'low');
  assert.equal(entry.desc.command, 'node server.js');
  assert.equal(entry.desc.expectedImage, isWindows ? 'node.exe' : 'node');
  const pnpm = rows.find((x) => x.evidence.rule.includes('pm:pnpm'));
  assert(pnpm, `缺 pnpm 候选：${rows.map((x) => x.evidence.rule).join(', ')}`);
  assert.equal(pnpm.desc.command, 'pnpm run dev');
  assert.equal(pnpm.desc.expectedPort, 5174);
  const gradle = rows.find((x) => x.evidence.rule.startsWith('gradle-spring-boot'));
  assert(gradle, '缺 gradle 候选');
  assert.equal(gradle.desc.command, isWindows ? 'gradlew.bat bootRun' : './gradlew bootRun');
  assert.equal(gradle.desc.expectedPort, 8888);
  const fastapi = rows.find((x) => x.evidence.rule.startsWith('fastapi-uvicorn'));
  assert(fastapi, '缺 fastapi 候选');
  assert.equal(fastapi.desc.command, isWindows ? 'python -m uvicorn main:app' : 'python3 -m uvicorn main:app');
  assert(rows.every((x) => x.confidence && x.evidence.file));
  assert.equal(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'), before, 'detect 不得修改注册表');
  assert.equal(fs.readdirSync(home, { recursive: true }).some((x) => String(x).includes('locks')), true);
});
await check('detect 空目录返回空数组和建议，不报错', async () => {
  const r = await run(['detect', '--root', emptyRoot, '--json']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.json.data.candidates, []);
  assert(r.json.data.suggestion);
});
await check('detect 缺 root 使用参数错误契约', async () => {
  assert.equal((await run(['detect', '--json'])).code, 1);
});

// ---------- detect 栈识别补齐：dev:* / 框架 / Python 依赖标记 / venv / Go / .NET ----------
const detectMoreRoot = path.join(base, 'detect-more-fixtures');
const devStarRoot = path.join(detectMoreRoot, 'dev-star-app');
const poetryRoot = path.join(detectMoreRoot, 'poetry-app');
const uvRoot = path.join(detectMoreRoot, 'uv-app');
const venvRoot = path.join(detectMoreRoot, 'venv-app');
const goRoot = path.join(detectMoreRoot, 'go-app');
const dotnetRoot = path.join(detectMoreRoot, 'dotnet-app');
const dotnetNoApphostRoot = path.join(detectMoreRoot, 'dotnet-no-apphost-app');
const dotnetPropsApphostRoot = path.join(detectMoreRoot, 'dotnet-props-apphost-app');
const dotnetImportApphostRoot = path.join(detectMoreRoot, 'dotnet-import-apphost-app');
const springProfileRoot = path.join(detectMoreRoot, 'spring-profile-app');
const pipfileRoot = path.join(detectMoreRoot, 'pipfile-app');
const setupPyRoot = path.join(detectMoreRoot, 'setup-py-app');
const cargoRoot = path.join(detectMoreRoot, 'cargo-app');
const composerRoot = path.join(detectMoreRoot, 'composer-app');
const unsafeDevRoot = path.join(detectMoreRoot, 'dev-unsafe-app');
const goNestedRoot = path.join(detectMoreRoot, 'go-nested-app');
const cargoCustomRoot = path.join(detectMoreRoot, 'cargo-custom-bin-app');
const cargoMultiRoot = path.join(detectMoreRoot, 'cargo-multi-bin-app');
const cargoNestedAutoRoot = path.join(detectMoreRoot, 'cargo-nested-auto-bin-app');
const phpNoPortRoot = path.join(detectMoreRoot, 'php-no-port-app');
const phpPortRoot = path.join(detectMoreRoot, 'php-port-app');
const springInactiveProfileRoot = path.join(detectMoreRoot, 'spring-inactive-profile-app');
const springProfileOnlyRoot = path.join(detectMoreRoot, 'spring-profile-only-app');
const invalidEnvPortRoots = ['0', '65536', '99999'].map((port) => path.join(detectMoreRoot, `port-env-${port}`));
const invalidSpringPortRoots = ['0', '65536', '99999'].map((port) => path.join(detectMoreRoot, `port-spring-${port}`));
const frameworkFixtures = [
  ['react-app', 'react-scripts', 'start'],
  ['svelte-app', '@sveltejs/kit', 'dev'],
  ['astro-app', 'astro', 'dev'],
];
for (const d of [devStarRoot, poetryRoot, uvRoot, venvRoot, goRoot, dotnetRoot, dotnetNoApphostRoot, dotnetPropsApphostRoot, dotnetImportApphostRoot, springProfileRoot, pipfileRoot, setupPyRoot, cargoRoot, composerRoot, unsafeDevRoot, goNestedRoot, cargoCustomRoot, cargoMultiRoot, cargoNestedAutoRoot, phpNoPortRoot, phpPortRoot, springInactiveProfileRoot, springProfileOnlyRoot, ...invalidEnvPortRoots, ...invalidSpringPortRoots, ...frameworkFixtures.map(([name]) => path.join(detectMoreRoot, name))]) fs.mkdirSync(d, { recursive: true });

// pnpm + dev:*：脚本只在没有 dev/start/serve 时回退识别；.env.local 提供端口。
w(path.join(devStarRoot, 'package.json'), JSON.stringify({ scripts: { 'dev:web': 'vite' }, devDependencies: { vite: '^6' }, packageManager: 'pnpm@9.0.0' }));
w(path.join(devStarRoot, '.env.local'), 'PORT=4321\n');
// 含 shell 元字符的脚本名必须被拒绝，不得拼进 command。
w(path.join(unsafeDevRoot, 'package.json'), JSON.stringify({ scripts: { 'dev:web; echo pwned': 'vite' }, devDependencies: { vite: '^6' } }));
for (const [name, dep, script] of frameworkFixtures) {
  const dir = path.join(detectMoreRoot, name);
  w(path.join(dir, 'package.json'), JSON.stringify({ scripts: { [script]: `${dep} ${script}` }, dependencies: { [dep]: '1.0.0' } }));
}
// poetry：pyproject + poetry.lock + manage.py；同目录只应生成一个候选。
w(path.join(poetryRoot, 'pyproject.toml'), '[tool.poetry]\nname = "poetry-app"\nversion = "0.1.0"\n[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^4"\n');
w(path.join(poetryRoot, 'poetry.lock'), '[[package]]\nname = "django"\nversion = "4.2.0"\n');
w(path.join(poetryRoot, 'manage.py'), 'import django\n');
// uv：pyproject + uv.lock + FastAPI 入口。
w(path.join(uvRoot, 'pyproject.toml'), '[project]\nname = "uv-app"\ndependencies = ["fastapi>=0.100"]\n');
w(path.join(uvRoot, 'uv.lock'), 'name = "fastapi"\nversion = "0.100.0"\n');
w(path.join(uvRoot, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
// .venv 存在时 Python 候选应使用项目内解释器。
w(path.join(venvRoot, 'requirements.txt'), 'Flask==3.0\n');
w(path.join(venvRoot, 'app.py'), 'app = None\n');
const venvPython = isWindows ? path.join('.venv', 'Scripts', 'python.exe') : path.join('.venv', 'bin', 'python');
const venvImage = isWindows ? 'python.exe' : 'python3.12';
fs.mkdirSync(path.dirname(path.join(venvRoot, venvPython)), { recursive: true });
if (isWindows) {
  w(path.join(venvRoot, venvPython), '');
} else {
  // Linux venv 的 python 常指向版本化解释器；expectedImage 必须解析到真实映像名。
  w(path.join(venvRoot, path.dirname(venvPython), venvImage), '');
  fs.symlinkSync(venvImage, path.join(venvRoot, venvPython));
}
// Go：go.mod + package main/func main 才给候选；嵌套 go.mod 归属内层模块。
w(path.join(goRoot, 'go.mod'), 'module example.com/goapp\n\ngo 1.22\n');
w(path.join(goRoot, 'main.go'), 'package main\n\nfunc main() {}\n');
w(path.join(goNestedRoot, 'go.mod'), 'module example.com/outer\n\ngo 1.22\n');
w(path.join(goNestedRoot, 'main.go'), 'package main\n\nfunc main() {}\n');
fs.mkdirSync(path.join(goNestedRoot, 'nested'), { recursive: true });
w(path.join(goNestedRoot, 'nested/go.mod'), 'module example.com/nested\n\ngo 1.22\n');
w(path.join(goNestedRoot, 'nested/main.go'), 'package main\n\nfunc main() {}\n');
// .NET：Web SDK 项目 → dotnet run；UseAppHost=false 时目标影像是 dotnet host。
w(path.join(dotnetRoot, 'DotnetApp.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><AssemblyName>DotnetApp</AssemblyName></PropertyGroup></Project>\n');
w(path.join(dotnetNoApphostRoot, 'DotnetNoApphost.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><AssemblyName>DotnetNoApphost</AssemblyName><UseAppHost>false</UseAppHost></PropertyGroup></Project>\n');
// UseAppHost 也可能来自 Directory.Build.props 或显式 Import，而不是 csproj 本身。
w(path.join(dotnetPropsApphostRoot, 'Directory.Build.props'), '<Project><PropertyGroup><UseAppHost>false</UseAppHost></PropertyGroup></Project>\n');
w(path.join(dotnetPropsApphostRoot, 'PropsApp.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><AssemblyName>PropsApp</AssemblyName></PropertyGroup></Project>\n');
fs.mkdirSync(path.join(dotnetImportApphostRoot, 'build'), { recursive: true });
w(path.join(dotnetImportApphostRoot, 'build/common.props'), '<Project><PropertyGroup><UseAppHost>false</UseAppHost></PropertyGroup></Project>\n');
w(path.join(dotnetImportApphostRoot, 'ImportApp.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><Import Project="build/common.props" /><PropertyGroup><AssemblyName>ImportApp</AssemblyName></PropertyGroup></Project>\n');
// Spring profile 端口：只有显式激活 profile 时才采用 profile 配置的端口。
w(path.join(springProfileRoot, 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>');
fs.mkdirSync(path.join(springProfileRoot, 'src/main/resources'), { recursive: true });
w(path.join(springProfileRoot, 'src/main/resources/application.properties'), 'spring.profiles.active=dev\n');
w(path.join(springProfileRoot, 'src/main/resources/application-dev.yml'), 'server:\n  port: 9091\n');
// 未声明激活 profile：多个 profile 文件端口都不得覆盖基础配置。
w(path.join(springInactiveProfileRoot, 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>');
fs.mkdirSync(path.join(springInactiveProfileRoot, 'src/main/resources'), { recursive: true });
w(path.join(springInactiveProfileRoot, 'src/main/resources/application.yml'), 'server:\n  port: 8080\n');
w(path.join(springInactiveProfileRoot, 'src/main/resources/application-dev.yml'), 'server:\n  port: 9091\n');
w(path.join(springInactiveProfileRoot, 'src/main/resources/application-prod.yml'), 'server:\n  port: 9092\n');
// 只有 profile 文件、没有激活声明时不得选中该端口。
w(path.join(springProfileOnlyRoot, 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>');
fs.mkdirSync(path.join(springProfileOnlyRoot, 'src/main/resources'), { recursive: true });
w(path.join(springProfileOnlyRoot, 'src/main/resources/application-dev.yml'), 'server:\n  port: 9091\n');
// 越界端口（0/65536/99999）不得进入 expectedPort 或证据。
for (const [i, port] of ['0', '65536', '99999'].entries()) {
  w(path.join(invalidEnvPortRoots[i], 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }));
  w(path.join(invalidEnvPortRoots[i], '.env.local'), `PORT=${port}\n`);
  w(path.join(invalidSpringPortRoots[i], 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>');
  fs.mkdirSync(path.join(invalidSpringPortRoots[i], 'src/main/resources'), { recursive: true });
  w(path.join(invalidSpringPortRoots[i], 'src/main/resources/application.properties'), `server.port=${port}\n`);
}
// Pipfile / setup.py 也是 Python 依赖证据。
w(path.join(pipfileRoot, 'Pipfile'), '[packages]\ndjango = "*"\n');
w(path.join(pipfileRoot, 'manage.py'), 'import django\n');
w(path.join(setupPyRoot, 'setup.py'), 'from setuptools import setup\nsetup(name="setup-py-app", install_requires=["fastapi"])\n');
w(path.join(setupPyRoot, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
// Rust / PHP：默认 main、自定义/多 bin、Laravel artisan 与纯 PHP 入口。
w(path.join(cargoRoot, 'Cargo.toml'), '[package]\nname = "cargo-app"\nversion = "0.1.0"\n');
fs.mkdirSync(path.join(cargoRoot, 'src'), { recursive: true });
w(path.join(cargoRoot, 'src/main.rs'), 'fn main() {}\n');
w(path.join(cargoCustomRoot, 'Cargo.toml'), '[package]\nname = "custom-pkg"\nversion = "0.1.0"\n\n[[bin]]\nname = "custom-server"\npath = "src/custom.rs"\n');
w(path.join(cargoMultiRoot, 'Cargo.toml'), '[package]\nname = "multi-pkg"\nversion = "0.1.0"\n\n[[bin]]\nname = "one"\npath = "src/one.rs"\n\n[[bin]]\nname = "two"\npath = "src/two.rs"\n');
w(path.join(cargoNestedAutoRoot, 'Cargo.toml'), '[package]\nname = "nested-cargo"\nversion = "0.1.0"\n');
fs.mkdirSync(path.join(cargoNestedAutoRoot, 'src'), { recursive: true });
w(path.join(cargoNestedAutoRoot, 'src/main.rs'), 'fn main() {}\n');
fs.mkdirSync(path.join(cargoNestedAutoRoot, 'src/bin/server'), { recursive: true });
w(path.join(cargoNestedAutoRoot, 'src/bin/server/main.rs'), 'fn main() {}\n');
w(path.join(composerRoot, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^10' } }));
w(path.join(composerRoot, 'artisan'), '#!/usr/bin/env php\n');
w(path.join(phpNoPortRoot, 'composer.json'), JSON.stringify({ require: { 'slim/slim': '^4' } }));
fs.mkdirSync(path.join(phpNoPortRoot, 'public'), { recursive: true });
w(path.join(phpNoPortRoot, 'public/index.php'), '<?php echo "ok";\n');
w(path.join(phpPortRoot, 'composer.json'), JSON.stringify({ require: { 'slim/slim': '^4' } }));
fs.mkdirSync(path.join(phpPortRoot, 'public'), { recursive: true });
w(path.join(phpPortRoot, 'public/index.php'), '<?php echo "ok";\n');
w(path.join(phpPortRoot, '.env.local'), 'PORT=8088\n');

await check('detect 补齐 dev:*、前端框架、Python 依赖标记、venv、Go、.NET 与 profile 端口', async () => {
  const r = await run(['detect', '--root', detectMoreRoot, '--json']);
  assert.equal(r.code, 0, r.text);
  const rows = r.json.data.candidates;
  const notes = r.json.data.notes;
  const inRoot = (dir) => rows.filter((x) => x.desc.root === dir);

  const devStar = inRoot(devStarRoot);
  assert.equal(devStar.length, 1, `pnpm dev:* 候选数：${devStar.length}`);
  assert.equal(devStar[0].desc.command, 'pnpm run dev:web');
  assert.match(devStar[0].evidence.rule, /package-script:dev:web/);
  assert.match(devStar[0].evidence.rule, /dependency:vite/);
  assert.match(devStar[0].evidence.rule, /pm:pnpm/);
  assert.equal(devStar[0].desc.expectedPort, 4321);
  assert.match(devStar[0].evidence.rule, /port:4321\(\.env\.local:PORT\)/);

  assert.equal(inRoot(unsafeDevRoot).length, 0, '含 shell 元字符的 dev:* 不得生成候选');
  assert(notes.some((n) => n.file.endsWith('dev-unsafe-app/package.json') && /shell 元字符/.test(n.suggestion)), '应提示脚本名不安全');

  for (const [name, dep] of frameworkFixtures) {
    const dir = path.join(detectMoreRoot, name);
    const found = inRoot(dir);
    assert.equal(found.length, 1, `${name} 候选数：${found.length}`);
    assert.equal(found[0].confidence, 'high');
    assert.match(found[0].evidence.rule, new RegExp(`dependency:${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }

  const poetry = inRoot(poetryRoot);
  assert.equal(poetry.length, 1, `poetry 不应因 pyproject + poetry.lock 生成重复候选：${poetry.length}`);
  assert.match(poetry[0].evidence.rule, /^django-manage\.py/);
  assert.match(poetry[0].evidence.rule, /deps:poetry\.lock/);
  assert.equal(poetry[0].desc.command, isWindows ? 'python manage.py runserver' : 'python3 manage.py runserver');
  assert.equal(poetry[0].desc.expectedImage, isWindows ? 'python.exe' : 'python3');

  const uv = inRoot(uvRoot);
  assert.equal(uv.length, 1, `uv 不应因 pyproject + uv.lock 生成重复候选：${uv.length}`);
  assert.match(uv[0].evidence.rule, /^fastapi-uvicorn:main:app/);
  assert.match(uv[0].evidence.rule, /deps:uv\.lock/);
  assert.equal(uv[0].desc.command, isWindows ? 'python -m uvicorn main:app' : 'python3 -m uvicorn main:app');
  assert.equal(uv[0].desc.expectedImage, isWindows ? 'python.exe' : 'python3');

  const venv = inRoot(venvRoot);
  assert.equal(venv.length, 1);
  assert.equal(venv[0].desc.command, `${venvPython} -m flask --app app run`);
  assert.equal(venv[0].desc.expectedImage, venvImage, 'expectedImage 应解析 venv 符号链接到真实解释器映像名');
  assert(venv[0].evidence.rule.includes('interpreter:venv(.venv'));

  const go = inRoot(goRoot);
  assert.equal(go.length, 1);
  assert(go[0].desc.command.includes('go build -o '), `Go 候选应显式构建产物：${go[0].desc.command}`);
  assert(go[0].desc.command.includes('goapp'), '构建产物名应含模块名');
  assert.equal(go[0].desc.mode, 'proc');
  assert.equal(go[0].desc.expectedImage, `goapp${isWindows ? '.exe' : ''}`);
  assert.match(go[0].evidence.rule, /^go-module:\.; build:goapp/);

  const outerGo = inRoot(goNestedRoot);
  assert.equal(outerGo.length, 1, `外层 Go 模块不得纳入嵌套模块入口：${outerGo.length}`);
  assert.match(outerGo[0].evidence.rule, /^go-module:\.; build:outer/);
  assert(!outerGo[0].desc.command.includes('nested'), '外层候选不得执行嵌套模块');
  const nestedGo = inRoot(path.join(goNestedRoot, 'nested'));
  assert.equal(nestedGo.length, 1, `嵌套 Go 模块应独立产出候选：${nestedGo.length}`);
  assert.match(nestedGo[0].evidence.rule, /^go-module:\.; build:nested/);

  const dotnet = inRoot(dotnetRoot);
  assert.equal(dotnet.length, 1);
  assert.equal(dotnet[0].desc.command, 'dotnet run');
  assert.equal(dotnet[0].desc.mode, 'proc');
  assert.equal(dotnet[0].desc.expectedImage, `DotnetApp${isWindows ? '.exe' : ''}`);
  assert.match(dotnet[0].evidence.rule, /^dotnet-csproj:web/);

  const dotnetNoApphost = inRoot(dotnetNoApphostRoot);
  assert.equal(dotnetNoApphost.length, 1);
  assert.equal(dotnetNoApphost[0].desc.command, 'dotnet run');
  assert.equal(dotnetNoApphost[0].desc.expectedImage, `dotnet${isWindows ? '.exe' : ''}`, 'UseAppHost=false 时目标映像是 dotnet host');
  assert.match(dotnetNoApphost[0].evidence.rule, /^dotnet-csproj:web; apphost:false/);

  const dotnetPropsApphost = inRoot(dotnetPropsApphostRoot);
  assert.equal(dotnetPropsApphost.length, 1);
  assert.equal(dotnetPropsApphost[0].desc.expectedImage, `dotnet${isWindows ? '.exe' : ''}`, 'Directory.Build.props 的 UseAppHost=false 也必须生效');
  assert.match(dotnetPropsApphost[0].evidence.rule, /^dotnet-csproj:web; apphost:false/);

  const dotnetImportApphost = inRoot(dotnetImportApphostRoot);
  assert.equal(dotnetImportApphost.length, 1);
  assert.equal(dotnetImportApphost[0].desc.expectedImage, `dotnet${isWindows ? '.exe' : ''}`, 'Import 文件的 UseAppHost=false 也必须生效');
  assert.match(dotnetImportApphost[0].evidence.rule, /^dotnet-csproj:web; apphost:false/);

  const springProfile = inRoot(springProfileRoot);
  assert.equal(springProfile.length, 1);
  assert.equal(springProfile[0].desc.expectedPort, 9091);
  assert.match(springProfile[0].evidence.rule, /application-dev\.yml:server\.port/);

  const springInactive = inRoot(springInactiveProfileRoot);
  assert.equal(springInactive.length, 1);
  assert.equal(springInactive[0].desc.expectedPort, 8080, '未激活 profile 时不得采用 profile 端口');
  assert.match(springInactive[0].evidence.rule, /application\.yml:server\.port/);

  const springProfileOnly = inRoot(springProfileOnlyRoot);
  assert.equal(springProfileOnly.length, 1);
  assert.equal(springProfileOnly[0].desc.expectedPort, undefined, '仅有未激活 profile 时不得报告端口');
  assert(!springProfileOnly[0].evidence.rule.includes('application-dev.yml'), '未激活 profile 不得进入端口证据');

  for (const dir of invalidEnvPortRoots) {
    const found = inRoot(dir);
    assert.equal(found.length, 1, `无效环境端口 fixture 应有候选：${dir}`);
    assert.equal(found[0].desc.expectedPort, undefined, `越界环境端口不得输出：${dir}`);
    assert(!found[0].evidence.rule.includes('port:'), `越界环境端口不得进入证据：${found[0].evidence.rule}`);
  }
  for (const dir of invalidSpringPortRoots) {
    const found = inRoot(dir);
    assert.equal(found.length, 1, `无效 Spring 端口 fixture 应有候选：${dir}`);
    assert.equal(found[0].desc.expectedPort, undefined, `越界 Spring 端口不得输出：${dir}`);
    assert(!found[0].evidence.rule.includes('port:'), `越界 Spring 端口不得进入证据：${found[0].evidence.rule}`);
  }

  const pipfile = inRoot(pipfileRoot);
  assert.equal(pipfile.length, 1);
  assert.match(pipfile[0].evidence.rule, /^django-manage\.py/);
  assert.match(pipfile[0].evidence.rule, /deps:Pipfile/);

  const setupPy = inRoot(setupPyRoot);
  assert.equal(setupPy.length, 1);
  assert.match(setupPy[0].evidence.rule, /^fastapi-uvicorn:main:app/);
  assert.match(setupPy[0].evidence.rule, /deps:setup\.py/);

  const cargo = inRoot(cargoRoot);
  assert.equal(cargo.length, 1);
  assert.equal(cargo[0].desc.command, 'cargo run');
  assert.equal(cargo[0].desc.mode, 'proc');
  assert.equal(cargo[0].desc.expectedImage, `cargo-app${isWindows ? '.exe' : ''}`);
  assert.match(cargo[0].evidence.rule, /^cargo-package:cargo-app$/);

  const cargoCustom = inRoot(cargoCustomRoot);
  assert.equal(cargoCustom.length, 1);
  assert.equal(cargoCustom[0].desc.command, 'cargo run --bin custom-server');
  assert.equal(cargoCustom[0].desc.expectedImage, `custom-server${isWindows ? '.exe' : ''}`);
  assert.match(cargoCustom[0].evidence.rule, /^cargo-bin:custom-server$/);

  assert.equal(inRoot(cargoMultiRoot).length, 0, '多个 [[bin]] 不得生成无法唯一启动的候选');
  assert(notes.some((n) => n.file.endsWith('cargo-multi-bin-app/Cargo.toml') && /多个 \[\[bin\]\]/.test(n.suggestion)), '应提示 Cargo 多 bin 歧义');

  assert.equal(inRoot(cargoNestedAutoRoot).length, 0, 'src/bin/<name>/main.rs 也必须计入 Cargo bin 歧义');
  assert(notes.some((n) => n.file.endsWith('cargo-nested-auto-bin-app/Cargo.toml') && /多个可运行 bin/.test(n.suggestion) && /server/.test(n.suggestion)), '应提示嵌套自动 bin 歧义');

  assert.equal(inRoot(phpNoPortRoot).length, 0, '无端口证据的 PHP 入口不得默认绑定 8000');
  assert(notes.some((n) => n.file.endsWith('php-no-port-app/composer.json') && /未发现端口证据/.test(n.suggestion)), '应提示 PHP 入口缺端口证据');
  const phpPort = inRoot(phpPortRoot);
  assert.equal(phpPort.length, 1);
  assert.equal(phpPort[0].desc.command, 'php -S 127.0.0.1:8088 -t public');
  assert.equal(phpPort[0].desc.expectedPort, 8088);
  assert.match(phpPort[0].evidence.rule, /port:8088\(\.env\.local:PORT\)/);

  const composer = inRoot(composerRoot);
  assert.equal(composer.length, 1);
  assert.equal(composer[0].desc.command, 'php artisan serve');
  assert.equal(composer[0].desc.mode, 'proc');
  assert.equal(composer[0].desc.expectedImage, `php${isWindows ? '.exe' : ''}`);
  assert.match(composer[0].evidence.rule, /^composer-laravel:artisan$/);
  assert(rows.every((x) => x.confidence && x.evidence.file && x.evidence.rule));
});

// ---------- start/restart --dry-run：只读启动计划 ----------
await check('start --dry-run 输出解析计划且 home 零写入；envRefs 只报命中不回显值', async () => {
  const secret = 'pr-cli-dry-secret-113';
  process.env.PR_DRY_SECRET = secret;
  const before = homeSnapshot();
  const r = await run(['start', 'dry', '--dry-run', '--json']);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.json.data.dryRun, true);
  assert.equal(r.json.data.appId, 'adry');
  assert.equal(r.json.data.cwd, root);
  const expectedExe = isWindows ? path.resolve(process.execPath) : fs.realpathSync.native(process.execPath);
  assert.equal(r.json.data.exe, expectedExe);
  assert.deepEqual(r.json.data.envRefs, [
    { name: 'PR_DRY_SECRET', present: true },
    { name: 'PR_DRY_MISSING', present: false },
  ]);
  assert(!r.text.includes(secret), 'dry-run 不得回显 envRefs 值');
  assert.deepEqual(homeSnapshot(), before, 'dry-run 不得写 registry/runtime/locks/logs');
});
await check('start --dry-run command 模式输出命令形态但只显示不落盘', async () => {
  const before = homeSnapshot();
  const r = await run(['start', 'drycmd', '--dry-run', '--json']);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.json.data.kind, 'command');
  assert.equal(r.json.data.command, 'node server.js');
  assert.equal(r.json.data.expectedImage, isWindows ? 'node.exe' : 'node');
  assert.equal(r.json.data.exe, null);
  assert.deepEqual(homeSnapshot(), before, 'command dry-run 不得落盘命令或运行记录');
});
await check('restart --dry-run 输出停止+启动计划且 home 零写入', async () => {
  const before = homeSnapshot();
  const r = await run(['restart', 'dry', '--dry-run', '--json']);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.json.data.dryRun, true);
  assert.equal(r.json.data.stop.expected, 'alreadyStopped');
  assert.equal(r.json.data.stop.runId, 'rdry1');
  assert.equal(r.json.data.start.alias, 'dry');
  assert.deepEqual(homeSnapshot(), before, 'restart dry-run 不得停止旧实例或写数据目录');
});
if (probeOk) {
  await check('start --dry-run 对非法 cwd 与正常 start 同口径（CONFIG_INVALID）', async () => {
    const dry = await run(['start', 'badcwd', '--dry-run', '--json']);
    const real = await run(['start', 'badcwd', '--json']);
    assert.equal(dry.code, 3, dry.text);
    assert.equal(real.code, 3, real.text);
    assert.equal(dry.json.error.code, 'CONFIG_INVALID');
    assert.equal(real.json.error.code, 'CONFIG_INVALID');
    assert.equal(dry.json.error.message, real.json.error.message);
  });
}

// ---------- status/list --watch ----------

await check('--watch --interval 越界/非整数、--interval 缺 --watch 均为 usageError', async () => {
  for (const args of [
    ['status', 'ok', '--watch', '--interval', '100'],
    ['status', 'ok', '--watch', '--interval', '499'],
    ['status', 'ok', '--watch', '--interval', '60001'],
    ['status', 'ok', '--watch', '--interval', '500.5'],
    ['list', '--watch', '--interval', '0'],
    ['status', 'ok', '--interval', '1000'],
  ]) {
    const r = await run([...args, '--json']);
    assert.equal(r.code, 1, `${args.join(' ')} 应为退出码 1：${r.text}`);
    assert.equal(r.json.error.code, 'USAGE', `${args.join(' ')} 错误码`);
  }
});

await check('status --watch --json 输出 NDJSON 帧流，--probe/--ready 每帧带证据，管道断开干净退出', async () => {
  const w = await watchCollect(['status', 'ok', '--watch', '--interval', '500', '--probe', '--ready'], {
    until: (lines) => lines.length >= 2,
  });
  assert.equal(w.code, 0, `管道断开应退出码 0：${w.stderr}`);
  assert.equal(w.signal, null);
  const frames = w.lines.slice(0, 2).map((line) => JSON.parse(line));
  for (const f of frames) {
    assert.equal(f.schemaVersion, 1);
    assert.equal(f.ok, true);
    assert.equal(f.command, 'status');
    assert.equal(f.data.alias, 'ok');
    assert.equal(Object.hasOwn(f.data, 'portListening'), true, '--probe 帧缺 portListening');
    assert.equal(f.data.readiness.state, 'UNTESTED', '--ready 帧缺就绪证据');
  }
});

await check('list --watch --json 输出全应用快照帧，管道断开干净退出', async () => {
  const w = await watchCollect(['list', '--watch', '--interval', '500'], {
    until: (lines) => lines.length >= 2,
  });
  assert.equal(w.code, 0, `管道断开应退出码 0：${w.stderr}`);
  const frames = w.lines.slice(0, 2).map((line) => JSON.parse(line));
  for (const f of frames) {
    assert.equal(f.ok, true);
    assert.equal(f.command, 'list');
    assert(f.data.apps.some((a) => a.alias === 'ok'), 'list 帧缺全应用快照');
  }
});

await check('status --watch 人类非 TTY 模式逐帧输出并注明', async () => {
  const w = await watchCollect(['status', 'ok', '--watch', '--interval', '500'], {
    human: true,
    until: (lines) => lines[0]?.includes('非 TTY') && lines.some((l) => l.includes('status=STOPPED')),
  });
  assert.equal(w.code, 0, `管道断开应退出码 0：${w.stderr}`);
  assert(w.lines[0].includes('逐帧输出'), w.lines[0]);
});

if (!isWindows) {
  await check('status --watch 收到 SIGINT 干净退出且不残留锁', async () => {
    const locksBefore = fs.readdirSync(path.join(home, 'locks')).sort();
    const w = await watchCollect(['status', 'ok', '--watch', '--interval', '500'], {
      interrupt: true,
      until: (lines) => lines.length >= 1,
    });
    assert.equal(w.code, 0, `SIGINT 应退出码 0：${w.stderr}`);
    assert.equal(w.signal, null);
    assert.deepEqual(fs.readdirSync(path.join(home, 'locks')).sort(), locksBefore, 'SIGINT 后不应新增锁');
  });
}

// ---------- logs 统一日志源 ----------

await check('list-sources：JSON 输出与 ui 同一数据（hint + .tmp + 批次）', async () => {
  const ls = await run(['logs', 'unman', '--list-sources', '--json']);
  assert.equal(ls.code, 0);
  assert.equal(ls.json.ok, true);
  assert.equal(ls.json.command, 'logs');
  const srcs = ls.json.data.sources.map((s) => s.src);
  assert(srcs.some((s) => /^hint:[0-9a-f]{12}$/.test(s)), `缺 hint:<hash> 线索源：${srcs.join(',')}`);
  assert(srcs.some((s) => s.startsWith('tmp:jrebel-local-')), `缺 .tmp 兼容日志：${srcs.join(',')}`);
});
await check('list-sources：受管应用列批次源，人类可读输出可用', async () => {
  const ls = await run(['logs', 'ok', '--list-sources']);
  assert.equal(ls.code, 0);
  assert(ls.text.includes('run:rkeep1.stdout'));
  assert(ls.text.includes('run:rold1.stdout'));
  assert(ls.text.includes('merge:rkeep1'), '应列出双流合并源');
});
await check('--src hint:<hash> 与 ui 同源同内容', async () => {
  const ls = await run(['logs', 'unman', '--list-sources', '--json']);
  const hintSrc = ls.json.data.sources.find((s) => s.src.startsWith('hint:'))?.src;
  assert(hintSrc, '应有 hint:<hash> 线索源');
  const hint = await run(['logs', 'unman', '--src', hintSrc, '--json']);
  assert.equal(hint.code, 0);
  const t = mgr.resolveSource(home, 'unman', hintSrc); // ui /api/tail 用同一解析
  assert.equal(hint.json.data.file, t.file);
  assert.equal(hint.json.data.src, hintSrc);
  assert.equal(hint.json.data.lines.join('\n'), fs.readFileSync(t.file, 'utf8').trimEnd());
});
await check('--src tmp:<name> 与 ui 同源同内容', async () => {
  const tmpLog = await run(['logs', 'unman', '--src', 'tmp:jrebel-local-20261020-100000.stdout.log', '--json']);
  assert.equal(tmpLog.code, 0);
  const t = mgr.resolveSource(home, 'unman', 'tmp:jrebel-local-20261020-100000.stdout.log');
  assert.equal(tmpLog.json.data.file, t.file);
  assert.equal(tmpLog.json.data.lines.join('\n'), fs.readFileSync(t.file, 'utf8').trimEnd());
});
await check('--src run:<历史批次> 与轮转日志可读', async () => {
  const r = await run(['logs', 'ok', '--src', 'run:rkeep2.stdout', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.lines, ['keep2 stdout']);
  const rotated = await run(['logs', 'ok', '--src', 'run:rkeep1.stdout.1', '--json']);
  assert.equal(rotated.code, 0);
  assert.deepEqual(rotated.json.data.lines, ['rotated keep1 stdout']);
});
await check('--src merge:<runId> 同时读取双流并给 stderr 加 [err] 前缀', async () => {
  const r = await run(['logs', 'ok', '--src', 'merge:rkeep1', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.data.merged, true);
  assert.equal(r.json.data.stream, 'both');
  assert(r.json.data.lines.includes('keep1 stdout A'));
  assert(r.json.data.lines.includes('[err] keep1 stderr E1'));
  assert(r.json.data.orderNote.includes('近似'));
  assert.equal(r.json.data.missingStreams.length, 0);
  assert.equal((await run(['logs', 'ok', '--src', 'merge:rkeep1', '--follow'])).code, 1);
});
await check('--src 与 --lines 组合有界读取', async () => {
  const r = await run(['logs', 'ok', '--src', 'run:rkeep1.stdout', '--lines', '1', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.lines, ['keep1 stdout B']);
  assert.equal(r.json.data.truncated, true);
});
await check('--src 与 --run/--stream、--list-sources 与 --run 互斥（退出码 1）', async () => {
  assert.equal((await run(['logs', 'ok', '--src', 'run:rkeep1.stdout', '--run', 'rkeep1'])).code, 1);
  assert.equal((await run(['logs', 'ok', '--src', 'run:rkeep1.stdout', '--stream', 'stderr'])).code, 1);
  assert.equal((await run(['logs', 'ok', '--list-sources', '--run', 'rkeep1'])).code, 1);
});
await check('--stream both 合并双流（JSON 带流标记）', async () => {
  const both = await run(['logs', 'ok', '--stream', 'both', '--run', 'rkeep1', '--json']);
  assert.equal(both.code, 0);
  assert.equal(both.json.data.stream, 'both');
  const lines = both.json.data.lines;
  assert(lines.some((l) => l.stream === 'stdout' && l.line === 'keep1 stdout A'));
  assert(lines.some((l) => l.stream === 'stderr' && l.line === 'keep1 stderr E1'));
  assert.deepEqual(both.json.data.missingStreams, []);
});
await check('--stream both 人类可读输出带流前缀', async () => {
  const both = await run(['logs', 'ok', '--stream', 'both', '--run', 'rkeep1']);
  assert.equal(both.code, 0);
  assert(both.text.includes('[stdout] keep1 stdout A'));
  assert(both.text.includes('[stderr] keep1 stderr E1'));
});
await check('--stream both + --follow、--follow + --json 退出码 1', async () => {
  assert.equal((await run(['logs', 'ok', '--stream', 'both', '--follow'])).code, 1);
  assert.equal((await run(['logs', 'ok', '--follow', '--json'])).code, 1);
});
await check('非受管默认 logs 报错并指引 --src hint:<hash>（退出码 2）', async () => {
  const r = await run(['logs', 'unman']);
  assert.equal(r.code, 2);
  assert(r.text.includes('非受管'));
  assert(r.text.includes('nohup.out'));
  assert(r.text.includes('--src hint:<hash>'));
});

// ---------- prune ----------

await check('prune 默认 dry-run：列出将删内容且不删除任何文件', async () => {
  const pd = await run(['prune', '--json']);
  assert.equal(pd.code, 0, pd.text);
  assert.equal(pd.json.ok, true);
  assert.equal(pd.json.data.dryRun, true);
  if (probeOk) {
    const files = pd.json.data.logs.flatMap((a) => a.files).map((f) => f.file);
    assert(files.includes(path.join(aokLogs, 'rold1.stdout.log')), `应列出超保留期日志：${files.join(',')}`);
    assert(files.includes(path.join(aokLogs, 'rold1.stdout.log.1')), `应列出超保留期轮转日志：${files.join(',')}`);
    assert(files.includes(path.join(aokLogs, 'rold2.stderr.log')));
    assert(files.includes(path.join(aokLogs, '.rold1.pid')), `应列出超保留期运行元文件：${files.join(',')}`);
    assert(files.includes(path.join(aokLogs, '.rold1.sink.json')));
  } else {
    assert(pd.json.data.skipped.some((s) => s.kind === 'logs' && s.reason.includes('PWSH_MISSING')));
  }
  assert(pd.json.data.staleLocks.some((f) => f.file.endsWith('azombie.lock.stale-1700000000000')));
  assert(pd.json.data.tmpOrphans.some((f) => f.file === oldTmp1));
  assert(pd.json.data.tmpOrphans.some((f) => f.file === oldTmp2));
  assert(pd.json.data.skipped.some((s) => s.kind === 'tmp' && s.target === recentTmp));
  if (externalPruneFiles.length) {
    const files = pd.json.data.logs.flatMap((a) => a.files).map((f) => f.file);
    assert(!files.includes(path.join(aokLogs, 'rold3.stdout.log')), 'dry-run must skip symlinked log files');
    assert(pd.json.data.skipped.some((s) => s.target === path.join(home, 'logs', 'asymlink')), 'dry-run must report symlinked log directories');
  }
  assert(fs.existsSync(path.join(aokLogs, 'rold1.stdout.log')), 'dry-run 不得删除文件');
  assert(fs.existsSync(path.join(home, 'locks', 'azombie.lock.stale-1700000000000')));
});
await check('prune --dry-run 与 --apply 互斥（退出码 1）', async () => {
  assert.equal((await run(['prune', '--dry-run', '--apply'])).code, 1);
});
await check('prune --apply：回收超保留期日志、死锁残留与孤儿临时文件', async () => {
  const pa = await run(['prune', '--apply', '--json']);
  assert.equal(pa.code, 0, pa.text);
  assert.equal(pa.json.data.dryRun, false);
  if (probeOk) {
    assert(!fs.existsSync(path.join(aokLogs, 'rold1.stdout.log')));
    assert(!fs.existsSync(path.join(aokLogs, 'rold1.stdout.log.1')));
    assert(!fs.existsSync(path.join(aokLogs, 'rold2.stderr.log')));
    assert(!fs.existsSync(path.join(aokLogs, '.rold1.pid')));
    assert(!fs.existsSync(path.join(aokLogs, '.rold1.sink.json')));
  }
  assert(!fs.existsSync(path.join(home, 'locks', 'azombie.lock.stale-1700000000000')));
  assert(!fs.existsSync(oldTmp1));
  assert(!fs.existsSync(oldTmp2));
  for (const file of externalPruneFiles) assert(fs.existsSync(file), `prune must not delete outside file ${file}`);
  if (externalPruneFiles.length) {
    assert(fs.lstatSync(path.join(home, 'logs', 'asymlink')).isSymbolicLink());
    assert(fs.lstatSync(path.join(aokLogs, 'rold3.stdout.log')).isSymbolicLink());
  }
});
await check('prune 不删 current/保留期日志、证据与非残留文件', () => {
  assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stdout.log')));
  assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stdout.log.1')));
  assert(fs.existsSync(path.join(aokLogs, '.rkeep1.pid')), '保留期的运行元文件不得删除');
  assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stderr.log')));
  assert(fs.existsSync(path.join(aokLogs, 'rkeep2.stdout.log')));
  assert(fs.existsSync(path.join(aokLogs, 'notes.txt')));
  assert(fs.existsSync(path.join(home, 'locks', 'alive.lock')), '普通 .lock 不可回收');
  assert(fs.existsSync(recentTmp), '近期临时文件跳过');
  for (const f of ['aok', 'astuck', 'aun']) assert(fs.existsSync(path.join(home, 'runtime', `${f}.json`)));
  assert(fs.existsSync(path.join(home, 'registry.json')));
});
await check('损坏运行记录按 DATA_CORRUPT 整体拒绝且不删任何文件', async () => {
  w(path.join(home, 'runtime', 'acorrupt.json'), '{broken json');
  fs.mkdirSync(path.join(home, 'logs', 'acorrupt'), { recursive: true });
  w(path.join(home, 'logs', 'acorrupt', 'rx1.stdout.log'), 'corrupt app log\n');
  w(path.join(aokLogs, 'rold9.stdout.log'), 'old9 beyond retention\n');
  const stale2 = path.join(home, 'locks', 'zombie2.lock.stale-42');
  const oldTmp3 = path.join(home, 'runtime', '.tmp-42-aaaa');
  w(stale2, 'x');
  w(oldTmp3, 'x');
  fs.utimesSync(oldTmp3, oldTime, oldTime);
  const pc = await run(['prune', '--json']);
  assert.equal(pc.code, 5, `应退出码 5：${pc.text}`);
  assert.equal(pc.json.error.code, 'DATA_CORRUPT');
  assert(fs.existsSync(path.join(aokLogs, 'rold9.stdout.log')), 'DATA 错误时不得删除');
  assert(fs.existsSync(path.join(home, 'logs', 'acorrupt', 'rx1.stdout.log')));
  assert(fs.existsSync(stale2));
  assert(fs.existsSync(oldTmp3));
});

// ---------- remove ----------

if (probeOk) {
  await check('remove 缺 ref / 未知 ref 退出码 1/2', async () => {
    assert.equal((await run(['remove'])).code, 1);
    const r0 = await run(['remove', 'nope', '--json']);
    assert.equal(r0.code, 2);
    assert.equal(r0.json.error.code, 'NOT_FOUND');
  });
  await check('remove RUNNING 受管实例拒绝（退出码 3 INSTANCE_RUNNING）', async () => {
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const identity = psProc('capture', { id: live.pid });
      assert.equal(identity.result, 'ok');
      rt('arun', {
        runId: 'rrun1', phase: 'RUNNING', managed: true, mode: 'java', intentAt: now, startedAt: now,
        pid: live.pid, creationFileTime: identity.creationFileTime, image: identity.image, envResolved: [],
        logPaths: { stdout: path.join(home, 'logs', 'arun', 'rrun1.stdout.log'), stderr: null },
        lastError: null, endedAt: null,
      });
      const r6 = await run(['remove', 'busy', '--json']);
      assert.equal(r6.code, 3, r6.text);
      assert.equal(r6.json.error.code, 'INSTANCE_RUNNING');
      assert(registryOnDisk().apps.arun, '拒绝时注册表不得变化');
    } finally {
      live.kill();
      await new Promise((res) => live.on('exit', res));
    }
  });
  await check('确认退出后再 remove 成功；运行证据保留', async () => {
    const r7 = await run(['remove', 'busy', '--json']);
    assert.equal(r7.code, 0, r7.text);
    assert.equal(r7.json.data.removed, true);
    const rtArun = JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'arun.json'), 'utf8'));
    assert.equal(rtArun.current.phase, 'STOPPED', 'RUNNING→STOPPED 应按 OS 事实落账');
    assert(fs.existsSync(path.join(home, 'logs', 'arun', 'rrun1.stdout.log')));
  });
  const astuckBefore = fs.readFileSync(path.join(home, 'runtime', 'astuck.json'), 'utf8');
  await check('remove 未结记录默认拒绝（UNRESOLVED_RUN 退出码 3）', async () => {
    const r1 = await run(['remove', 'stuck', '--json']);
    assert.equal(r1.code, 3, r1.text);
    assert.equal(r1.json.error.code, 'UNRESOLVED_RUN');
    assert(registryOnDisk().apps.astuck, '拒绝时注册表不得变化');
    assert.equal(fs.readFileSync(path.join(home, 'runtime', 'astuck.json'), 'utf8'), astuckBefore);
  });
  await check('remove --ack-unresolved runId 不一致拒绝（ACK_MISMATCH）', async () => {
    const r2 = await run(['remove', 'stuck', '--ack-unresolved', 'rwrong1', '--json']);
    assert.equal(r2.code, 3);
    assert.equal(r2.json.error.code, 'ACK_MISMATCH');
  });
  await check('remove --ack-unresolved 通过后移除；证据归档保留', async () => {
    const r3 = await run(['remove', 'stuck', '--ack-unresolved', 'rstuck1', '--json']);
    assert.equal(r3.code, 0, r3.text);
    assert.equal(r3.json.data.abandonedRunId, 'rstuck1');
    assert.equal(r3.json.data.abandonedReason, 'abandoned-by-ack');
    assert(!registryOnDisk().apps.astuck, '注册表条目应已移除');
    const rtStuck = JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'astuck.json'), 'utf8'));
    assert.equal(rtStuck.current, null);
    assert.equal(rtStuck.prevRuns[0].runId, 'rstuck1');
    assert.equal(rtStuck.prevRuns[0].archiveReason, 'abandoned-by-ack');
  });
  await check('remove 非受管登记直接移除；运行记录保留', async () => {
    const r4 = await run(['remove', 'unman', '--json']);
    assert.equal(r4.code, 0, r4.text);
    assert(!registryOnDisk().apps.aun);
    assert(fs.existsSync(path.join(home, 'runtime', 'aun.json')));
  });
  await check('remove 后 list 不再显示该应用；日志证据保留', async () => {
    const r5 = await run(['remove', 'ok', '--json']);
    assert.equal(r5.code, 0, r5.text);
    const lst = await run(['list', '--json']);
    assert.equal(lst.code, 0);
    assert(!lst.json.data.apps.some((a) => a.alias === 'ok'), 'list 不应再显示已移除应用');
    assert(fs.existsSync(path.join(home, 'runtime', 'aok.json')));
    assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stdout.log')));
  });
} else {
  console.log('  skip（缺 pwsh 7：remove/prune 日志回收依赖应用锁与身份核验）');
}

fs.rmSync(base, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\ncli smoke ok');
