# Light media control. Usage: media-control.ps1 <action>
# action: next | prev | playpause | play | pause
param([Parameter(Mandatory = $true)][string]$Action)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($task, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $netTask = $m.Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $mgr.GetCurrentSession()
if ($null -eq $session) { Write-Output "no-session"; exit 1 }

switch ($Action) {
  "next" { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
  "prev" { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
  "playpause" { Await ($session.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
  "play" { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
  "pause" { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
  default { Write-Output "unknown-action"; exit 2 }
}
Write-Output "ok"
