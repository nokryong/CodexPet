const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeClaudeAccountMetadata,
  readClaudeAccountMetadata,
} = require("../src/claude-account-metadata");
const { ClaudeAccountSwitcher } = require("../src/claude-account-switcher");
const { atomicWrite } = require("../src/provider-profile-store");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-claude-meta-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function claudeSecret(refreshToken) {
  return {
    claudeAiOauth: {
      accessToken: `access-${refreshToken}`,
      refreshToken,
      subscriptionType: "pro",
    },
  };
}

test("Claude 계정 메타데이터는 CLI 버전별 이메일 필드 위치를 정규화한다", () => {
  assert.deepEqual(
    normalizeClaudeAccountMetadata({ email: "top@example.com", subscriptionType: "max" }),
    { email: "top@example.com", plan: "max" }
  );
  assert.deepEqual(
    normalizeClaudeAccountMetadata({ account: { emailAddress: "nested@example.com", seatTier: "pro" } }),
    { email: "nested@example.com", plan: "pro" }
  );
});

test("Claude CLI 조회가 없어도 로컬 oauthAccount 이메일로 현재 프로필을 표시한다", (t) => {
  const home = tempHome(t);
  atomicWrite(path.join(home, ".claude", ".credentials.json"), claudeSecret("alpha"));
  atomicWrite(path.join(home, ".claude.json"), {
    oauthAccount: {
      emailAddress: "Claude.User@Example.com",
      seatTier: "pro",
    },
  });

  const local = readClaudeAccountMetadata(home);
  const profile = new ClaudeAccountSwitcher({ home }).snapshotCurrent();

  assert.equal(local.email, "Claude.User@Example.com");
  assert.equal(profile.email, "claude.user@example.com");
  assert.equal(profile.label, "claude.user@example.com");
  assert.equal(profile.plan, "pro");
});
