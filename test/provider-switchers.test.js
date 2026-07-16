const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProviderProfileStore, atomicWrite } = require("../src/provider-profile-store");
const { AntigravityAccountSwitcher } = require("../src/antigravity-account-switcher");
const { ClaudeAccountSwitcher } = require("../src/claude-account-switcher");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-provider-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function claudeSecret(refreshToken, extra = {}) {
  return {
    claudeAiOauth: { accessToken: `access-${refreshToken}`, refreshToken, ...extra },
  };
}

function agySecret(refreshToken) {
  return { token: { access_token: `access-${refreshToken}`, refresh_token: refreshToken } };
}

test("프로필 목록은 비밀 값을 내보내지 않고 기존 메타데이터를 보존한다", (t) => {
  const home = tempHome(t);
  const store = new ProviderProfileStore("claude", home);
  const first = store.save({
    secret: claudeSecret("alpha"),
    email: "alpha@example.com",
    plan: "pro",
    active: true,
  });
  store.save({ secret: claudeSecret("alpha"), active: true });
  const listed = store.list();

  assert.equal(first.email, "alpha@example.com");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, "alpha@example.com");
  assert.equal(listed[0].plan, "pro");
  assert.equal(listed[0].active, true);
  assert.equal(Object.hasOwn(listed[0], "secret"), false);
});

test("Claude 토큰 회전과 재로그인은 이메일 기준의 한 프로필로 병합한다", (t) => {
  const home = tempHome(t);
  const store = new ProviderProfileStore("claude", home);
  const firstSecret = claudeSecret("first", { refreshTokenExpiresAt: 1_780_000_001_000 });
  const rotatedSecret = claudeSecret("rotated", { refreshTokenExpiresAt: 1_780_000_002_500 });
  const reloggedSecret = claudeSecret("relogged", { refreshTokenExpiresAt: 1_790_000_000_000 });

  store.save({ secret: firstSecret, active: true });
  const promoted = store.save({
    secret: rotatedSecret,
    email: "Person@Example.com",
    plan: "pro",
    active: true,
  });
  store.save({
    secret: reloggedSecret,
    email: "person@example.com",
    active: true,
  });

  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key, promoted.key);
  assert.equal(listed[0].email, "person@example.com");
  assert.equal(listed[0].plan, "pro");
  assert.equal(listed[0].active, true);
  assert.equal(store.findKeyBySecret(reloggedSecret), promoted.key);
});

test("AGY 전환은 선택한 자격 증명을 쓰고 활성 계정과 계정 힌트를 갱신한다", async (t) => {
  const home = tempHome(t);
  const store = new ProviderProfileStore("antigravity", home);
  let live = agySecret("alpha");
  let restartCount = 0;
  const switcher = new AntigravityAccountSwitcher({
    home,
    store,
    read: async () => live,
    write: async (value) => {
      live = value;
    },
    restart: async () => {
      restartCount += 1;
    },
  });
  switcher.store.save({
    secret: agySecret("beta"),
    email: "beta@example.com",
    plan: "Google AI Pro",
  });
  const beta = switcher.listProfiles().find((profile) => profile.email === "beta@example.com");
  const result = await switcher.switchToProfile(beta.key);

  assert.equal(live.token.refresh_token, "beta");
  assert.equal(restartCount, 1);
  assert.equal(result.active, true);
  assert.equal(Object.hasOwn(result, "secret"), false);
  assert.equal(switcher.listProfiles().find((profile) => profile.key === beta.key).active, true);
  const accountHint = JSON.parse(
    fs.readFileSync(path.join(home, ".gemini", "google_accounts.json"), "utf8")
  );
  assert.equal(accountHint.active, "beta@example.com");
});

test("AGY 첫 로그인은 저장할 현재 계정이 없어도 자격 증명을 비우고 앱을 연다", async (t) => {
  const home = tempHome(t);
  let clearCount = 0;
  let restartCount = 0;
  const switcher = new AntigravityAccountSwitcher({
    home,
    read: async () => {
      throw new Error("credential not found");
    },
    clear: async () => {
      clearCount += 1;
    },
    restart: async () => {
      restartCount += 1;
    },
  });

  await switcher.prepareLogin();

  assert.equal(clearCount, 1);
  assert.equal(restartCount, 1);
  assert.deepEqual(switcher.listProfiles(), []);
});

test("AGY 새 로그인 준비는 이전 계정 이메일 힌트를 활성 상태에서 제거한다", async (t) => {
  const home = tempHome(t);
  const accountFile = path.join(home, ".gemini", "google_accounts.json");
  atomicWrite(accountFile, { active: "old@example.com", old: ["older@example.com"] });
  const switcher = new AntigravityAccountSwitcher({
    home,
    read: async () => agySecret("old"),
  });

  await switcher.prepareLogin();
  const hint = JSON.parse(fs.readFileSync(accountFile, "utf8"));
  assert.equal(Object.hasOwn(hint, "active"), false);
  assert.deepEqual(hint.old, ["older@example.com", "old@example.com"]);
});

test("AGY는 로컬 계정 힌트를 사용량 조회와 무관하게 이메일로 저장한다", async (t) => {
  const home = tempHome(t);
  const accountFile = path.join(home, ".gemini", "google_accounts.json");
  atomicWrite(accountFile, { active: "agy@example.com", old: [] });
  const switcher = new AntigravityAccountSwitcher({
    home,
    read: async () => agySecret("hinted"),
  });

  const profile = await switcher.snapshotCurrent();
  assert.equal(profile.email, "agy@example.com");
  assert.equal(profile.label, "agy@example.com");
});

test("Claude 전환은 live 자격 파일을 원자 교체하고 새 계정을 활성 표시한다", async (t) => {
  const home = tempHome(t);
  const livePath = path.join(home, ".claude", ".credentials.json");
  atomicWrite(livePath, claudeSecret("alpha"));
  const switcher = new ClaudeAccountSwitcher({ home });
  switcher.snapshotCurrent({ email: "alpha@example.com", plan: "pro" });
  const beta = switcher.store.save({
    secret: claudeSecret("beta"),
    email: "beta@example.com",
    plan: "max",
  });

  const result = await switcher.switchToProfile(beta.key);
  const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
  assert.equal(live.claudeAiOauth.refreshToken, "beta");
  assert.equal(result.active, true);
  assert.equal(Object.hasOwn(result, "secret"), false);
  assert.equal(switcher.listProfiles().find((profile) => profile.key === beta.key).active, true);
});

test("비활성 저장 프로필만 삭제하고 활성 프로필 삭제는 거부한다", (t) => {
  const home = tempHome(t);
  const store = new ProviderProfileStore("claude", home);
  const active = store.save({ secret: claudeSecret("active"), active: true });
  const inactive = store.save({ secret: claudeSecret("inactive") });

  assert.throws(() => store.delete(active.key), /현재 사용 중/);
  assert.equal(store.delete(inactive.key).key, inactive.key);
  assert.equal(store.get(inactive.key), null);
});

test("Claude는 live 활성 계정의 저장 프로필 삭제를 거부한다", (t) => {
  const home = tempHome(t);
  atomicWrite(path.join(home, ".claude", ".credentials.json"), claudeSecret("active"));
  const switcher = new ClaudeAccountSwitcher({ home });
  switcher.snapshotCurrent({ email: "active@example.com" });
  const inactive = switcher.store.save({ secret: claudeSecret("inactive") });

  const active = switcher.listProfiles().find((profile) => profile.active);
  assert.throws(() => switcher.deleteProfile(active.key), /현재 사용 중/);
  assert.equal(switcher.deleteProfile(inactive.key).key, inactive.key);
});
