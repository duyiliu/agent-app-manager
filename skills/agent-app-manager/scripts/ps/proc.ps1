# agent-app-manager 进程身份核验与终止适配（PowerShell 7）。
# 设计基线：docs/design.md v2 —— 身份核验与终止必须针对同一进程句柄，防止"先查 PID 再按 PID 杀"的复用竞态。
# 输出：单行 JSON。result ∈ ok | mismatch | exited | notfound | terminated | terminateTimeout | error。
# 注意：creationFileTime 超出 JS 安全整数范围，始终以字符串传递与序列化。
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('capture', 'verify', 'verify-batch', 'terminate', 'terminate-tree', 'grace', 'discover', 'wait-exit', 'descendants', 'port', 'listening', 'listening-batch', 'resources', 'probe')]
  [string]$Action,

  [int]$Id = 0,
  [string]$CreationFileTime = '',
  [string]$Image = '',
  [int]$WaitMs = 10000,
  [string]$ReadyFile = '',
  # 资源采样的两次 CPU 计数间隔（毫秒）；只用于单次快照，不引入常驻轮询。
  [int]$IntervalMs = 200,
  # verify-batch / resources：UTF-8 JSON 数组的 base64。
  # verify-batch: [{ "id": 123, "creationFileTime": "...", "image": "..." }, ...]
  # resources:    [{ "id": 123, "tree": true }, ...]
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
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr h, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder buf, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr h, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("psapi.dll", SetLastError = true)]
  static extern bool GetProcessMemoryInfo(IntPtr h, out PROCESS_MEMORY_COUNTERS counters, uint size);
  // GetExtendedTcpTable + Toolhelp32：轮询路径（listening/port/resources）之前用
  // Get-NetTCPConnection 与 Get-CimInstance，单次各约 1-2s；P/Invoke 直读内核表
  // 与进程快照后单次在几十毫秒内完成，且全部可以在一次 pwsh 里组合执行。
  [DllImport("iphlpapi.dll", SetLastError = true)]
  static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref uint pdwSize, bool bOrder, uint ulAf, int tableClass, uint reserved);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 entry);

  const uint QUERY = 0x1000;       // PROCESS_QUERY_LIMITED_INFORMATION
  const uint TERMINATE = 0x1;      // PROCESS_TERMINATE
  const uint VM_READ = 0x10;       // PROCESS_VM_READ（GetProcessMemoryInfo 需要）
  const uint SYNCHRONIZE = 0x100000; // WaitForSingleObject 必需
  const int ERROR_INVALID_PARAMETER = 87;

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_MEMORY_COUNTERS {
    public uint cb;
    public uint PageFaultCount;
    public UIntPtr PeakWorkingSetSize;
    public UIntPtr WorkingSetSize;
    public UIntPtr QuotaPeakPagedPoolUsage;
    public UIntPtr QuotaPagedPoolUsage;
    public UIntPtr QuotaPeakNonPagedPoolUsage;
    public UIntPtr QuotaNonPagedPoolUsage;
    public UIntPtr PagefileUsage;
    public UIntPtr PeakPagefileUsage;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  public class TcpRow { public int Pid; public string LocalAddress; public int LocalPort; }
  public class ProcRow { public int Pid; public int Ppid; public string Image; }

  const int TCP_TABLE_OWNER_PID_LISTENER = 3;
  const uint AF_INET = 2;
  const uint AF_INET6 = 23;
  const uint ERROR_INSUFFICIENT_BUFFER = 122;
  const uint MIB_TCP_STATE_LISTEN = 2;

  static ushort SwapUshort(ushort v) { return (ushort)((v >> 8) | (v << 8)); }

  static void ReadTcpListenerTable(uint af, System.Collections.Generic.List<TcpRow> rows) {
    // GetExtendedTcpTable(OWNER_PID_LISTENER)：等价 Get-NetTCPConnection -State Listen，
    // 但直接读内核 TCP 表（内核返回的是按表类过滤后的结果，几十毫秒 vs WMI 秒级）。
    uint len = 0;
    uint rc = GetExtendedTcpTable(IntPtr.Zero, ref len, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (rc == 0) return; // 空表
    if (rc != ERROR_INSUFFICIENT_BUFFER) throw new System.ComponentModel.Win32Exception((int)rc);
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    try {
      rc = GetExtendedTcpTable(buf, ref len, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0);
      if (rc != 0) throw new System.ComponentModel.Win32Exception((int)rc);
      int count = Marshal.ReadInt32(buf);
      int rowSize = (af == AF_INET) ? 24 : 56;
      IntPtr p = IntPtr.Add(buf, 4);
      for (int i = 0; i < count; i++, p = IntPtr.Add(p, rowSize)) {
        if (af == AF_INET) {
          // MIB_TCPROW_OWNER_PID: dwState, dwLocalAddr, dwLocalPort, dwRemoteAddr, dwRemotePort, dwOwningPid
          if ((uint)Marshal.ReadInt32(p, 0) != MIB_TCP_STATE_LISTEN) continue;
          uint addr = (uint)Marshal.ReadInt32(p, 4);
          ushort port = SwapUshort((ushort)Marshal.ReadInt16(p, 8));
          rows.Add(new TcpRow {
            Pid = Marshal.ReadInt32(p, 20),
            LocalAddress = new System.Net.IPAddress(BitConverter.GetBytes(addr)).ToString(),
            LocalPort = port,
          });
        } else {
          // MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId, dwLocalPort,
          // ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort, dwState, dwOwningPid
          if ((uint)Marshal.ReadInt32(p, 48) != MIB_TCP_STATE_LISTEN) continue;
          byte[] addr6 = new byte[16];
          Marshal.Copy(p, addr6, 0, 16);
          ushort port = SwapUshort((ushort)Marshal.ReadInt16(p, 20));
          rows.Add(new TcpRow {
            Pid = Marshal.ReadInt32(p, 52),
            LocalAddress = new System.Net.IPAddress(addr6).ToString(),
            LocalPort = port,
          });
        }
      }
    }
    finally { Marshal.FreeHGlobal(buf); }
  }

  public static System.Collections.Generic.List<TcpRow> TcpListeners() {
    var rows = new System.Collections.Generic.List<TcpRow>();
    ReadTcpListenerTable(AF_INET, rows);
    ReadTcpListenerTable(AF_INET6, rows);
    return rows;
  }

  // CreateToolhelp32Snapshot：等价 Win32_Process 的 pid/ppid/映像名拓扑，
  // 供后代展开使用；一次快照毫秒级，不再起 WMI 查询。szExeFile 仅映像基名。
  public static System.Collections.Generic.List<ProcRow> ProcessTable() {
    var rows = new System.Collections.Generic.List<ProcRow>();
    const uint TH32CS_SNAPPROCESS = 0x2;
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == new IntPtr(-1)) return rows;
    try {
      var e = new PROCESSENTRY32();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snap, ref e)) return rows;
      do {
        rows.Add(new ProcRow {
          Pid = (int)e.th32ProcessID,
          Ppid = (int)e.th32ParentProcessID,
          Image = e.szExeFile,
        });
      } while (Process32Next(snap, ref e));
      return rows;
    }
    finally { CloseHandle(snap); }
  }

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

  // 等待指定进程实例退出并返回其退出码（#102 command 模式目标）。
  // 先核验 creationFileTime 再阻塞在同一句柄上，PID 复用不会让证据记到新进程。
  public static string WaitExit(int pid, long creationFileTime, string readyFile) {
    IntPtr h = OpenProcess(QUERY | SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_INVALID_PARAMETER) return "NOTFOUND";
      return Err("openFailed", err);
    }
    try {
      long c, e, k, u;
      if (!GetProcessTimes(h, out c, out e, out k, out u)) return Err("timesFailed", Marshal.GetLastWin32Error());
      if (c != creationFileTime) return "MISMATCH\tcreationTime";
      // 先发出 ready：manager 等 watcher 真正拿到句柄后才返回启动成功，
      // 避免目标在 pwsh 冷启动期间退出导致证据漏采。
      if (!string.IsNullOrEmpty(readyFile)) { try { System.IO.File.WriteAllText(readyFile, "ready"); } catch { } }
      uint w = WaitForSingleObject(h, 0xFFFFFFFF);
      if (w != 0) return Err("waitFailed", (int)w);
      uint code;
      if (!GetExitCodeProcess(h, out code)) return Err("exitCodeFailed", Marshal.GetLastWin32Error());
      return "OK\t" + code.ToString();
    }
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

  // --grace：持有已核验句柄期间发起 taskkill（无 /F：GUI 收 WM_CLOSE），并用同一
  // 句柄 WaitForSingleObject 确认退出。句柄存活期内 PID 不会被回收复用——原先
  // "Verify→关句柄→taskkill"之间留了一个复用窗口。句柄无需 TERMINATE 权限。
  public static string Grace(int pid, long creationFileTime, string image, int waitMs) {
    IntPtr h = OpenProcess(QUERY | SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_INVALID_PARAMETER) return "NOTFOUND";
      return Err("openFailed", err);
    }
    try {
      string v = VerifyOnHandle(h, creationFileTime, image);
      if (!v.StartsWith("OK")) return v;
      try {
        var start = new System.Diagnostics.ProcessStartInfo {
          FileName = "taskkill",
          Arguments = "/PID " + pid.ToString(),
          CreateNoWindow = true,
          UseShellExecute = false,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
        };
        var p = System.Diagnostics.Process.Start(start);
        p.WaitForExit(10000);
      } catch { /* taskkill 发起失败不致命：仍按句柄等待退出确认 */ }
      uint w = WaitForSingleObject(h, (uint)Math.Max(0, waitMs));
      return w == 0 ? "GRACE_DONE" : "GRACE_ALIVE";
    }
    finally { CloseHandle(h); }
  }

  // 资源采样：打开并持有句柄 → 读一次内存/CPU 计数 → 间隔 intervalMs → 再读 CPU 计数，
  // 用两次差值算单次 CPU 利用率（%），不会为了趋势做常驻轮询。
  // 内存取 WorkingSetSize（RSS 口径）与 PagefileUsage（私有提交）；无法取得时返回 -1 而不是整条失败。
  // 每行输出：OK\tpid\tworkingSet\tprivateBytes\tcpuPercent\tcpuTimeMs；失败：ERR\tpid\tcode。
  public static string[] SampleResources(int[] pids, int intervalMs) {
    int n = pids.Length;
    IntPtr[] handles = new IntPtr[n];
    long[] kernel1 = new long[n];
    long[] user1 = new long[n];
    ulong[] ws = new ulong[n];
    ulong[] pb = new ulong[n];
    bool[] memOk = new bool[n];
    string[] err = new string[n];
    for (int i = 0; i < n; i++) {
      IntPtr h = OpenProcess(QUERY | VM_READ, false, pids[i]);
      bool canMemory = h != IntPtr.Zero;
      if (h == IntPtr.Zero) {
        // 受保护/提权进程可能拒绝 VM_READ：降级到仅查询 CPU，内存字段标记不可用。
        h = OpenProcess(QUERY, false, pids[i]);
        if (h == IntPtr.Zero) {
          int e2 = Marshal.GetLastWin32Error();
          err[i] = (e2 == ERROR_INVALID_PARAMETER) ? "notfound" : ("openFailed:" + e2.ToString());
          continue;
        }
      }
      handles[i] = h;
      long c, ex, k, u;
      if (!GetProcessTimes(h, out c, out ex, out k, out u)) {
        err[i] = "timesFailed:" + Marshal.GetLastWin32Error().ToString();
        CloseHandle(h); handles[i] = IntPtr.Zero;
        continue;
      }
      if (ex != 0) {
        err[i] = "exited";
        CloseHandle(h); handles[i] = IntPtr.Zero;
        continue;
      }
      kernel1[i] = k; user1[i] = u;
      if (canMemory) {
        var counters = new PROCESS_MEMORY_COUNTERS();
        counters.cb = (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS));
        if (GetProcessMemoryInfo(h, out counters, counters.cb)) {
          ws[i] = counters.WorkingSetSize.ToUInt64();
          pb[i] = counters.PagefileUsage.ToUInt64();
          memOk[i] = true;
        }
      }
    }
    if (intervalMs > 0) System.Threading.Thread.Sleep(intervalMs);
    var inv = System.Globalization.CultureInfo.InvariantCulture;
    string[] outLines = new string[n];
    for (int i = 0; i < n; i++) {
      if (err[i] != null) { outLines[i] = "ERR\t" + pids[i].ToString(inv) + "\t" + err[i]; continue; }
      IntPtr h = handles[i];
      if (h == IntPtr.Zero) { outLines[i] = "ERR\t" + pids[i].ToString(inv) + "\tnoHandle"; continue; }
      try {
        long c2, ex2, k2, u2;
        if (!GetProcessTimes(h, out c2, out ex2, out k2, out u2)) { outLines[i] = "ERR\t" + pids[i].ToString(inv) + "\ttimesFailed2"; continue; }
        if (ex2 != 0) { outLines[i] = "ERR\t" + pids[i].ToString(inv) + "\texited"; continue; }
        long total = k2 + u2;
        double delta = Math.Max(0, total - (kernel1[i] + user1[i]));
        double cpuPct = intervalMs > 0 ? delta / ((double)intervalMs * 10000.0) * 100.0 : 0.0;
        string wsText = memOk[i] ? ws[i].ToString(inv) : "-1";
        string pbText = memOk[i] ? pb[i].ToString(inv) : "-1";
        outLines[i] = "OK\t" + pids[i].ToString(inv) + "\t" + wsText + "\t" + pbText + "\t"
          + cpuPct.ToString("F2", inv) + "\t" + (total / 10000.0).ToString("F1", inv);
      }
      finally { CloseHandle(handles[i]); }
    }
    return outLines;
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

