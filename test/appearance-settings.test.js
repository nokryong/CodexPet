const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeThemeSource,
  normalizeFontFamily,
  quoteFontFamily,
} = require("../src/appearance-settings");

test("테마는 light, dark, system만 허용하고 기본값은 light다", () => {
  assert.equal(normalizeThemeSource("light"), "light");
  assert.equal(normalizeThemeSource("dark"), "dark");
  assert.equal(normalizeThemeSource("system"), "system");
  assert.equal(normalizeThemeSource("unknown"), "light");
  assert.equal(normalizeThemeSource(null), "light");
});

test("글꼴은 실제 설치 목록의 안전한 패밀리명만 허용한다", () => {
  const installed = ["Malgun Gothic", "Arial"];
  assert.equal(normalizeFontFamily(" Malgun Gothic ", installed), "Malgun Gothic");
  assert.equal(normalizeFontFamily("Missing Font", installed), null);
  assert.equal(normalizeFontFamily("x; color:red", ["x; color:red"]), null);
  assert.equal(normalizeFontFamily("line\nbreak", ["line\nbreak"]), null);
});

test("CSS에 전달할 글꼴명은 따옴표와 역슬래시를 이스케이프한다", () => {
  assert.equal(quoteFontFamily('A"B'), '"A\\"B"');
  assert.equal(quoteFontFamily("A\\B"), '"A\\\\B"');
  assert.equal(quoteFontFamily(null), null);
});
