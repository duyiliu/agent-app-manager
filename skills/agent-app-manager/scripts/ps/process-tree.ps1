# 按同一快照中的创建时间验证父子关系；旧进程不能成为复用 PID 后的新进程的后代。
function Get-ProcessTreeRows($rows, [long]$rootPid) {
  $byId = @{}
  foreach ($row in $rows) { $byId[[long]$row.ProcessId] = $row }
  if (-not $byId.ContainsKey($rootPid) -or -not $byId[$rootPid].CreationDate) { return }
  $byParent = @{}
  foreach ($row in $rows) {
    $parentId = [long]$row.ParentProcessId
    if (-not $row.CreationDate -or -not $byId.ContainsKey($parentId)) { continue }
    $parent = $byId[$parentId]
    if (-not $parent.CreationDate -or $row.CreationDate -lt $parent.CreationDate) { continue }
    if (-not $byParent.ContainsKey($parentId)) { $byParent[$parentId] = @() }
    $byParent[$parentId] += $row
  }
  $seen = @{ $rootPid = $true }
  $queue = [System.Collections.Generic.Queue[long]]::new()
  $queue.Enqueue($rootPid)
  while ($queue.Count) {
    $parentId = $queue.Dequeue()
    foreach ($row in $byParent[$parentId]) {
      if ($null -eq $row) { continue }
      $childId = [long]$row.ProcessId
      if ($seen.ContainsKey($childId)) { continue }
      $seen[$childId] = $true
      $row
      $queue.Enqueue($childId)
    }
  }
}

# CIM 时间只有微秒精度；只用它核对采样时仍是同一实例，操作身份保留内核 FILETIME。
function Get-SnapshotIdentity($row) {
  if (-not $row.CreationDate) { return $null }
  $parts = ([ProcUtil]::Capture([int]$row.ProcessId)) -split "`t", 3
  if ($parts[0] -ne 'OK') { return $null }
  $delta = [long]$parts[1] - [long]$row.CreationDate.ToFileTime()
  if ($delta -lt 0 -or $delta -gt 9) { return $null }
  return [pscustomobject]@{ pid = [int]$row.ProcessId; image = [string]$parts[2]; creationFileTime = [string]$parts[1] }
}
