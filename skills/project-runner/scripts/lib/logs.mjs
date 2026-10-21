import fs from 'node:fs';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_LINES = 5000;

export function readTailLines(file, n) {
  const want = Math.min(Math.max(1, n), MAX_LOG_LINES);
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - MAX_LOG_BYTES);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('gbk').decode(buf); }
  let all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  const lines = all.slice(-want);
  return { lines, truncated: start > 0 || all.length > want, skippedBytes: start };
}
