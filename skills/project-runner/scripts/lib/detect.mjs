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
  const aliasBase = path.basename(absoluteRoot).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24) || 'project';
  for (const rel of files.filter((f) => path.basename(f) === 'package.json')) {
    const pkg = readJson(rel);
    if (!pkg) continue;
    const scripts = pkg.scripts ?? {};
    const script = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string' && scripts[s].trim());
    if (!script) continue;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = ['vite', '@vue/cli-service', 'next', 'nuxt', '@angular/cli'].find((name) => deps[name]);
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
    candidates.push({ desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'node', command: `npm run ${script}`, expectedImage: 'node.exe' }, confidence: framework ? 'high' : 'medium', evidence: { file: rel, rule: `package-script:${script}${framework ? `; dependency:${framework}` : ''}` } });
  }
  for (const rel of files.filter((f) => path.basename(f) === 'pom.xml')) {
    const text = (() => { try { return fs.readFileSync(path.join(absoluteRoot, rel), 'utf8'); } catch { return ''; } })();
    if (!/<artifactId>spring-boot-maven-plugin<\/artifactId>|spring-boot-starter/.test(text)) continue;
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const wrapper = files.includes(path.posix.join(path.posix.dirname(rel), 'mvnw')) || files.includes(path.posix.join(path.posix.dirname(rel), 'mvnw.cmd'));
    const cmd = wrapper ? (process.platform === 'win32' ? 'mvnw.cmd spring-boot:run' : './mvnw spring-boot:run') : 'mvn spring-boot:run';
    const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
    candidates.push({ desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'java', command: cmd, expectedImage: 'java.exe' }, confidence: 'medium', evidence: { file: rel, rule: wrapper ? 'maven-spring-boot-wrapper' : 'maven-spring-boot-plugin' } });
  }
  for (const marker of ['requirements.txt', 'pyproject.toml']) {
    for (const rel of files.filter((f) => path.basename(f) === marker)) {
      const dir = path.posix.dirname(rel);
      const local = (name) => files.includes(path.posix.join(dir, name));
      let app = local('manage.py') ? null : local('app.py') ? 'app' : null;
      if (marker === 'pyproject.toml') {
        let text = ''; try { text = fs.readFileSync(path.join(absoluteRoot, rel), 'utf8'); } catch {}
        if (!/flask/i.test(text)) continue;
      }
      const django = local('manage.py');
      if (!app && !django) continue;
      const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
      const alias = `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
      const command = django ? 'python manage.py runserver' : `python -m flask --app ${app} run`;
      candidates.push({ desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'python', command, expectedImage: 'python.exe' }, confidence: 'medium', evidence: { file: rel, rule: django ? 'django-manage.py' : 'flask-app.py' } });
    }
  }
  for (const rel of files.filter((f) => path.basename(f) === 'go.mod')) {
    notes.push({ file: rel, suggestion: '检测到 Go 模块；请核对 main package 后选择 go run <入口>，或经授权先 go build 再直连产物。' });
  }
  return { candidates, notes, suggestion: candidates.length ? null : '未发现可确定的启动证据；请检查仓库说明、启动脚本和应用入口后再手工拟定 desc。' };
}
