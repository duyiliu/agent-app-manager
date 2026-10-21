param([Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$Port)
$ErrorActionPreference = 'Stop'
try {
  $rows = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
    $pidValue = [int]$_.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    [pscustomobject]@{ pid=$pidValue; processName=$(if($proc){[IO.Path]::GetFileName($proc.ExecutablePath)}else{$null}); executablePath=$(if($proc){$proc.ExecutablePath}else{$null}); commandLine=$null; startedAt=$(if($proc){$proc.CreationDate}else{$null}); localAddress=$_.LocalAddress; localPort=$_.LocalPort }
  })
  $rows | ConvertTo-Json -Compress -Depth 4
} catch {
  [pscustomobject]@{ error=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
