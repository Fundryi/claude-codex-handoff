'use strict';

const { spawn } = require('node:child_process');

// Keep script source fixed: task/session titles enter only through child env.
// The retired notify-rust tray used this same PowerShell AppUserModelID.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$heading = [System.Security.SecurityElement]::Escape($env:AI_LIVE_VIEWER_NOTIFY_SUMMARY)
$body = [System.Security.SecurityElement]::Escape($env:AI_LIVE_VIEWER_NOTIFY_TITLE)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">' + $heading + '</text><text id="2">' + $body + '</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

const MACOS_SCRIPT = 'display notification (system attribute "AI_LIVE_VIEWER_NOTIFY_TITLE") with title (system attribute "AI_LIVE_VIEWER_NOTIFY_SUMMARY") subtitle "AI Live Viewer"';

function notificationText(value) {
  return (typeof value === 'string' ? value : '').slice(0, 200).toWellFormed()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
}

function ignoreNotificationError() {}

function notifyDesktop(input) {
  try {
    const { summary, title } = input || {};
    const heading = notificationText(summary);
    const body = notificationText(title);
    let command;
    let args;
    const options = {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
      killSignal: 'SIGKILL',
    };
    if (process.platform === 'linux') {
      command = 'notify-send';
      // The separator also prevents a title starting with '-' becoming an option.
      args = ['--app-name', 'AI Live Viewer', '--', heading, body];
    } else if (process.platform === 'win32' || process.platform === 'darwin') {
      options.env = {
        ...process.env,
        AI_LIVE_VIEWER_NOTIFY_SUMMARY: heading,
        AI_LIVE_VIEWER_NOTIFY_TITLE: body,
      };
      command = process.platform === 'win32' ? 'powershell.exe' : 'osascript';
      args = process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]
        : ['-e', MACOS_SCRIPT];
    } else {
      return;
    }
    const child = spawn(command, args, options);
    child.on('error', ignoreNotificationError);
    child.unref();
  } catch {
    // Desktop tools are optional; notifications must never interrupt the server.
  }
}

module.exports = { notifyDesktop };
