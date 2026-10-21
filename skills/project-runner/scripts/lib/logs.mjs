import fs from 'node:fs';

export const MAX_LOG_BYTES = 4 * 1024 * 1024;   // 单次读取的日志字节上限
export const MAX_LOG_LINES = 5000;

// 批次日志与启动元文件的文件名语法（logs/<appId>/ 下），prune 与 listSources 共用
export const RUN_LOG_FILE_RE = /^([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)\.log(?:\.1)?$/;
export const RUN_META_FILE_RE = /^\.([a-z0-9][a-z0-9-]{0,47})\.(pid|sink\.json)$/;

export function readTailLines(file, n, maxBytes = MAX_LOG_BYTES) {
  const want = Math.min(Math.max(1, n), MAX_LOG_LINES);
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
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

// 启动失败诊断用的 stderr 尾部摘录：读不到/不存在时给空串，不阻塞主错误路径。
export function readStderrTailSafe(file) {
  try {
    return readTailLines(file, 20, 4 * 1024).lines.join('\n');
  } catch {
    return '';
  }
}
