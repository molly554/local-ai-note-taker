# Smoke test on a Windows runner (no microphone): output shape, ConsentStore reading through fake entries under
# HKCU, running programs, and a window title. Usage: pwsh smoke/windows.ps1 path\to\yogurt-system.exe
param([string]$Bin)
$ErrorActionPreference = 'Stop'
$Bin = (Resolve-Path $Bin).Path
function Check($what, [scriptblock]$ok, $raw) {
  $v = $raw | ConvertFrom-Json -NoEnumerate
  if (-not (& $ok $v)) { throw "failed: $what`n$raw" }
  Write-Host "ok: $what"
}

$raw = & $Bin mic-apps
Check 'mic-apps is a JSON list' { param($v) $v -is [array] } $raw

# fake privacy entries: in use by this shell, in use by a program not running (a crash), ended, and a Store app
$store = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
$hk = [Microsoft.Win32.Registry]::CurrentUser
$qword = [Microsoft.Win32.RegistryValueKind]::QWord
function Entry($path, [long]$start, [long]$stop) {
  $k = $hk.CreateSubKey("$store\$path")
  $k.SetValue('LastUsedTimeStart', $start, $qword)
  $k.SetValue('LastUsedTimeStop', $stop, $qword)
  $k.Close()
}
$shell = (Get-Process -Id $PID).Path -replace '\\', '#'
Entry "NonPackaged\$shell" 133700000000000000 0
Entry 'NonPackaged\C:#Fake#notrunninghere.exe' 133700000000000000 0
Entry 'NonPackaged\C:#Windows#System32#svchost.exe' 133700000000000000 133700000100000000
Entry 'Fake.Package_abcd1234efgh' 133700000000000000 0
$me = (Split-Path (Get-Process -Id $PID).Path -Leaf).ToLower()

$raw = & $Bin mic-apps
Write-Host "mic-apps: $raw"
Check "an app in use is listed as $me" { param($v) @($v | Where-Object { $_.bundleId -eq $me -and $_.pid -gt 0 -and $_.name }).Count -eq 1 } $raw
Check 'an app that is not running is not' { param($v) -not ($v | Where-Object { $_.bundleId -eq 'notrunninghere.exe' }) } $raw
Check 'an ended entry is not' { param($v) -not ($v | Where-Object { $_.bundleId -eq 'svchost.exe' }) } $raw
Check 'keys like the Mac helper' { param($v) @($v | Where-Object { (($_.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'bundleId,name,pid' }).Count -eq 0 } $raw

Check 'running apps in the order asked' { param($v) ($v -join ',') -eq "$me,svchost.exe" } (& $Bin running-apps $me notrunninghere.exe SVCHOST.EXE | ForEach-Object { $_.ToLower() })

# a window with a known title in another process
$title = 'Meet - abc-defg-hij'
$form = "Add-Type -AssemblyName System.Windows.Forms; `$f = New-Object System.Windows.Forms.Form; `$f.Text = '$title'; [System.Windows.Forms.Application]::Run(`$f)"
$p = Start-Process powershell.exe -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $form -PassThru
try {
  # a cold runner can take a while to load Windows Forms
  for ($i = 0; $i -lt 60; $i++) {
    $raw = & $Bin browser-title powershell.exe
    if (($raw | ConvertFrom-Json).title) { break }
    Start-Sleep -Milliseconds 500
  }
  Check 'the window title' { param($v) $v.title -eq $title } $raw
} finally { Stop-Process -Id $p.Id -Force }
Check 'no window for an app that is not open' { param($v) $null -eq $v.title } (& $Bin browser-title notrunninghere.exe)

& $Bin browser-title 2>$null
if ($LASTEXITCODE -eq 0) { throw 'browser-title with no id should fail' }
Write-Host 'all Windows smoke checks passed'
exit 0
