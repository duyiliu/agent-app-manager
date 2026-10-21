import fs from 'node:fs';

export const MAX_LOG_BYTES = 4 * 1024 * 1024;   // 单次读取的日志字节上限
export const MAX_LOG_LINES = 5000;

// 批次日志与启动元文件的文件名语法（logs/<appId>/ 下），prune 与 listSources 共用
export const RUN_LOG_FILE_RE = /^([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)\.log(?:\.1)?$/;
export const RUN_META_FILE_RE = /^\.([a-z0-9][a-z0-9-]{0,47})\.(pid|sink\.json)$/;

// 尾部窗口起点：默认 50-200 行的场景不需要读满 MAX_LOG_BYTES（#53），
// 行数不足时再按 4 倍向前扩展，直到覆盖文件开头或达到 maxBytes 上限。
const INITIAL_TAIL_WINDOW = 64 * 1024;

function decodeLogBuffer(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch {
    // 精简 ICU 的 Node 可能不带 GBK 解码器：回退 lossy UTF-8，不让读取失败。
    try { return new TextDecoder('gbk').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }
}

function splitLogLines(text) {
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  return all;
}

export function readTailLines(file, n, maxBytes = MAX_LOG_BYTES) {
  const want = Math.min(Math.max(1, n), MAX_LOG_LINES);
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  let start = 0;
  let all = [];
  try {
    let window = Math.min(INITIAL_TAIL_WINDOW, Math.max(size, 1));
    for (;;) {
      start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      all = splitLogLines(decodeLogBuffer(buf));
      if (all.length >= want || start === 0 || window >= maxBytes) break;
      window = Math.min(Math.max(window * 4, window + 1), maxBytes, size);
    }
  } finally {
    fs.closeSync(fd);
  }
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
