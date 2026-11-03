param([string]$Mode, [int]$RootId, [int]$SentinelId, [string]$RootTime, [string]$RootImage)
# 只在测试进程中替换 CIM 快照：把真实的旧哨兵挂到新根 PID，模拟父 PID 复用。
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter, [string[]]$Property)
  $query = @{ ClassName = $ClassName }
  if ($Filter) { $query.Filter = $Filter }
  if ($Property) { $query.Property = $Property }
  foreach ($row in @(CimCmdlets\Get-CimInstance @query)) {
    if (-not $Filter -and [int]$row.ProcessId -eq $SentinelId) {
      [pscustomobject]@{ ProcessId=$row.ProcessId; ParentProcessId=$RootId; CreationDate=$row.CreationDate; ExecutablePath=$row.ExecutablePath }
    } else { $row }
  }
}
& "$PSScriptRoot/../ps/proc.ps1" -Action $Mode -Id $RootId -Image $RootImage -CreationFileTime $RootTime -WaitMs 5000
