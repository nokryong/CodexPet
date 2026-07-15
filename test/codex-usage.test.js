const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAccountSwitcher } = require("../src/codex-account-switcher");
const { rateWindowLabel } = require("../src/codex-usage-label");

function primary(seconds) {
  return { used_percent: 7, limit_window_seconds: seconds, reset_after_seconds: 30 };
}

test("Codex 사용량은 서버의 초 단위 주간 창을 5시간으로 추정하지 않는다", () => {
  const switcher = new CodexAccountSwitcher({ homeDir: process.cwd() });
  const windows = switcher.normalizeUsageWindows({ rate_limit: { primary_window: primary(604800) } });
  assert.equal(windows[0].window_minutes, 10080);
  assert.equal(rateWindowLabel(windows[0]), "주간 한도");
});

test("Codex 사용량은 명시된 300분과 월간 창을 동적으로 라벨링한다", () => {
  const switcher = new CodexAccountSwitcher({ homeDir: process.cwd() });
  const windows = switcher.normalizeUsageWindows({
    rate_limit: {
      primary_window: { used_percent: 2, window_minutes: 300 },
      secondary_window: primary(30 * 24 * 60 * 60),
    },
  });
  assert.equal(rateWindowLabel(windows[0]), "5시간 한도");
  assert.equal(rateWindowLabel(windows[1]), "월간 한도");
});

test("추가 및 코드 리뷰 한도는 scope를 보존하고 알 수 없는 기간을 하드코딩하지 않는다", () => {
  const switcher = new CodexAccountSwitcher({ homeDir: process.cwd() });
  const windows = switcher.normalizeUsageWindows({
    additional_rate_limits: [{
      limit_name: "GPT-5.3-Codex-Spark",
      rate_limit: { primary_window: primary(604800) },
    }],
    code_review_rate_limit: { primary_window: { used_percent: 0 } },
  });
  assert.equal(rateWindowLabel(windows[0]), "GPT-5.3-Codex-Spark · 주간 한도");
  assert.equal(rateWindowLabel(windows[1]), "코드 리뷰 · 사용 한도");
  assert.equal(windows[1].window_minutes, null);
});

test("새 이름의 기간 창도 기간 값으로 분류한다", () => {
  const switcher = new CodexAccountSwitcher({ homeDir: process.cwd() });
  const windows = switcher.normalizeUsageWindows({
    rate_limit: { monthly_window: primary(30 * 24 * 60 * 60) },
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].window_key, "monthly");
  assert.equal(rateWindowLabel(windows[0]), "월간 한도");
});

test("Codex는 활성 저장 프로필은 거부하고 비활성 auth 사본만 삭제한다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const switcher = new CodexAccountSwitcher({ homeDir: home });
  const liveAuth = path.join(home, ".codex", "auth.json");
  const profilePath = path.join(home, ".codepet", "codex-switch", "profiles", "inactive");
  fs.mkdirSync(path.dirname(liveAuth), { recursive: true });
  fs.mkdirSync(profilePath, { recursive: true });
  fs.writeFileSync(liveAuth, "live");
  fs.writeFileSync(path.join(profilePath, "auth.json"), "saved");

  switcher.getProfile = () => ({ key: "active", active: true, profilePath });
  assert.throws(() => switcher.deleteProfile("active"), /현재 사용 중/);
  switcher.getProfile = () => ({ key: "inactive", active: false, profilePath });
  switcher.deleteProfile("inactive");
  assert.equal(fs.existsSync(profilePath), false);
  assert.equal(fs.readFileSync(liveAuth, "utf8"), "live");
});