# 单次有界资源采样（RSS/CPU）。items 为 [{ id, tree }]；tree=true 时
# 在后代 PPID 树中聚合目标 + 后代（命令模式的真实用量）。
# 后代枚举用 Toolhelp 快照（毫秒级，替代原 Win32_Process WMI 查询），
# 与两次 CPU 计数都在同一 pwsh 内完成，不引入常驻轮询。
function Invoke-ResourceSample($items, [int]$intervalMs) {
  # 一次快照取全量拓扑，供所有 tree 项复用；失败时退化为只采样目标自身。
  $procRows = @()
  try {
    $procRows = @([ProcUtil]::ProcessTable())
  } catch { $procRows = @() }
  $byParent = @{}
  foreach ($p in $procRows) {
    $pp = [int64]$p.Ppid
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = [System.Collections.ArrayList]@() }
    [void]$byParent[$pp].Add([int64]$p.Pid)
  }
  $maxPids = 64
  $expanded = @()
  $unique = New-Object System.Collections.Generic.List[int]
  $seen = @{}
  foreach ($it in $items) {
    $id = [int64]$it.id
    if ($id -le 0) { continue }
    $pids = @([int]$id)
    $truncated = $false
    if ($it.tree) {
      $queue = [System.Collections.ArrayList]@($id)
      $visited = @{}
      while ($queue.Count -gt 0) {
        # ArrayList 可能把元素收敛为 Int32，而 $byParent 的键是 Int64；必须显式转换，
        # 否则 hashtable 按类型查找会返回空，后代永远不会展开。
        $cur = [int64]$queue[0]; $queue.RemoveAt(0)
        $kids = $byParent[$cur]
        if (-not $kids) { continue }
        foreach ($k in $kids) {
          if ($visited.ContainsKey($k)) { continue }
          $visited[$k] = $true
          if ($pids.Count -ge $maxPids) { $truncated = $true; continue }
          $pids += [int]$k
          [void]$queue.Add([int64]$k)
        }
      }
    }
    $expanded += [pscustomobject]@{ id = [int]$id; pids = @($pids); truncated = $truncated }
    foreach ($p in $pids) {
      if (-not $seen.ContainsKey($p)) { $seen[$p] = $true; [void]$unique.Add([int]$p) }
    }
  }
  $lines = @([ProcUtil]::SampleResources([int[]]$unique.ToArray(), $intervalMs))
  $procs = @()
  foreach ($line in $lines) {
    $parts = $line -split "`t", 6
    if ($parts[0] -eq 'OK') {
      $rss = [long]$parts[2]
      $pb = [long]$parts[3]
      $procs += [pscustomobject]@{
        pid = [int]$parts[1]
        result = 'ok'
        rssBytes = $(if ($rss -ge 0) { $rss } else { $null })
        privateBytes = $(if ($pb -ge 0) { $pb } else { $null })
        cpuPercent = [double]$parts[4]
        cpuTimeMs = [double]$parts[5]
      }
    } elseif ($parts.Count -ge 3) {
      $procs += [pscustomobject]@{ pid = [int]$parts[1]; result = 'error'; code = [string]$parts[2] }
    }
  }
  return [pscustomobject]@{
    result = 'ok'
    intervalMs = $intervalMs
    items = @($expanded)
    processes = @($procs)
  }
}

