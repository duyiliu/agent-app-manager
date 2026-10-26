import fs from 'node:fs';
import { decodeText } from './decode.mjs';

export const MAX_LOG_BYTES = 4 * 1024 * 1024;   // 单次读取的日志字节上限
export const MAX_LOG_LINES = 5000;

// 批次日志与启动元文件的文件名语法（logs/<appId>/ 下），prune 与 listSources 共用
export const RUN_LOG_FILE_RE = /^([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)\.log(?:\.1)?$/;
export const RUN_META_FILE_RE = /^\.([a-z0-9][a-z0-9-]{0,47})\.(pid|sink\.json)$/;

// 尾部窗口起点：默认 50-200 行的场景不需要读满 MAX_LOG_BYTES（#53），
// 行数不足时再按 4 倍向前扩展，直到覆盖文件开头或达到 maxBytes 上限。
const INITIAL_TAIL_WINDOW = 64 * 1024;

function decodeTailWindow(buf, offset) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let leading = 0; leading <= 3 && leading <= offset; leading++) {
    if (leading && (buf[leading - 1] & 0xc0) !== 0x80) break;
    try {
      const text = decoder.decode(buf.subarray(leading));
      const target = offset - leading;
      for (let extra = 0; extra <= 3 && target - extra >= 0; extra++) {
        try {
          const prefix = decoder.decode(buf.subarray(leading, leading + target - extra));
          return text.slice(prefix.length);
        } catch { /* move the cutoff before a possible partial code point */ }
      }
    } catch { /* skip leading continuation bytes from a split UTF-8 code point */ }
  }
  return decodeText(buf.subarray(offset));
}

function splitLogLines(text) {
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  return all;
}

// ---------- 日志内容过滤（logs --grep/--context/--since，CLI 与 follow 共用） ----------

export const LOG_CONTEXT_SEPARATOR = '--';

// 行首时间戳口径（references/manager.md 同步）：YYYY-MM-DD[THH:MM[:SS[.mmm]]]
// 可带时区 Z / +08:00 / +0800，也接受常见的方括号包裹。
const LEADING_TIMESTAMP_RE = /^\s*\[?(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?\]?(?!\d)/;
const SINCE_DURATION_RE = /^(\d+)(ms|s|m|h|d)$/i;
const DURATION_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function timestampToMs(m) {
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = m[8];
  if (!zone) return new Date(year, month - 1, day, hour, minute, second, millis).getTime();
  if (zone === 'Z') return Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const digits = zone.slice(1).replace(':', '');
  const oh = Number(digits.slice(0, 2));
  const om = Number(digits.slice(2, 4));
  if (oh > 23 || om > 59) return null;
  const sign = zone[0] === '-' ? -1 : 1;
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - sign * (oh * 60 + om) * 60_000;
}

// 行首时间戳 → epoch ms；无时间戳返回 null（不猜测行内时间）
export function parseLeadingTimestamp(line) {
  const m = LEADING_TIMESTAMP_RE.exec(String(line));
  return m ? timestampToMs(m) : null;
}

// --since 取值：相对时长（30m/2h/1d，基准为 now）或绝对行首时间戳。
export function parseSinceValue(raw, now = Date.now()) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const d = SINCE_DURATION_RE.exec(value);
  if (d) return { ms: now - Number(d[1]) * DURATION_MS[d[2].toLowerCase()], raw: value };
  const ms = parseLeadingTimestamp(value);
  return ms == null ? null : { ms, raw: value };
}

// 有状态过滤器：feed 返回本次可输出的行（含 context 与组间 `--`）。
// 批量模式把所有尾部行依次 feed 即可；follow 模式边读边 feed，context 缓冲有界（只留前 N 行）。
export function createLogFilter({
  regex = null,
  context = 0,
  sinceMs = null,
  textOf = (entry) => String(entry),
  separator = LOG_CONTEXT_SEPARATOR,
} = {}) {
  const ctx = Number.isInteger(context) && context > 0 ? context : 0;
  const sep = typeof separator === 'function' ? separator : () => separator;
  let index = -1;
  let lastOutput = -1;
  let activeUntil = -1;
  let matched = 0;
  let noTimestamp = 0;
  let beforeSince = 0;
  let groups = 0;
  let ring = [];
  const out = [];
  return {
    feed(entry) {
      const text = textOf(entry);
      if (sinceMs != null) {
        const ts = parseLeadingTimestamp(text);
        if (ts == null) { noTimestamp++; return []; }
        if (ts < sinceMs) { beforeSince++; return []; }
      }
      index++;
      ring.push({ index, entry });
      if (ctx > 0) {
        const keepFrom = index - ctx;
        while (ring.length && ring[0].index < keepFrom) ring.shift();
      } else {
        ring = [{ index, entry }];
      }
      const hit = regex ? regex.test(text) : true;
      if (hit) {
        matched++;
        const start = ctx > 0 ? Math.max(0, index - ctx) : index;
        const beginsGroup = lastOutput < 0 || (ctx > 0 && start > lastOutput + 1);
        if (beginsGroup) {
          if (ctx > 0 && lastOutput >= 0) out.push(sep());
          groups++;
        }
        const from = Math.max(start, lastOutput + 1);
        for (const item of ring) if (item.index >= from) out.push(item.entry);
        lastOutput = index;
        activeUntil = index + ctx;
      } else if (ctx > 0 && lastOutput >= 0 && index <= activeUntil) {
        out.push(entry);
        lastOutput = index;
      }
      return out.splice(0);
    },
    stats() {
      return { matched, noTimestamp, beforeSince, groups };
    },
  };
}

export function filterLogEntries(entries, options) {
  const filter = createLogFilter(options);
  const lines = [];
  for (const entry of entries) lines.push(...filter.feed(entry));
  return { lines, stats: filter.stats() };
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
      const readStart = start > 0 ? Math.max(0, start - 3) : start;
      const buf = Buffer.alloc(size - readStart);
      fs.readSync(fd, buf, 0, buf.length, readStart);
      all = splitLogLines(decodeTailWindow(buf, start - readStart));
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
