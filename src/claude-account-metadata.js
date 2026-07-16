const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function normalizeClaudeAccountMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const candidates = [
    value,
    value.oauthAccount,
    value.account,
    value.user,
    value.profile,
    value.data,
    value.data?.oauthAccount,
    value.data?.account,
    value.data?.user,
  ].filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));

  const email = firstString(
    ...candidates.flatMap((candidate) => [
      candidate.email,
      candidate.emailAddress,
      candidate.email_address,
    ])
  );
  const plan = firstString(
    ...candidates.flatMap((candidate) => [
      candidate.subscriptionType,
      candidate.subscription_type,
      candidate.seatTier,
      candidate.plan,
    ])
  );

  return {
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

function readClaudeAccountMetadata(home = os.homedir()) {
  const candidates = [
    path.join(home, ".claude.json"),
    path.join(home, ".claude", "config.json"),
  ];

  for (const file of candidates) {
    try {
      const metadata = normalizeClaudeAccountMetadata(
        JSON.parse(fs.readFileSync(file, "utf8"))
      );
      if (metadata.email || metadata.plan) return metadata;
    } catch {
      // Claude 버전이나 설치 방식에 따라 없는 파일은 건너뜁니다.
    }
  }

  return {};
}

module.exports = { normalizeClaudeAccountMetadata, readClaudeAccountMetadata };
