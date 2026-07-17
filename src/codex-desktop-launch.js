function buildWindowsCodexLaunchScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
$registeredApp = Get-StartApps | Where-Object {
  $_.AppID -like 'OpenAI.Codex_*!App'
} | Select-Object -First 1

if ($registeredApp) {
  $shellTarget = "shell:AppsFolder\$($registeredApp.AppID)"
  Start-Process -FilePath 'explorer.exe' -ArgumentList @($shellTarget)
} else {
  $appExe = Get-ChildItem -LiteralPath 'C:\Program Files\WindowsApps' -Filter 'OpenAI.Codex_*' -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object {
      @(
        (Join-Path $_.FullName 'app\ChatGPT.exe'),
        (Join-Path $_.FullName 'app\Codex.exe')
      )
    } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

  if (-not $appExe) {
    throw 'Codex Desktop registered app or executable was not found.'
  }
  Start-Process -FilePath $appExe
}

Write-Output 'Codex Desktop launch requested.'
`.trim();
}

module.exports = { buildWindowsCodexLaunchScript };
