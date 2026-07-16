const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFontRegistryScript,
  getInstalledFonts,
  normalizeFontNames,
} = require("../src/installed-fonts");

test("Windows 글꼴 조회는 PowerShell 출력을 명시적으로 UTF-8로 고정한다", async () => {
  let invocation = null;
  const run = (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null, "맑은 고딕 (TrueType)\r\nOrbit Regular (OpenType)\r\n");
  };

  const fonts = await getInstalledFonts({ run, platform: "win32" });
  assert.deepEqual(fonts, ["맑은 고딕", "Orbit Regular"].sort((a, b) => a.localeCompare(b, "ko")));
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(buildFontRegistryScript(), /OutputEncoding.*UTF8Encoding/);
  assert.match(buildFontRegistryScript(), /PresentationCore.*SystemFontFamilies/s);
});

test("글꼴 이름은 타입 꼬리표, 세로쓰기 별칭, 중복을 제거한다", () => {
  assert.deepEqual(
    normalizeFontNames(["맑은 고딕 (TrueType)", "@맑은 고딕", "맑은 고딕", "Arial (OpenType)"]),
    ["맑은 고딕", "Arial"].sort((a, b) => a.localeCompare(b, "ko"))
  );
});
