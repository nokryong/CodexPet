const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CodexAccountSwitcher } = require("../src/codex-account-switcher");

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function auth({ subject, email, accountId, planType = "team" }) {
  const authClaims = {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: planType,
  };

  return {
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      access_token: jwt({ sub: subject, email }),
      id_token: jwt({
        sub: subject,
        email,
        "https://api.openai.com/auth": authClaims,
      }),
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

test("같은 Business 워크스페이스의 서로 다른 사용자를 별도 Codex 프로필로 보존한다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-codex-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const switcher = new CodexAccountSwitcher({ homeDir: home });
  writeJson(switcher.profileAuthPath("second"), auth({
    subject: "user-second",
    email: "second@example.com",
    accountId: "shared-business-workspace",
  }));

  const pending = switcher.createLoginProfile();
  writeJson(path.join(pending.homePath, "auth.json"), auth({
    subject: "user-third",
    email: "third@example.com",
    accountId: "shared-business-workspace",
  }));

  const profiles = switcher.listProfiles();
  assert.equal(profiles.length, 2);
  assert.deepEqual(
    profiles.map((profile) => profile.email).sort(),
    ["second@example.com", "third@example.com"]
  );
});

test("같은 사용자의 Plus와 Business 워크스페이스를 별도 Codex 프로필로 구분한다", () => {
  const switcher = new CodexAccountSwitcher({ homeDir: process.cwd() });

  assert.equal(switcher.sameIdentity(
    { subject: "same-user", email: "user@example.com", accountId: "personal", planType: "plus" },
    { subject: "same-user", email: "user@example.com", accountId: "business", planType: "team" }
  ), false);

  assert.equal(switcher.sameIdentity(
    { subject: "same-user", email: "user@example.com", accountId: "business", planType: "team" },
    { subject: "same-user", email: "user@example.com", accountId: "business", planType: "team" }
  ), true);
});

test("저장된 Codex 계정 사용량을 live 계정 전환 없이 조회한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-codex-usage-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const switcher = new CodexAccountSwitcher({ homeDir: home });
  const liveAuth = auth({
    subject: "live-user",
    email: "live@example.com",
    accountId: "live-workspace",
  });
  writeJson(switcher.targetAuthPath, liveAuth);
  writeJson(switcher.profileAuthPath("stored"), auth({
    subject: "stored-user",
    email: "stored@example.com",
    accountId: "stored-workspace",
    planType: "plus",
  }));

  let requestedAccountId = null;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requestedAccountId = options.headers["ChatGPT-Account-Id"];
    return {
      ok: true,
      json: async () => ({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 25, window_minutes: 300 },
        },
      }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const usage = await switcher.fetchProfileUsage("stored");

  assert.equal(requestedAccountId, "stored-workspace");
  assert.equal(usage.profile.email, "stored@example.com");
  assert.equal(usage.rateLimits.primary.used_percent, 25);
  assert.deepEqual(JSON.parse(fs.readFileSync(switcher.targetAuthPath, "utf8")), liveAuth);
});