if ($Action -eq 'resources') {
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
  Invoke-ResourceSample $items $IntervalMs | ConvertTo-Json -Compress -Depth 6
  exit 0
}

# probe：轮询路径组合探针——一次 pwsh 完成 verify/capture/listening/resources 任意组合，
# 避免 status/list 每次各起 3-5 个 pwsh 冷启动（Windows 上每次含 Add-Type 编译约 0.5-1s）。
# 输入 JSON：{ verify:[{id,creationFileTime,image}], capture:[pid..], listening:[pid..],
#             resources:{items:[{id,tree}],intervalMs} }；各段独立 try，单段失败不拖垮整体。
if ($Action -eq 'probe') {
  if (-not $Json) {
    [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
    exit 0
  }
  $spec = $null
  try {
    $jsonText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json))
    $spec = $jsonText | ConvertFrom-Json
  } catch {
    [pscustomobject]@{ result = 'error'; code = 'badJson'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
  }
  $out = [ordered]@{ result = 'ok'; verify = $null; capture = $null; listening = $null; resources = $null }
  if ($null -ne $spec.verify) {
    $vout = @()
    foreach ($it in @($spec.verify)) {
      $vout += (Parse-Result ([ProcUtil]::Verify([int]$it.id, [long]$it.creationFileTime, [string]$it.image)))
    }
    $out.verify = @($vout)
  }
  if ($null -ne $spec.capture) {
    $cout = @()
    foreach ($p in @($spec.capture)) {
      $pidv = [int]$p
      if ($pidv -le 0) { continue }
      $raw = [ProcUtil]::Capture($pidv)
      $parts = $raw -split "`t", 3
      switch ($parts[0]) {
        'OK' { $cout += [pscustomobject]@{ pid = $pidv; result = 'ok'; creationFileTime = [string]$parts[1]; image = [string]$parts[2] } }
        'EXITED' { $cout += [pscustomobject]@{ pid = $pidv; result = 'exited' } }
        'NOTFOUND' { $cout += [pscustomobject]@{ pid = $pidv; result = 'notfound' } }
        'ERR' { $cout += [pscustomobject]@{ pid = $pidv; result = 'error'; code = [string]$parts[1] } }
        default { $cout += [pscustomobject]@{ pid = $pidv; result = 'error'; code = 'unexpected' } }
      }
    }
    $out.capture = @($cout)
  }
  if ($null -ne $spec.listening) {
    try {
      $wanted = @{}
      foreach ($p in @($spec.listening)) { if ([int]$p -gt 0) { $wanted[[int]$p] = $true } }
      $lrows = @()
      if ($wanted.Count -gt 0) {
        foreach ($c in [ProcUtil]::TcpListeners()) {
          if (-not $wanted.ContainsKey([int]$c.Pid)) { continue }
          $lrows += [pscustomobject]@{ pid = [int]$c.Pid; localAddress = [string]$c.LocalAddress; localPort = [int]$c.LocalPort }
        }
      }
      $out.listening = [pscustomobject]@{ result = 'ok'; rows = @($lrows) }
    } catch {
      $out.listening = [pscustomobject]@{ result = 'error'; code = 'netFailed'; message = $_.Exception.Message }
    }
  }
  if ($null -ne $spec.resources) {
    try {
      $resItems = @($spec.resources.items)
      $resInterval = [int]$spec.resources.intervalMs
      if ($resInterval -le 0) { $resInterval = $IntervalMs }
      $out.resources = Invoke-ResourceSample $resItems $resInterval
    } catch {
      $out.resources = [pscustomobject]@{ result = 'error'; code = 'sampleFailed'; message = $_.Exception.Message }
    }
  }
  $out | ConvertTo-Json -Compress -Depth 7
  exit 0
}

