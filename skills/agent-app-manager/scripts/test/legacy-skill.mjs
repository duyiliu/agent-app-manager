import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveHome } from '../lib/home.mjs';
import { detectLegacySkills } from '../lib/legacy-skill.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-legacy-skill-'));
const manager = fileURLToPath(new URL('../manager.mjs', import.meta.url));
function fixture(name) {
  const userHome = path.join(base, name);
  fs.mkdirSync(userHome);
  return { userHome, old: path.join(userHome, '.project-runner'), next: path.join(userHome, '.agent-app-manager') };
}
function installSkill(userHome, root, name = 'project-runner') {
  const dir = path.join(userHome, root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n# fixture\n`);
  return dir;
}
function cli(f, ...args) {
  return spawnSync(process.execPath, [manager, '--json', ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: f.userHome, USERPROFILE: f.userHome }, timeout: 30000,
  });
}
try {
  // 1) 三个已知安装根都能识别；目录名相同但 SKILL.md 名称不同不认。
  const multi = fixture('multi');
  const codex = installSkill(multi.userHome, '.codex');
  const agents = installSkill(multi.userHome, '.agents');
  installSkill(multi.userHome, '.claude', 'another-skill');
  const plain = path.join(multi.userHome, '.claude', 'skills', 'project-runner');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'SKILL.md'), '---\nname: another-skill\n---\n');
  fs.mkdirSync(path.join(multi.userHome, '.codex', 'skills', 'project-runner-copy'));
  const found = detectLegacySkills({ userHome: multi.userHome });
  assert.deepEqual(found.map((s) => path.normalize(s.path)), [path.normalize(agents), path.normalize(codex)]);
  assert.equal(detectLegacySkills({ userHome: path.join(multi.userHome, 'absent') }).length, 0);

  // 2) migrate 报告旧 Skill，且不删除任何文件。
  let r = cli(multi, 'migrate', '--dry-run');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  let data = JSON.parse(r.stdout).data;
  assert.equal(data.legacySkills.length, 2);
  assert.equal(fs.existsSync(codex), true, 'dry-run 不删除旧 Skill');
  assert.equal(fs.existsSync(path.join(codex, 'SKILL.md')), true);

  // 3) 复制升级完成后在 stderr 提示旧 Skill，并保留旧 Skill 文件。
  fs.mkdirSync(multi.old);
  r = cli(multi, 'remove', 'missing-app');
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.equal(fs.existsSync(multi.next), true, '首次普通命令复制旧数据目录');
  assert.match(r.stderr, /旧版 Skill project-runner/);
  assert.match(r.stderr, /不会自动删除/);
  // 提示只给用户可自行执行的删除命令，不代执行。
  assert.match(r.stderr, process.platform === 'win32' ? /Remove-Item -Recurse -Force / : /rm -rf /);
  assert.equal(fs.readFileSync(path.join(codex, 'SKILL.md'), 'utf8').includes('project-runner'), true);
  assert.equal(fs.existsSync(multi.old), true);
  r = cli(multi, 'migrate');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(JSON.parse(r.stdout).data.reason, 'target_exists');
  assert.equal(JSON.parse(r.stdout).data.legacySkills.length, 2, '两个目录并存时仍报告旧 Skill');

  // 4) 普通命令默认目录首次运行提示一次，随后由标记文件抑制重复提示。
  const once = fixture('once');
  installSkill(once.userHome, '.codex');
  r = cli(once, 'remove', 'missing-app');
  assert.equal(r.status, 2, r.stdout || r.stderr);
  assert.match(r.stderr, /旧版 Skill project-runner/);
  const marker = path.join(once.next, '.legacy-skill-notice');
  assert.equal(fs.existsSync(marker), true);
  r = cli(once, 'remove', 'missing-app');
  assert.equal(r.status, 2, r.stdout || r.stderr);
  assert.doesNotMatch(r.stderr, /旧版 Skill project-runner/);

  // 5) 无旧 Skill 时只落标记、不产生提示。
  const clean = fixture('clean');
  r = cli(clean, 'remove', 'missing-app');
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /旧版 Skill/);
  assert.equal(fs.existsSync(path.join(clean.next, '.legacy-skill-notice')), true);

  // 6) 库内调用同样只提示一次；只读解析不落标记。
  const lib = fixture('lib');
  installSkill(lib.userHome, '.agents');
  const readOnlyHome = resolveHome(null, true, { userHome: lib.userHome });
  assert.equal(readOnlyHome, lib.next);
  assert.equal(fs.existsSync(path.join(lib.next, '.legacy-skill-notice')), false);
  resolveHome(null, false, { userHome: lib.userHome });
  assert.equal(fs.existsSync(path.join(lib.next, '.legacy-skill-notice')), true);

  console.log('legacy skill notice: all checks passed');
} finally {
  assert(path.resolve(base).startsWith(`${path.resolve(os.tmpdir())}${path.sep}aam-legacy-skill-`));
  fs.rmSync(base, { recursive: true, force: true });
}
