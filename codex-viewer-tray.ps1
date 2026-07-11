# Codex Live Viewer - tray mode
# Runs the server hidden and puts an icon in the system tray.
# Double-click icon = open viewer. Right-click = Open / Exit.

$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$port = if ($env:CODEX_VIEWER_PORT) { $env:CODEX_VIEWER_PORT } else { "8377" }
$url  = "http://localhost:$port"
$js   = Join-Path $PSScriptRoot "codex-live-viewer.js"

# already running? just open the browser and add the tray icon anyway
$server = Start-Process node -ArgumentList "`"$js`" serve" -WindowStyle Hidden -PassThru

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = "Codex Live Viewer ($url)"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open viewer", $null, { Start-Process $url })
[void]$menu.Items.Add("Exit", $null, {
    $icon.Visible = $false
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $url })

Start-Process $url
[System.Windows.Forms.Application]::Run()

# safety net: if the message loop ends any other way, kill the server too
if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
