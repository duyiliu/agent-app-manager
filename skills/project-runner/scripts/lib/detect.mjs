// Read-only project detection: scan a repo for common launch evidence and emit
// start-desc candidates (detect command). Never writes registry or project files.
import fs from 'node:fs';
import path from 'node:path';
import { usageError } from './errors.mjs';

export function detectProjects(root) {
  let stat;
  try { stat = fs.statSync(root); } catch { throw usageError(`detect root 不存在：${root}`); }
  if (!stat.isDirectory()) throw usageError(`detect root 必须是目录：${root}`);
  const absoluteRoot = fs.realpathSync.native(root);
  const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv']);
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile()) files.push(path.relative(absoluteRoot, file).split(path.sep).join('/'));
      else if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
    }
  };
  walk(absoluteRoot, 0);
  const readJson = (rel) => {
    try { return JSON.parse(fs.readFileSync(path.join(absoluteRoot, rel), 'utf8')); } catch { return null; }
  };
  const candidates = [];
  const notes = [];
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const pythonExec = process.platform === 'win32' ? 'python' : 'python3';
  const aliasBase = path.basename(absoluteRoot).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24) || 'project';
  // expectedPort 推断：从常见配置文件读端口，并标注证据出处（不猜端口）。
  const inferPort = (dir) => {
    const read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; } };
    const env = read('.env');
    const mEnv = /^(?:PORT|SERVER_PORT)\s*=\s*(\d{2,5})\s*$/m.exec(env);
    if (mEnv) return { expectedPort: Number(mEnv[1]), source: '.env:PORT' };
    for (const cfg of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
      const text = read(cfg);
      // 先限定 server 段；裸 port: 也可能命中 preview.port（预览端口 ≠ dev 端口），
      // 命中但不在 server 段时标注歧义，由人工核对而非静默采信。
      const mServer = /server\s*:[\s\S]{0,300}?\bport\s*:\s*(\d{2,5})/.exec(text);
      if (mServer) return { expectedPort: Number(mServer[1]), source: `${cfg}:server.port` };
      const mAny = /\bport\s*:\s*(\d{2,5})/.exec(text);
      if (mAny) return { expectedPort: Number(mAny[1]), source: `${cfg}:port（未在 server 段，可能是 preview.port，请人工核对）` };
    }
    for (const cfg of ['src/main/resources/application.properties', 'application.properties']) {
      const m = /^\s*server\.port\s*=\s*(\d{2,5})\s*$/m.exec(read(cfg));
      if (m) return { expectedPort: Number(m[1]), source: `${cfg}:server.port` };
    }
    for (const cfg of ['src/main/resources/application.yml', 'src/main/resources/application.yaml', 'application.yml', 'application.yaml']) {
      const text = read(cfg);
      const m = /server\s*:[\s\S]{0,200}?port\s*:\s*(\d{2,5})/.exec(text);
      if (m) return { expectedPort: Number(m[1]), source: `${cfg}:server.port` };
    }
    return null;
  };

  // 包管理器判定：packageManager 字段优先，其次同目录 lock 文件。
  const nodePm = (dir, pkg) => {
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
    if (pm && ['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return { pm, source: 'packageManager' };
    const has = (name) => files.includes(path.posix.join(path.posix.dirname(dir), name));
    if (has('pnpm-lock.yaml')) return { pm: 'pnpm', source: 'pnpm-lock.yaml' };
    if (has('yarn.lock')) return { pm: 'yarn', source: 'yarn.lock' };
    if (has('bun.lockb') || has('bun.lock')) return { pm: 'bun', source: 'bun.lock' };
    if (has('package-lock.json')) return { pm: 'npm', source: 'package-lock.json' };
    return { pm: 'npm', source: null };
  };

  for (const rel of files.filter((f) => path.basename(f) === 'package.json')) {
    const pkg = readJson(rel);
    if (!pkg) continue;
    const scripts = pkg.scripts ?? {};
    const script = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string' && scripts[s].trim());
    if (!script) {
      // package.json 存在但没有可识别脚本：提示 bin/main 字段，不编造候选（#54）
      if (pkg.bin || pkg.main) {
        notes.push({ file: rel, suggestion: 'package.json 无 dev/start/serve 脚本；可核对 bin/main 字段或 README 的启动方式后手工拟定 desc。' });
      }
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = ['vite', '@vue/cli-service', 'next', 'nuxt', '@angular/cli'].find((name) => deps[name]);
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const { pm, source: pmSource } = nodePm(rel, pkg);
    const port = inferPort(projectRoot);
    const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'node', command: `${pm} run ${script}`, expectedImage: `node${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
      confidence: framework ? 'high' : 'medium',
      evidence: { file: rel, rule: `package-script:${script}${framework ? `; dependency:${framework}` : ''}${pmSource ? `; pm:${pm}(${pmSource})` : ''}${port ? `; port:${port.expectedPort}(${port.source})` : ''}` },
    });
  }
  for (const rel of files.filter((f) => path.basename(f) === 'pom.xml')) {
    const text = (() => { try { return fs.readFileSync(path.join(absoluteRoot, rel), 'utf8'); } catch { return ''; } })();
    if (!/<artifactId>spring-boot-maven-plugin<\/artifactId>|spring-boot-starter/.test(text)) continue;
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const wrapper = files.includes(path.posix.join(path.posix.dirname(rel), 'mvnw')) || files.includes(path.posix.join(path.posix.dirname(rel), 'mvnw.cmd'));
    const cmd = wrapper ? (process.platform === 'win32' ? 'mvnw.cmd spring-boot:run' : './mvnw spring-boot:run') : 'mvn spring-boot:run';
    const port = inferPort(projectRoot);
    const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
    candidates.push({ desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'java', command: cmd, expectedImage: `java${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) }, confidence: 'medium', evidence: { file: rel, rule: `${wrapper ? 'maven-spring-boot-wrapper' : 'maven-spring-boot-plugin'}${port ? `; port:${port.expectedPort}(${port.source})` : ''}` } });
  }
  // Gradle：settings/build.gradle(.kts) 含 spring-boot 插件 → bootRun；gradlew 优先。
  for (const rel of files.filter((f) => /^build\.gradle(\.kts)?$/.test(path.basename(f)))) {
    const text = (() => { try { return fs.readFileSync(path.join(absoluteRoot, rel), 'utf8'); } catch { return ''; } })();
    if (!/org\.springframework\.boot|spring-boot/.test(text)) continue;
    const dir = path.posix.dirname(rel);
    const projectRoot = path.resolve(absoluteRoot, dir);
    const wrapper = files.includes(path.posix.join(dir, 'gradlew')) || files.includes(path.posix.join(dir, 'gradlew.bat'));
    const cmd = wrapper ? (process.platform === 'win32' ? 'gradlew.bat bootRun' : './gradlew bootRun') : 'gradle bootRun';
    const port = inferPort(projectRoot);
    const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'java', command: cmd, expectedImage: `java${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
      confidence: 'medium',
      evidence: { file: rel, rule: wrapper ? 'gradle-spring-boot-wrapper' : 'gradle-spring-boot-plugin' },
    });
  }

  for (const marker of ['requirements.txt', 'pyproject.toml']) {
    for (const rel of files.filter((f) => path.basename(f) === marker)) {
      const dir = path.posix.dirname(rel);
      const local = (name) => files.includes(path.posix.join(dir, name));
      let app = local('manage.py') ? null : local('app.py') ? 'app' : null;
      let depText = '';
      if (marker === 'pyproject.toml' || marker === 'requirements.txt') {
        try { depText = fs.readFileSync(path.join(absoluteRoot, rel), 'utf8'); } catch {}
      }
      const django = local('manage.py') || /django/i.test(depText);
      const asgi = /fastapi|uvicorn/i.test(depText);
      if (marker === 'pyproject.toml' && !/flask|fastapi|uvicorn|django/i.test(depText)) continue;
      if (!app && !django && !asgi) continue;
      const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
      const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
      // FastAPI/uvicorn：在常见入口里找 ASGI app 变量名（app/api/application）
      let uvicornTarget = null;
      if (asgi && !django && !local('manage.py')) {
        for (const entry of ['main.py', 'app.py', 'server.py', 'asgi.py']) {
          const entryRel = path.posix.join(dir, entry);
          if (!files.includes(entryRel)) continue;
          let code = ''; try { code = fs.readFileSync(path.join(absoluteRoot, entryRel), 'utf8'); } catch {}
          const mv = /^(app|api|application)\s*=\s*(?:FastAPI|Starlette)\s*\(/m.exec(code);
          if (mv) { uvicornTarget = `${path.basename(entry, '.py')}:${mv[1]}`; break; }
        }
        if (!uvicornTarget) {
          notes.push({ file: rel, suggestion: '检测到 FastAPI/uvicorn 依赖但未定位 ASGI 入口；请核对形如 `uvicorn main:app` 的启动目标后手工拟定 desc。' });
          continue;
        }
      }
      const port = inferPort(projectRoot);
      const command = local('manage.py') ? `${pythonExec} manage.py runserver`
        : uvicornTarget ? `${pythonExec} -m uvicorn ${uvicornTarget}`
        : django ? `${pythonExec} manage.py runserver`
        : `${pythonExec} -m flask --app ${app} run`;
      candidates.push({
        desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'python', command, expectedImage: `python${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
        confidence: 'medium',
        evidence: { file: rel, rule: local('manage.py') ? 'django-manage.py' : uvicornTarget ? `fastapi-uvicorn:${uvicornTarget}` : django ? 'django-dep' : 'flask-app.py' },
      });
    }
  }
  for (const rel of files.filter((f) => path.basename(f) === 'go.mod')) {
    notes.push({ file: rel, suggestion: '检测到 Go 模块；请核对 main package 后选择 go run <入口>，或经授权先 go build 再直连产物。' });
  }
  // 入口文件低置信候选（#54）：仅在同目录尚无候选时给出，保持“未发现不编造”
  const hasCandidateFor = (dir) => candidates.some((c) => path.resolve(c.desc.root) === path.resolve(dir));
  for (const rel of files) {
    const base = path.basename(rel);
    const m = /^(server|app|main|index|run|start)\.(js|mjs|cjs|py)$/.exec(base);
    if (!m) continue;
    const projectRoot = path.resolve(absoluteRoot, path.posix.dirname(rel));
    if (hasCandidateFor(projectRoot)) continue;
    const isPy = m[2] === 'py';
    const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
    candidates.push({
      desc: {
        alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: isPy ? 'python' : 'node',
        command: `${isPy ? pythonExec : 'node'} ${base}`,
        expectedImage: isPy ? `${pythonExec}${exeSuffix}` : `node${exeSuffix}`,
      },
      confidence: 'low',
      evidence: { file: rel, rule: `entry-file:${base}` },
    });
  }
  return { candidates, notes, suggestion: candidates.length ? null : '未发现可确定的启动证据；请检查仓库说明、启动脚本和应用入口后再手工拟定 desc。' };
}
