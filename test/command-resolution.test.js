const test = require("node:test");
const assert = require("node:assert/strict");

const { commandNeedsShell, selectCommandPath } = require("../src/command-resolution");

test("Windows 명령 탐색은 npm의 확장자 없는 Unix shim보다 cmd 실행기를 선택한다", () => {
  const output = [
    "C:\\nvm4w\\nodejs\\claude",
    "C:\\nvm4w\\nodejs\\claude.cmd",
  ].join("\r\n");
  assert.equal(selectCommandPath(output, "win32"), "C:\\nvm4w\\nodejs\\claude.cmd");
  assert.equal(commandNeedsShell("C:\\nvm4w\\nodejs\\claude.cmd", "win32"), true);
});

test("Windows 명령 탐색은 셸 래퍼보다 네이티브 실행 파일을 우선한다", () => {
  const output = ["C:\\tools\\claude.cmd", "C:\\tools\\claude.exe"].join("\n");
  assert.equal(selectCommandPath(output, "win32"), "C:\\tools\\claude.exe");
  assert.equal(commandNeedsShell("C:\\tools\\claude.exe", "win32"), false);
  assert.equal(selectCommandPath("/usr/local/bin/claude\n", "linux"), "/usr/local/bin/claude");
});