if (($Action -in 'verify', 'terminate', 'terminate-tree', 'grace') -and (($Id -le 0) -or (-not $CreationFileTime) -or (-not $Image))) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}
if (($Action -eq 'wait-exit') -and (($Id -le 0) -or (-not $CreationFileTime))) {
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
if (($Action -eq 'port') -and (($Id -lt 1) -or ($Id -gt 65535))) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}
if (($Action -eq 'listening') -and ($Id -le 0)) {
  [pscustomobject]@{ result = 'error'; code = 'badArgs' } | ConvertTo-Json -Compress
  exit 0
}

# port：端口占用诊断（与原 ps/port.ps1 同语义），但身份采集复用本进程已编译的
# ProcUtil——N 个监听人也只需 1 次 pwsh 调用；identity.image 与 capture 同源
# （QueryFullProcessImageName 解析后路径），保持 #55 的 image 统一口径。
if ($Action -eq 'port') {
  $rows = @()
  try {
    $rows = @([ProcUtil]::TcpListeners() | Where-Object { $_.LocalPort -eq $Id })
  } catch {
    [pscustomobject]@{ result = 'error'; code = 'netFailed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
  }
  $out = @()
  foreach ($conn in $rows) {
    $ownerPid = [int]$conn.Pid
    $identity = $null
    $processName = $null
    $executablePath = $null
    $startedAt = $null
    if ($ownerPid -gt 0) {
      # 直接解析 ProcUtil.Capture 的原始输出（Parse-Result 仅在 -Action capture 时保留身份字段）
      $raw = [ProcUtil]::Capture($ownerPid)
      $parts = $raw -split "`t", 3
      switch ($parts[0]) {
        'OK' {
          $identity = [pscustomobject]@{ result = 'ok'; creationFileTime = [string]$parts[1]; image = [string]$parts[2] }
          $executablePath = [string]$parts[2]
          $processName = [IO.Path]::GetFileName($executablePath)
          # FILETIME（UTC）转 ISO，与旧 ps/port.ps1 的 Win32_Process.CreationDate 展示对齐
          $startedAt = [DateTime]::FromFileTimeUtc([long]$parts[1]).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        }
        'EXITED' { $identity = [pscustomobject]@{ result = 'exited' } }
        'NOTFOUND' { $identity = [pscustomobject]@{ result = 'notfound' } }
        default { $identity = [pscustomobject]@{ result = 'error'; code = [string]$parts[1]; win32 = [int]$parts[2] } }
      }
    }
    $out += [pscustomobject]@{
      pid = $ownerPid
      processName = $processName
      executablePath = $executablePath
      commandLine = $null
      startedAt = $startedAt
      localAddress = [string]$conn.LocalAddress
      localPort = [int]$conn.LocalPort
      identity = $identity
    }
  }
  if (@($out).Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress -Depth 4 }
  exit 0
}

# listening：pid→实际监听端口（#107）。GetExtendedTcpTable 按 OwningProcess 过滤，
# 只输出本机地址与端口，不采集命令行。权限不足/进程已退出时返回空数组，不臆造。
if ($Action -eq 'listening') {
  $out = @()
  try {
    $rows = @([ProcUtil]::TcpListeners() | Where-Object { $_.Pid -eq $Id })
  } catch {
    [pscustomobject]@{ result = 'error'; code = 'netFailed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
  }
  foreach ($conn in $rows) {
    $out += [pscustomobject]@{ localAddress = [string]$conn.LocalAddress; localPort = [int]$conn.LocalPort }
  }
  if (@($out).Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress -Depth 3 }
  exit 0
}

# listening-batch：一次调用枚举多个 pid 的监听端口（ui list 轮询用）。
# 输入同 verify-batch：UTF-8 JSON 数组的 base64。
if ($Action -eq 'listening-batch') {
  $pids = @()
  try {
    $jsonText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json))
    $pids = @($jsonText | ConvertFrom-Json)
  } catch {
    [pscustomobject]@{ result = 'error'; code = 'badJson'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
  }
  $wanted = @{}
  foreach ($p in $pids) { if ([int]$p -gt 0) { $wanted[[int]$p] = $true } }
  if ($wanted.Count -eq 0) { '[]'; exit 0 }
  $out = @()
  try {
    $conns = @([ProcUtil]::TcpListeners())
  } catch {
    [pscustomobject]@{ result = 'error'; code = 'netFailed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
  }
  foreach ($conn in $conns) {
    $owner = [int]$conn.Pid
    if (-not $wanted.ContainsKey($owner)) { continue }
    $out += [pscustomobject]@{ pid = $owner; localAddress = [string]$conn.LocalAddress; localPort = [int]$conn.LocalPort }
  }
  if (@($out).Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress -Depth 3 }
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
      # 两段式（#82-B2）：主扫描不拉 CommandLine（WMI 最贵字段），
      # 仅出现多个候选、需要启动器折叠判定时才按候选 pid 补拉。
      $rows = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath, CreationDate
    } catch {
      [pscustomobject]@{ result = 'error'; code = 'cimFailed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
      exit 0
    }
    $byParent = @{}
    $wrapperAlive = $false
    $rootRow = $null
    foreach ($p in $rows) {
      $pp = [int64]$p.ParentProcessId
      if ([int64]$p.ProcessId -eq $Id) { $wrapperAlive = $true; $rootRow = $p }
      if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = [System.Collections.ArrayList]@() }
      [void]$byParent[$pp].Add($p)
    }
    $queue = [System.Collections.ArrayList]@([int64]$Id)
    $seen = @{}
    $found = @()
    # 锚点自身也参与映像匹配：Linux /bin/sh 可能 exec 成真实目标（pid 不变），
    # 此时目标不是自己的后代，仅按后代枚举会错过。
    if ($rootRow -and $rootRow.ExecutablePath -and ([IO.Path]::GetFileName([string]$rootRow.ExecutablePath) -ieq $Image)) {
      $found += [pscustomobject]@{ pid = [int64]$rootRow.ProcessId; image = [string]$rootRow.ExecutablePath; creationFileTime = [string]$rootRow.CreationDate.ToFileTime(); cmd = '' }
    }
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
          $found += [pscustomobject]@{ pid = $cpid; image = $img; creationFileTime = [string]$c.CreationDate.ToFileTime(); cmd = '' }
        }
      }
    }
    # 已知启动器单链折叠：npm run dev / mvn bootRun 等场景中，包管理器/构建器与目标同映像
    # 且构成单链 wrapper→npm→app。只别除「是其他候选祖先且命令行能证明是已知启动器」的
    # 候选（npm-cli/yarn/pnpm/maven/gradle wrapper）；其余同映像链（目标自身派生同映像
    # 子进程）结构上不可区分，仍按歧义拒绝，安全边界不变。
    if ($found.Count -gt 1) {
      # 仅歧义路径补拉 CommandLine：候选通常 2-3 个，按 pid 定点查询远轻于全表扫描
      foreach ($f in $found) {
        try {
          $f.cmd = [string](Get-CimInstance Win32_Process -Filter "ProcessId = $($f.pid)" -Property CommandLine).CommandLine
        } catch { $f.cmd = '' }
      }
      $parentOf = @{}
      foreach ($p in $rows) { $parentOf[[int64]$p.ProcessId] = [int64]$p.ParentProcessId }
      $ancestorSet = @{}
      foreach ($f in $found) {
        $cur2 = $parentOf[[int64]$f.pid]
        # PID 复用可使系统快照的父链出现环；只需追溯到本次 wrapper，
        # 并为损坏或竞态快照保留 visited 防护，避免 discover 永久循环。
        $ancestorSeen = @{}
        while ($cur2 -gt 0 -and -not $ancestorSeen.ContainsKey($cur2)) {
          $ancestorSeen[$cur2] = $true
          $ancestorSet[$cur2] = $true
          if ($cur2 -eq $Id) { break }
          if (-not $parentOf.ContainsKey($cur2)) { break }
          $cur2 = $parentOf[$cur2]
        }
      }
      $launcherRe = 'npm-cli\.js|yarn\.js|pnpm(\.cjs|\.js)?|[\\/]\.pnpm[\\/]|plexus[.\-]classworlds|org\.gradle\.wrapper|gradle-launcher|GradleMain|^\s*(npm|npx|pnpm|yarn|bun)([ /]|$)|dotnet(?:\.exe)?["]?\s+run(?:\s|$)|php(?:\.exe)?["]?\s+artisan\s+serve(?:\s|$)'
      $leaves = @($found | Where-Object {
        -not ($ancestorSet.ContainsKey([int64]$_.pid) -and ([string]$_.cmd) -match $launcherRe)
      })
      if ($leaves.Count -eq 1) { $found = $leaves }
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

# wait-exit：阻塞等待已验证的受管目标退出并返回退出码（#102 command 模式）。
# 句柄在核验后一直持有，PID 复用不会把证据记到新进程；signal 在 Windows 无对应语义。
if ($Action -eq 'wait-exit') {
  $raw = [ProcUtil]::WaitExit([int]$Id, [long]$CreationFileTime, [string]$ReadyFile)
  $parts = $raw -split "`t"
  switch ($parts[0]) {
    'OK' { [pscustomobject]@{ result = 'exited'; code = [int]$parts[1]; signal = $null } | ConvertTo-Json -Compress }
    'NOTFOUND' { [pscustomobject]@{ result = 'notfound' } | ConvertTo-Json -Compress }
    'MISMATCH' { [pscustomobject]@{ result = 'mismatch'; field = [string]$parts[1] } | ConvertTo-Json -Compress }
    default {
      $w = $null
      if ($parts.Length -gt 2) { $w = [int]$parts[2] }
      [pscustomobject]@{ result = 'error'; code = [string]$parts[1]; win32 = $w } | ConvertTo-Json -Compress
    }
  }
  exit 0
}

# terminate-tree 的后代枚举：Win32_Process 按 ParentProcessId BFS。
# 只取拓扑（pid/ppid）：WMI 的 CreationDate 精度远低于内核 FILETIME，不能当
# 核验身份用；后代身份在杀的时候由 ProcUtil.Capture 现采（与 Terminate 同源）。
function Get-Descendants([int64]$rootPid) {
  $rows = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $byParent = @{}
  foreach ($p in $rows) {
    $pp = [int64]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = [System.Collections.ArrayList]@() }
    [void]$byParent[$pp].Add([int64]$p.ProcessId)
  }
  $found = @()
  $queue = [System.Collections.ArrayList]@([int64]$rootPid)
  $seen = @{}
  while ($queue.Count -gt 0) {
    $cur = $queue[0]; $queue.RemoveAt(0)
    $kids = $byParent[$cur]
    if (-not $kids) { continue }
    foreach ($c in $kids) {
      if ($seen.ContainsKey($c)) { continue }
      $seen[$c] = $true
      $found += $c
      [void]$queue.Add($c)
    }
  }
  return $found
}

