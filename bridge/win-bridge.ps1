# Light Windows bridge.
# Long-lived poller that emits newline-delimited JSON to stdout:
#   {"kind":"media", ...}         - current media transport state (every tick)
#   {"kind":"notification", ...}  - each NEW toast notification (deduped by id)
#   {"kind":"ready"}              - emitted once after init
# Everything is local; nothing leaves the machine.

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($task, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $netTask = $m.Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# ---- Init media manager ----
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mediaMgr = $null
try {
  $mediaMgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch { $mediaMgr = $null }

Emit @{ kind = "ready"; media = ($null -ne $mediaMgr) }

$lastMediaKey = ""

function Poll-Media {
  if ($null -eq $script:mediaMgr) { return }

  $hasMedia = $false
  $isPlaying = $false
  $title = ""
  $artist = ""
  $app = ""

  try {
    $session = $script:mediaMgr.GetCurrentSession()
    if ($null -ne $session) {
      # A killed player often leaves a session object that throws on property
      # access, or reports a Closed/Stopped status. Treat any of those as "gone".
      try {
        $info = $session.GetPlaybackInfo()
        $status = $info.PlaybackStatus
        $closed = (
          $status -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Closed
        )
        if (-not $closed) {
          $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
          $t = if ($props.Title) { "$($props.Title)".Trim() } else { "" }
          if ($t -ne "") {
            $hasMedia = $true
            $title = $t
            $artist = if ($props.Artist) { "$($props.Artist)".Trim() } else { "" }
            $app = "$($session.SourceAppUserModelId)"
            $isPlaying = ($status -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)
          }
        }
      } catch {
        $hasMedia = $false
      }
    }
  } catch {
    $hasMedia = $false
  }

  if ($hasMedia) {
    $key = "$isPlaying|$title|$artist|$app"
    if ($key -ne $script:lastMediaKey) {
      Emit @{ kind = "media"; playing = $isPlaying; title = $title; artist = $artist; app = $app }
      $script:lastMediaKey = $key
    }
  } else {
    if ($script:lastMediaKey -ne "none") {
      # No usable media session (player closed/killed) -> remove the card.
      Emit @{ kind = "media"; none = $true }
      $script:lastMediaKey = "none"
    }
  }
}

while ($true) {
  Poll-Media
  Start-Sleep -Milliseconds 1500
}
