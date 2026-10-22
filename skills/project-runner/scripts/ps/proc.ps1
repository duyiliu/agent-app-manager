# project-runner 进程身份核验与终止适配（PowerShell 7）。
# 设计基线：docs/design.md v2 —— 身份核验与终止必须针对同一进程句柄，防止"先查 PID 再按 PID 杀"的复用竞态。
# 输出：单行 JSON。result ∈ ok | mismatch | exited | notfound | terminated | terminateTimeout | error。
# 注意：creationFileTime 超出 JS 安全整数范围，始终以字符串传递与序列化。
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('capture', 'verify', 'verify-batch', 'terminate', 'discover', 'descendants')]
  [string]$Action,

  [int]$Id = 0,
  [string]$CreationFileTime = '',
  [string]$Image = '',
  [int]$WaitMs = 10000,
  # verify-batch：UTF-8 JSON 数组的 base64，形如
  # [{ "id": 123, "creationFileTime": "...", "image": "..." }, ...]
  [string]$Json = ''
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

function Parse-Result([string]$raw) {
  $parts = $raw -split "`t", 3
  $obj = [ordered]@{}
  switch ($parts[0]) {
    'OK' {
      $obj.result = 'ok'
      if ($Action -eq 'capture') {
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
  return [pscustomobject]$obj
}

function Convert-Result([string]$raw) {
  Parse-Result $raw | ConvertTo-Json -Compress
}

# verify-batch：一次 pwsh 调用逐项核验，避免 list 对 N 个应用 spawn N 次（#15/#51）。
# 与 verify 走同一 ProcUtil.Verify（同句柄核验），语义完全一致。
# descendants：枚举目标 pid 当时仍在的后代（PPID 树），供 stop --tree 留证（#39）。
# 只向下遍历，不向上爬、不认领外部进程。
if ($Action -eq 'descendants') {
  $procs = @()
  try {
    $procs = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath -ErrorAction SilentlyContinue)
  } catch {
    '[]'
    exit 0
  }
  $byParent = @{}
  foreach ($p in $procs) {
    $pp = [int64]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
    [void]$byParent[$pp].Add([int64]$p.ProcessId)
  }
  $out = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue([int64]$Id)
  $seen = @{}
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    if (-not $byParent.ContainsKey($cur)) { continue }
    foreach ($child in $byParent[$cur]) {
      if ($seen.ContainsKey($child)) { continue }
      $seen[$child] = $true
      $queue.Enqueue($child)
      $proc = $procs | Where-Object { [int64]$_.ProcessId -eq $child } | Select-Object -First 1
      [void]$out.Add([pscustomobject]@{ pid = [int]$child; image = [string]$proc.ExecutablePath })
    }
  }
  if ($out.Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress }
  exit 0
}

if ($Action -eq 'verify-batch') {
  if (-not $Json) {
    [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
    exit 0
  }
  $items = @()
  try {
    $jsonText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json))
    $items = @($jsonText | ConvertFrom-Json)
  } catch {
    [pscustomobject]@{ result = 'error'; code = 'badJson'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
  }
  $out = @()
  foreach ($it in $items) {
    $out += (Parse-Result ([ProcUtil]::Verify([int]$it.id, [long]$it.creationFileTime, [string]$it.image)))
  }
  $out | ConvertTo-Json -Compress
  exit 0
}

if (($Action -in 'verify', 'terminate') -and (($Id -le 0) -or (-not $CreationFileTime) -or (-not $Image))) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}
if (($Action -in 'capture', 'descendants') -and ($Id -le 0)) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}
if (($Action -eq 'discover') -and (($Id -le 0) -or (-not $Image))) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}

# discover：有界轮询目标 wrapper（-Id）的后代进程，返回映像基名匹配 -Image 的候选清单。
# 供命令模式受管启动使用——manager 拉起 cmd wrapper 后在此等待真实目标出现。
# 首次匹配后不立即返回，再观察 settleMs 取最终清单：脚本常先后拉起多个进程，
# 第一次轮询只捕到部分会造成"假唯一"，把歧义场景误判成可托管。
if ($Action -eq 'discover') {
  $deadline = (Get-Date).AddMilliseconds($WaitMs)
  $settleMs = 1500
  $foundAt = $null
  while ($true) {
    $rows = $null
    try {
      $rows = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate
    } catch {
      [pscustomobject]@{ result = 'error'; code = 'cimFailed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
      exit 0
    }
    $byParent = @{}
    $wrapperAlive = $false
    foreach ($p in $rows) {
      $pp = [int64]$p.ParentProcessId
      if ([int64]$p.ProcessId -eq $Id) { $wrapperAlive = $true }
      if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = [System.Collections.ArrayList]@() }
      [void]$byParent[$pp].Add($p)
    }
    $queue = [System.Collections.ArrayList]@([int64]$Id)
    $seen = @{}
    $found = @()
    while ($queue.Count -gt 0) {
      $cur = $queue[0]; $queue.RemoveAt(0)
      $kids = $byParent[[int64]$cur]
      if (-not $kids) { continue }
      foreach ($c in $kids) {
        $cpid = [int64]$c.ProcessId
        if ($seen.ContainsKey($cpid)) { continue }
        $seen[$cpid] = $true
        [void]$queue.Add($cpid)
        $img = [string]$c.ExecutablePath
        if ($img -and ([IO.Path]::GetFileName($img) -ieq $Image)) {
          $found += [pscustomobject]@{ pid = $cpid; image = $img; creationFileTime = [string]$c.CreationDate.ToFileTime() }
        }
      }
    }
    if ($found.Count -gt 0) {
      if (-not $foundAt) { $foundAt = Get-Date }
      if ((Get-Date) -ge $foundAt.AddMilliseconds($settleMs)) {
        [pscustomobject]@{ result = 'found'; candidates = $found } | ConvertTo-Json -Compress
        exit 0
      }
    } else {
      $foundAt = $null # 本轮无匹配：瞬时候选已消失，不计入歧义也不开 settle
      if (-not $wrapperAlive) {
        [pscustomobject]@{ result = 'wrapperExited'; candidates = @() } | ConvertTo-Json -Compress
        exit 0
      }
      if ((Get-Date) -ge $deadline) {
        [pscustomobject]@{ result = 'timeout'; candidates = @() } | ConvertTo-Json -Compress
        exit 0
      }
    }
    Start-Sleep -Milliseconds 400
  }
}

$raw = switch ($Action) {
  'capture' { [ProcUtil]::Capture($Id) }
  'verify' { [ProcUtil]::Verify($Id, [long]$CreationFileTime, $Image) }
  'terminate' { [ProcUtil]::Terminate($Id, [long]$CreationFileTime, $Image, $WaitMs) }
}

Convert-Result $raw
exit 0
