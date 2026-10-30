// 旧 Skill 探测：只报告已知安装位置里的 project-runner，提示用户自行卸载，绝不自动删除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEGACY_SKILL_NAME = 'project-runner';

// skills 安装器的全局目录随 Agent 运行器不同；只探测这些已知位置，不遍历整个用户目录。
const SKILL_ROOTS = ['.agents/skills', '.codex/skills', '.claude/skills'];

function readSkillName(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const match = /^name:[ \t]*(.+)$/m.exec(text.slice(3, end));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

// 只认 SKILL.md 声明旧名称的目录，避免把同名但无关的目录当成旧版。
export function detectLegacySkills({ userHome = os.homedir() } = {}) {
  const found = [];
  for (const root of SKILL_ROOTS) {
    const dir = path.join(userHome, root, LEGACY_SKILL_NAME);
    let stat;
    try { stat = fs.statSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!stat.isDirectory()) continue;
    if (readSkillName(path.join(dir, 'SKILL.md')) !== LEGACY_SKILL_NAME) continue;
    found.push({ name: LEGACY_SKILL_NAME, path: dir });
  }
  return found;
}

// 只给命令，由用户自己执行；manager 不删除任何旧 Skill 文件。
export function legacySkillRemovalCommand(target, platform = process.platform) {
  return platform === 'win32'
    ? `Remove-Item -Recurse -Force "${target}"`
    : `rm -rf "${target}"`;
}

export function legacySkillNotice(skills, { platform = process.platform } = {}) {
  if (!skills?.length) return null;
  return [
    `发现旧版 Skill ${LEGACY_SKILL_NAME}（${skills.length} 处），不会自动删除。确认 agent-app-manager 可用后自行执行：`,
    ...skills.map((s) => `  ${legacySkillRemovalCommand(s.path, platform)}`),
  ].join('\n');
}

// 每次运行都提示会变成噪音：默认数据目录内落一个标记，只提醒一次。
export function noticeLegacySkillsOnce(home, { userHome = os.homedir() } = {}) {
  const marker = path.join(home, '.legacy-skill-notice');
  try { if (fs.existsSync(marker)) return null; } catch { return null; }
  let skills = [];
  try { skills = detectLegacySkills({ userHome }); } catch { skills = []; }
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n${skills.map((s) => s.path).join('\n')}\n`);
  } catch { /* 不可写时仍提示，不阻断命令 */ }
  const notice = legacySkillNotice(skills);
  if (notice) process.stderr.write(`${notice}\n`);
  return notice;
}
