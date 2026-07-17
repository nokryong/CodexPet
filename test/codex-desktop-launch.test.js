const test = require("node:test");
const assert = require("node:assert/strict");

const { buildWindowsCodexLaunchScript } = require("../src/codex-desktop-launch");

test("Windows Codex Desktop 실행은 등록 앱을 사용하고 설치파일 다운로드 CLI를 호출하지 않는다", () => {
  const script = buildWindowsCodexLaunchScript();

  assert.match(script, /Get-StartApps/);
  assert.match(script, /OpenAI\.Codex_\*!App/);
  assert.match(script, /shell:AppsFolder/);
  assert.match(script, /app\\ChatGPT\.exe/);
  assert.doesNotMatch(script, /\bcodex(?:\.exe)?\s+app\b/i);
  assert.doesNotMatch(script, /Installer\.exe/i);
});
