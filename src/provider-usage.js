const crypto = require("node:crypto");
const os = require("node:os");
const { createClaudeFileStore } = require("./claude-live-credentials");

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const cache = new Map();

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function tokenKey(provider, token) {
  const digest = crypto.createHash("sha256").update(String(token || "none")).digest("hex").slice(0, 16);
  return `${provider}:${digest}`;
}

async function cached(key, load, { ttl = 60000, force = false } = {}) {
  const old = cache.get(key);
  if (!force && old && Date.now() - old.at < ttl) return old.value;
  const value = Promise.resolve().then(load);
  cache.set(key, { at: Date.now(), value });
  try {
    return await value;
  } catch (error) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  }
}

function clearUsageCache(provider = null) {
  for (const key of cache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) cache.delete(key);
  }
}

function normalizeAgyQuota(data) {
  return (data?.groups || []).flatMap((group) =>
    (group.buckets || []).flatMap((bucket) => {
      const remaining = Number(bucket.remainingFraction ?? bucket.remaining_fraction);
      if (!Number.isFinite(remaining)) return [];
      return [{
        label: [group.displayName || group.name, bucket.displayName || bucket.window]
          .filter(Boolean)
          .join(" · "),
        usedPercent: clampPercent((1 - remaining) * 100),
        resetText: bucket.resetTime || bucket.reset_time || "",
      }];
    })
  );
}

function normalizeClaudeUsage(data) {
  const windows = [
    ["5시간", data?.five_hour],
    ["7일", data?.seven_day],
    ["7일 · Sonnet", data?.seven_day_sonnet],
    ["7일 · Opus", data?.seven_day_opus],
  ];
  return windows.flatMap(([label, value]) => {
    const utilization = Number(value?.utilization);
    if (!Number.isFinite(utilization)) return [];
    return [{
      label,
      usedPercent: clampPercent(utilization),
      resetText: value.resets_at || "",
    }];
  });
}

async function json(url, options, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(`사용량 서버가 HTTP ${response.status}를 반환했습니다.`, response.status);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshClaudeOAuth(credentials, store) {
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.refreshToken) throw new Error("Claude 로그인 정보가 만료됐습니다.");
  const refresh = await json("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  const expiresAt = Number(refresh.expires_at) ||
    (Number(refresh.expires_in) ? Date.now() + Number(refresh.expires_in) * 1000 : oauth.expiresAt);
  const next = {
    ...oauth,
    accessToken: refresh.access_token || oauth.accessToken,
    refreshToken: refresh.refresh_token || oauth.refreshToken,
    expiresAt,
  };
  credentials.claudeAiOauth = next;
  store.write(credentials);
  return next;
}

// credentialStore를 넘기지 않으면 파일 저장소를 사용합니다. (macOS 실사용은 main.js가 Keychain 저장소를 주입)
async function fetchClaudeUsage({ home = os.homedir(), force = false, credentialStore } = {}) {
  const store = credentialStore || createClaudeFileStore(home);
  const credentials = store.read();
  if (!credentials) throw new Error("Claude 로그인 정보가 없습니다.");
  let oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("Claude 로그인 정보가 없습니다.");
  const key = tokenKey("claude", oauth.refreshToken || oauth.accessToken);

  return cached(key, async () => {
    // refreshToken이 없는 자격 증명(데스크톱 앱 관리 인증)은 현재 accessToken으로 그대로 시도합니다.
    if (oauth.refreshToken && oauth.expiresAt && Number(oauth.expiresAt) <= Date.now() + 60000) {
      oauth = await refreshClaudeOAuth(credentials, store);
    }

    const request = () => json("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    let data;
    try {
      data = await request();
    } catch (error) {
      if (error.status !== 401 || !oauth.refreshToken) throw error;
      oauth = await refreshClaudeOAuth(credentials, store);
      data = await request();
    }
    return { provider: "claude", gauges: normalizeClaudeUsage(data) };
  }, { force });
}

function tierLabel(assist) {
  const tier = assist?.currentTier || assist?.current_tier || assist?.paidTier || null;
  if (typeof tier === "string") return tier;
  return tier?.displayName || tier?.display_name || tier?.name || tier?.id || null;
}

async function fetchAntigravityUsage({ credential, force = false } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy", credential?.token?.refresh_token || token);

  return cached(key, async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "antigravity/cli/1.0.11 windows/amd64",
    };
    const [assist, identity] = await Promise.all([
      json("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
      }),
      fetchAntigravityIdentity({ credential }).catch(() => ({})),
    ]);
    const project = assist?.cloudaicompanionProject;
    if (!project) throw new Error("AGY 프로젝트 정보를 찾지 못했습니다.");
    const quota = await json(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ project }),
      }
    );
    return {
      provider: "agy",
      email: identity.email || null,
      plan: tierLabel(assist),
      gauges: normalizeAgyQuota(quota),
    };
  }, { force });
}

async function fetchAntigravityIdentity({ credential, force = false } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy:identity", credential?.token?.refresh_token || token);
  return cached(key, async () => {
    const identity = await json("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    return { email: identity?.email || null };
  }, { force });
}

module.exports = {
  clearUsageCache,
  fetchAntigravityIdentity,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  tierLabel,
};
