const { spawn } = require("node:child_process");

const SCRIPT = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CP {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("Advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr credential);
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
'@`;

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, { stdin = "", timeoutMs = 10000 } = {}) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows 자격 증명은 Windows에서만 사용할 수 있습니다."));
  }
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Windows 자격 증명 작업 시간이 초과됐습니다."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.once("error", () => finish(new Error("Windows 자격 증명 작업을 시작하지 못했습니다.")));
    child.once("close", (code) => {
      finish(code === 0 ? null : new Error("Windows 자격 증명 작업에 실패했습니다."), stdout.trim());
    });
    child.stdin.end(stdin);
  });
}

function readCredential(target) {
  const script = `${SCRIPT}
$pointer = [IntPtr]::Zero
if (-not [CP]::CredRead(${quotePowerShell(target)}, 1, 0, [ref]$pointer)) { exit 2 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CP+CREDENTIAL])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} finally {
  [CP]::CredFree($pointer)
}`;
  return runPowerShell(script);
}

function writeCredential(target, value, username = "antigravity") {
  const script = `${SCRIPT}
$json = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  $credential = New-Object CP+CREDENTIAL
  $credential.Type = 1
  $credential.TargetName = ${quotePowerShell(target)}
  $credential.UserName = ${quotePowerShell(username)}
  $credential.Persist = 2
  $credential.CredentialBlobSize = $bytes.Length
  $credential.CredentialBlob = $pointer
  if (-not [CP]::CredWrite([ref]$credential, 0)) { exit 2 }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
}`;
  // 비밀 값은 명령 인수가 아니라 stdin으로만 전달합니다.
  return runPowerShell(script, { stdin: JSON.stringify(value) });
}

function deleteCredential(target) {
  const script = `${SCRIPT}
if ([CP]::CredDelete(${quotePowerShell(target)}, 1, 0)) { exit 0 }
$code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($code -eq 1168) { exit 0 }
exit 2`;
  return runPowerShell(script).then(() => undefined);
}

module.exports = { deleteCredential, readCredential, writeCredential };