# descendants：枚举目标 pid 当时仍在的后代（PPID 树，含多级），供 stop --tree 在终止
# 目标前留证（#39）。只向下遍历，不向上爬、不认领外部进程。
if ($Action -eq 'descendants') {
  $rows = @()
  try {
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath -ErrorAction SilentlyContinue)
  } catch {
    '[]'
    exit 0
  }
  $byParent = @{}
  $imageById = @{}
  foreach ($p in $rows) {
    $procId = [int64]$p.ProcessId
    $pp = [int64]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = [System.Collections.ArrayList]@() }
    [void]$byParent[$pp].Add($procId)
    $imageById[$procId] = [string]$p.ExecutablePath
  }
  $out = @()
  $queue = [System.Collections.ArrayList]@([int64]$Id)
  $seen = @{}
  while ($queue.Count -gt 0) {
    $cur = $queue[0]; $queue.RemoveAt(0)
    $kids = $byParent[$cur]
    if (-not $kids) { continue }
    foreach ($c in $kids) {
      if ($seen.ContainsKey($c)) { continue }
      $seen[$c] = $true
      [void]$queue.Add($c)
      $out += [pscustomobject]@{ pid = [int]$c; image = [string]$imageById[$c] }
    }
  }
  if (@($out).Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress }
  exit 0
}

