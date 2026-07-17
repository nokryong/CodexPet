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
