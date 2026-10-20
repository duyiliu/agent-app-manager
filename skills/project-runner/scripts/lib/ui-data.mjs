import fs from 'node:fs';
import path from 'node:path';

export const UI_FILE_CHUNK = 256 * 1024;
export const TMP_NAME_RE = /^jrebel-local-[^/\\]+\.(stdout|stderr)\.log$/;
export const uiBlocked = (name) => /^(\.git|node_modules|\.env.*|jrebel\.properties)$/i.test(name)
  || /\.(pem|key|p12|pfx|lic|keystore|jks)$/i.test(name)
  || /^(id_rsa|id_ed25519|credentials)(\..*)?$/i.test(name);
export const uiFail = (status, message) => Object.assign(new Error(message), { status });
export const uiInside = (base, file) => {
  const rel = path.relative(base, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
};

// Resolve a relative UI path while rejecting traversal, blocked names and symlinks.
export function uiResolveFile(base, rel = '') {
  if (rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel)
    || rel.split('/').some((p) => p === '..' || uiBlocked(p))) throw uiFail(403, '此路径不允许访问');
  const candidate = path.resolve(base, rel);
  if (!uiInside(base, candidate)) throw uiFail(403, '此路径不允许访问');
  let walk = base;
  for (const part of rel.split('/').filter(Boolean)) {
    walk = path.join(walk, part);
    if (fs.lstatSync(walk).isSymbolicLink()) throw uiFail(403, '不支持浏览符号链接');
  }
  const real = fs.realpathSync(candidate);
  if (!uiInside(base, real)) throw uiFail(403, '此路径不允许访问');
  return real;
}
