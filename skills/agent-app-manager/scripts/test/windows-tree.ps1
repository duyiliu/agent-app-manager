. "$PSScriptRoot/../ps/process-tree.ps1"
function Row($id, $parent, $seconds) {
  [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent; CreationDate = if ($null -eq $seconds) { $null } else { [datetime]'2026-01-01T00:00:00Z' + [timespan]::FromSeconds($seconds) } }
}
$rows = @((Row 10 0 100), (Row 11 10 101), (Row 12 11 102), (Row 20 11 1), (Row 21 20 103), (Row 30 10 $null))
$ids = @(Get-ProcessTreeRows $rows 10 | ForEach-Object { $_.ProcessId })
if (($ids -join ',') -ne '11,12') { throw "错误后代：$ids" }
if (@(Get-ProcessTreeRows $rows 999).Count) { throw '根缺失时不应遍历' }
$cycle = @((Row 10 11 100), (Row 11 10 100))
$ids = @(Get-ProcessTreeRows $cycle 10 | ForEach-Object { $_.ProcessId })
if (($ids -join ',') -ne '11') { throw '环不能重复返回根' }
'进程树快照：正常多级、旧孤儿、缺失时间、缺失根、父链环通过'
