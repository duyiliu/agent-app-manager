// 日志/命令输出解码：UTF-8 优先，失败回退 GBK（中文 Windows 常见 ANSI 代码页），
// 精简 ICU 的 Node 可能不带 GBK 解码器时再回退 lossy UTF-8——绝不让解码器缺失阻断读取。

// 指定编码的流式解码器（fatal 可选）；编码不可用时回退 lossy UTF-8。
export function pickDecoder(encoding, { fatal = false } = {}) {
  try { return new TextDecoder(encoding, { fatal }); }
  catch { return new TextDecoder('utf-8'); }
}

// 一次性解码整块 Buffer：UTF-8 严格校验，非法字节序列判定为非 UTF-8 再按 GBK 解。
export function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return pickDecoder('gbk').decode(buf); }
}
