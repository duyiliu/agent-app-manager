# project-runner 进程身份核验与终止适配（PowerShell 7）。
# 设计基线：docs/design.md v2 —— 身份核验与终止必须针对同一进程句柄，防止"先查 PID 再按 PID 杀"的复用竞态。
# 输出：单行 JSON。result ∈ ok | mismatch | exited | notfound | terminated | terminateTimeout | error。
# 注意：creationFileTime 超出 JS 安全整数范围，始终以字符串传递与序列化。
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('capture', 'verify', 'terminate', 'verify-batch')]
  [string]$Action,

  [int]$Id = 0,
  [string]$CreationFileTime = '',
  [string]$Image = '',
  [int]$WaitMs = 10000,
  [string]$ItemsJson = ''   # verify-batch：JSON 数组，逐项 { id, creationFileTime, image }；'-' 表示从 stdin 读取
)

$ErrorActionPreference = 'Stop'

$typeSrc = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcUtil {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder buf, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr h, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);

  const uint QUERY = 0x1000;       // PROCESS_QUERY_LIMITED_INFORMATION
  const uint TERMINATE = 0x1;      // PROCESS_TERMINATE
  const uint SYNCHRONIZE = 0x100000; // WaitForSingleObject 必需
  const int ERROR_INVALID_PARAMETER = 87;

  static string Err(string code, int win32) { return "ERR\t" + code + "\t" + win32.ToString(); }

  static string IdentityOnHandle(IntPtr h) {
    long c, e, k, u;
    if (!GetProcessTimes(h, out c, out e, out k, out u)) return Err("timesFailed", Marshal.GetLastWin32Error());
    if (e != 0) return "EXITED\t" + c.ToString(); // 已退出但仍有句柄引用：映像查询会失败，明确报告已退出
    var sb = new StringBuilder(2048); uint sz = (uint)sb.Capacity;
    if (!QueryFullProcessImageName(h, 0, sb, ref sz)) return Err("imageFailed", Marshal.GetLastWin32Error());
    return "OK\t" + c.ToString() + "\t" + sb.ToString();
  }

  static string VerifyOnHandle(IntPtr h, long creationFT, string image) {
    long c, e, k, u;
    if (!GetProcessTimes(h, out c, out e, out k, out u)) return Err("timesFailed", Marshal.GetLastWin32Error());
    // 已退出但仍被句柄引用的进程：exit time 非零，映像查询会失败；明确报告已退出。
    if (e != 0) return "EXITED\t" + c.ToString();
    var sb = new StringBuilder(2048); uint sz = (uint)sb.Capacity;
    string img = QueryFullProcessImageName(h, 0, sb, ref sz) ? sb.ToString() : null;
    if (img == null) return Err("imageFailed", Marshal.GetLastWin32Error());
    if (c != creationFT) return "MISMATCH\tcreationTime";
    if (!string.Equals(img, image, StringComparison.OrdinalIgnoreCase)) return "MISMATCH\timage";
    return "OK\t" + c.ToString() + "\t" + img;
  }

  public static string Capture(int pid) {
    IntPtr h = OpenProcess(QUERY, false, pid);
    if (h == IntPtr.Zero) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_INVALID_PARAMETER) return "NOTFOUND";
      return Err("openFailed", err);
    }
    try { return IdentityOnHandle(h); }
    finally { CloseHandle(h); }
  }

  public static string Verify(int pid, long creationFileTime, string image) {
    IntPtr h = OpenProcess(QUERY, false, pid);
    if (h == IntPtr.Zero) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_INVALID_PARAMETER) return "NOTFOUND";
      return Err("openFailed", err);
    }
    try { return VerifyOnHandle(h, creationFileTime, image); }
    finally { CloseHandle(h); }
  }

  public static string Terminate(int pid, long creationFileTime, string image, int waitMs) {
    // 以同一句柄完成"核验 + 终止"，核验不通过绝不终止。SYNCHRONIZE 用于等待退出。
    IntPtr h = OpenProcess(QUERY | TERMINATE | SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_INVALID_PARAMETER) return "NOTFOUND";
      return Err("openFailed", err);
    }
    try {
      string v = VerifyOnHandle(h, creationFileTime, image);
      if (!v.StartsWith("OK")) return v;
      if (!TerminateProcess(h, 137)) return Err("terminateFailed", Marshal.GetLastWin32Error());
      uint w = WaitForSingleObject(h, (uint)Math.Max(0, waitMs));
      return w == 0 ? "TERMINATED" : "TERMINATE_TIMEOUT";
    }
    finally { CloseHandle(h); }
  }
}
'@

