const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAccountSubmenu } = require("../src/account-submenu");

test("Codex용 공용 계정 메뉴는 저장 계정, 구분선, 로그인 순서로 평평하게 만든다", () => {
  const menu = buildAccountSubmenu({
    profiles: [
      { key: "alpha", label: "alpha@example.com", active: true, hasAuth: true },
      { key: "beta", label: "beta@example.com", active: false, hasAuth: true },
    ],
    formatLabel: (profile) => profile.active ? `${profile.label} (현재)` : profile.label,
    onSwitch: () => {},
    onLogin: () => {},
  });

  assert.deepEqual(menu.map((item) => item.type || item.label), ["radio", "radio", "separator", "로그인 / 계정 추가"]);
  assert.equal(menu[0].checked, true);
  assert.equal(menu[0].submenu, undefined);
  assert.equal(menu[3].click instanceof Function, true);
});
