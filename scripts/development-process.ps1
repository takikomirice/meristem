param(
  [Parameter(Mandatory=$true)][ValidateSet('idle','identify','status','stop')][string]$Action,
  [Parameter(Mandatory=$true)][string]$RequestJson
)
$ErrorActionPreference = 'Stop'
$request = $RequestJson | ConvertFrom-Json
function Processes { @(Get-CimInstance Win32_Process -ErrorAction Stop) }
function ProfileMatches($item) {
  $item.ExecutablePath -and $item.ExecutablePath -ieq $request.executable -and
    $item.CommandLine -and $item.CommandLine.Contains('--user-data-dir') -and
    $item.CommandLine.IndexOf($request.profile, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
$all = Processes
if ($Action -eq 'idle') {
  if (@($all | Where-Object { ProfileMatches $_ }).Count) { throw 'Dedicated profile already has a process' }
  if (@($all | Where-Object { $_.Name -ieq ([IO.Path]::GetFileName($request.executable)) -and -not $_.CommandLine }).Count) { throw 'Process inventory incomplete' }
  @{state='stopped'} | ConvertTo-Json -Compress
  exit
}
$root = $all | Where-Object { $_.ProcessId -eq $request.pid } | Select-Object -First 1
if (-not $root -or -not (ProfileMatches $root)) { throw 'Process identity unavailable' }
$rootHandle = [Diagnostics.Process]::GetProcessById([int]$request.pid)
$null = $rootHandle.Handle
$created = $rootHandle.StartTime.ToFileTimeUtc().ToString()
try {
  if ($rootHandle.Path -ine $request.executable -or [Math]::Abs(($rootHandle.StartTime.ToUniversalTime() - $root.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) { throw 'Process identity changed during inventory' }
  if ($Action -eq 'identify') {
    @{pid=[int]$root.ProcessId; created=$created; executable=$rootHandle.Path} | ConvertTo-Json -Compress
    exit
  }
  if ($created -ne $request.created) { throw 'Process creation identity changed' }
  if ($Action -eq 'status') { @{state='running'} | ConvertTo-Json -Compress; exit }
  $tree = @($root)
  do {
    $extra = @($all | Where-Object {
      $item = $_
      -not ($tree.ProcessId -contains $item.ProcessId) -and @($tree | Where-Object {
        $_.ProcessId -eq $item.ParentProcessId -and $_.CreationDate -le $item.CreationDate
      }).Count -gt 0
    })
    $tree += $extra
  } while ($extra.Count)
  $handles = @()
  try {
    foreach ($item in $tree) {
      $handle = [Diagnostics.Process]::GetProcessById([int]$item.ProcessId)
      $null = $handle.Handle
      if ([Math]::Abs(($handle.StartTime.ToUniversalTime() - $item.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1 -or $handle.Path -ine $item.ExecutablePath) { $handle.Dispose(); throw 'Descendant identity changed' }
      $handles += $handle
    }
    # A dirty editor may veto closing. Never bypass its save prompt with Kill().
    if (-not $rootHandle.CloseMainWindow()) { throw 'Normal window closure unavailable' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    foreach ($handle in $handles) {
      $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      if (-not $handle.WaitForExit($remaining)) { throw 'Process exit unknown' }
    }
    $remainingProcesses = Processes
    # A new surviving process may be a grandchild whose intermediate parent
    # already exited. Without a creation trace/job, conservatively retain ownership.
    if (@($remainingProcesses | Where-Object {
      $item = $_
      -not @($all | Where-Object { $_.ProcessId -eq $item.ProcessId -and $_.CreationDate -eq $item.CreationDate }).Count
    }).Count) { throw 'New process lineage unconfirmed' }
    # Include children created after the initial capture. Even one survivor is unknown.
    if (@($remainingProcesses | Where-Object {
      $item = $_
      (ProfileMatches $item) -or @($tree | Where-Object {
        $_.ProcessId -eq $item.ParentProcessId -and $_.CreationDate -le $item.CreationDate
      }).Count -gt 0
    }).Count) { throw 'Owned descendants or dedicated profile still present' }
    @{state='stopped'} | ConvertTo-Json -Compress
  } finally { foreach ($handle in $handles) { $handle.Dispose() } }
} finally { $rootHandle.Dispose() }