if ($Action -eq 'terminate-tree') {
  # 与 Linux terminateTree 同语义：先核验根身份，再终止快照后代，最后终止根。
  # 后代不再裸杀：先 Capture 采自身身份，再用同句柄核验+终止的 Terminate 原语——
  # 快照到发信号之间若发生 PID 复用，终止句柄上的身份核验会拒绝误伤。
  $v = Parse-Result ([ProcUtil]::Verify($Id, [long]$CreationFileTime, $Image))
  if ($v.result -ne 'ok') { $v | ConvertTo-Json -Compress; exit 0 }
  $killed = @()
  try {
    foreach ($k in (Get-Descendants $Id)) {
      $cpid = [int64]$k
      $raw = [ProcUtil]::Capture([int]$cpid)
      $parts = $raw -split "`t", 3
      if ($parts[0] -ne 'OK') { continue } # 已退出/身份不可采：不触碰
      # 后代给 500ms 短等窗：waitMs=0 时 TerminateProcess 发出即返回，一律被计为
      # terminateTimeout，无法区分"终止失败"与"发出即算"，killedPids 语义含糊。
      $r = Parse-Result ([ProcUtil]::Terminate([int]$cpid, [long]$parts[1], [string]$parts[2], 500))
      if ($r.result -in 'terminated', 'terminateTimeout') { $killed += $cpid }
    }
  } catch { }
  $t = Parse-Result ([ProcUtil]::Terminate($Id, [long]$CreationFileTime, $Image, $WaitMs))
  # PSCustomObject 不能直接赋值新属性（会抛“找不到属性 killedPids”导致 terminate-tree 必败）
  $t | Add-Member -NotePropertyName killedPids -NotePropertyValue @($killed) -Force
  $t | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'grace') {
  # --grace：C# 侧持有已核验句柄执行 taskkill（无 /F）并用同一句柄等待退出——
  # 句柄存活期内 PID 不复用，没有"核验后关句柄再按裸 PID 发信号"的窗口。
  # 控制台程序多半不响应 WM_CLOSE：超时仍存活返回 stillAlive，由调用方回退强杀。
  $raw = [ProcUtil]::Grace($Id, [long]$CreationFileTime, $Image, $WaitMs)
  if ($raw -eq 'GRACE_DONE') {
    [pscustomobject]@{ result = 'gracefulTerminated' } | ConvertTo-Json -Compress
    exit 0
  }
  if ($raw -eq 'GRACE_ALIVE') {
    [pscustomobject]@{ result = 'stillAlive' } | ConvertTo-Json -Compress
    exit 0
  }
  Convert-Result $raw
  exit 0
}

$raw = switch ($Action) {
  'capture' { [ProcUtil]::Capture($Id) }
  'verify' { [ProcUtil]::Verify($Id, [long]$CreationFileTime, $Image) }
  'terminate' { [ProcUtil]::Terminate($Id, [long]$CreationFileTime, $Image, $WaitMs) }
}

Convert-Result $raw
exit 0
