$ErrorActionPreference = 'Stop'
try {
    if (Get-Process -Name 'Sandustry' -ErrorAction SilentlyContinue) {
        throw 'Close Sandustry before installing or restoring.'
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js 18+ is required. Install the LTS version from nodejs.org first.'
    }
    $major = [int]((& node --version) -replace '^v(\d+).*$', '$1')
    if ($major -lt 18) { throw 'Node.js 18 or newer is required.' }
    $archive = Read-Host 'app.asar path (Enter = D:\Allgame\Sandustry\Content\resources\app.asar)'
    if ([string]::IsNullOrWhiteSpace($archive)) {
        $archive = 'D:\Allgame\Sandustry\Content\resources\app.asar'
    }
    $archive = $archive.Trim('"')
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'Archive not found.' }
    Write-Host 'TEST PANEL ONLY: no mining yet. This modifies app.asar and makes a full backup.'
    Write-Host 'Game launch compatibility is unverified. Close the game and use RESTORE if launch fails.'
    $mode = Read-Host 'Type INSTALL to install, or RESTORE to restore the original'
    switch ($mode.ToUpperInvariant()) {
        'INSTALL' { $action = 'install' }
        'RESTORE' { $action = 'restore' }
        default { throw 'Cancelled. No changes made.' }
    }
    & node (Join-Path $PSScriptRoot '..\tools\asar-probe.mjs') $action $archive --game-closed
    if ($LASTEXITCODE -ne 0) { throw 'Operation failed. Read the error above. Do not delete backup files.' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
Read-Host 'Press Enter to close'