# 每次 pwsh -File 都是新进程，直接编译加载即可
Add-Type -TypeDefinition $typeSrc -Language CSharp

# withCapture 仅 capture 需要回传身份（creationFileTime/image）；verify/批量核验只回传判定结果
function Convert-Raw([string]$raw, [bool]$withCapture) {
  $parts = $raw -split "`t", 3
  $obj = [ordered]@{}
  switch ($parts[0]) {
    'OK' {
      $obj.result = 'ok'
      if ($withCapture) {
        $obj.creationFileTime = [string]$parts[1]   # 保持字符串，避免精度丢失
        $obj.image = [string]$parts[2]
      }
    }
    'MISMATCH' { $obj.result = 'mismatch'; $obj.field = [string]$parts[1] }
    'EXITED' { $obj.result = 'exited' }
    'NOTFOUND' { $obj.result = 'notfound' }
    'TERMINATED' { $obj.result = 'terminated' }
    'TERMINATE_TIMEOUT' { $obj.result = 'terminateTimeout' }
    'ERR' { $obj.result = 'error'; $obj.code = [string]$parts[1]; $obj.win32 = [int]$parts[2] }
    default { $obj.result = 'error'; $obj.code = 'unexpected'; $obj.raw = $raw }
  }
  [pscustomobject]$obj
}

function Convert-Result([string]$raw) {
  Convert-Raw $raw ($Action -eq 'capture') | ConvertTo-Json -Compress
}

# 批量核验：一次进程编译，逐项 OpenProcess 核验（每项仍是独立句柄，单项语义与 verify 完全一致），
# 按输入顺序返回结果数组。避免 N 个应用 N 次 pwsh + Add-Type 现编 C# 的开销。
if ($Action -eq 'verify-batch') {
  if ($ItemsJson -eq '-') { $ItemsJson = [Console]::In.ReadToEnd() }
  $items = $null
  try { $items = @($ItemsJson | ConvertFrom-Json) } catch { $items = $null }
  if ($null -eq $items) {
    [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
    exit 0
  }
  $out = foreach ($it in $items) {
    $id = 0
    [int]::TryParse([string]$it.id, [ref]$id) | Out-Null
    $cft = [string]$it.creationFileTime
    $img = [string]$it.image
    if (($id -le 0) -or (-not $cft) -or (-not $img)) {
      Convert-Raw ('ERR' + "`t" + 'badArgs' + "`t" + '0') $false
      continue
    }
    Convert-Raw ([ProcUtil]::Verify($id, [long]$cft, $img)) $false
  }
  [pscustomobject]@{ results = @($out) } | ConvertTo-Json -Compress
  exit 0
}

if (($Action -ne 'capture') -and (($Id -le 0) -or (-not $CreationFileTime) -or (-not $Image))) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}
if (($Action -eq 'capture') -and ($Id -le 0)) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}

$raw = switch ($Action) {
  'capture' { [ProcUtil]::Capture($Id) }
  'verify' { [ProcUtil]::Verify($Id, [long]$CreationFileTime, $Image) }
  'terminate' { [ProcUtil]::Terminate($Id, [long]$CreationFileTime, $Image, $WaitMs) }
}

Convert-Result $raw
exit 0
