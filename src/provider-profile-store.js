const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROFILE_KEY = /^[a-f0-9]{16}$/;

function fingerprint(value) {
  return value
    ? crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16)
    : null;
}

function normalizeEmail(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLocaleLowerCase("en") : null;
}

function secretIdentity(secret) {
  const claudeRefreshExpiry = Number(secret?.claudeAiOauth?.refreshTokenExpiresAt);
  if (Number.isFinite(claudeRefreshExpiry) && claudeRefreshExpiry > 0) {
    // Claude OAuth는 refresh token을 회전시키면서도 같은 로그인 세션의 만료 시각을 유지합니다.
    // 서버 응답의 밀리초 단위 흔들림만 흡수해 한 계정이 여러 프로필로 늘어나는 것을 막습니다.
    return `claude-session:${Math.floor(claudeRefreshExpiry / 10000)}`;
  }
  return (
    secret?.refresh_token ||
    secret?.refreshToken ||
    secret?.token?.refresh_token ||
    secret?.claudeAiOauth?.refreshToken ||
    // macOS 데스크톱 앱 관리 인증은 refreshToken이 비어 있을 수 있어 accessToken으로 식별합니다.
    secret?.claudeAiOauth?.accessToken ||
    null
  );
}

function secretFingerprint(secret) {
  return fingerprint(secretIdentity(secret));
}

function profileFingerprint(secret, email) {
  const normalizedEmail = normalizeEmail(email);
  return fingerprint(normalizedEmail ? `email:${normalizedEmail}` : secretIdentity(secret));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function atomicWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function safeProfile(record, active = false) {
  const { secret: _secret, ...safe } = record;
  return { ...safe, active };
}

class ProviderProfileStore {
  constructor(provider, home = os.homedir()) {
    this.root = path.join(home, ".codepet", `${provider}-switch`);
    this.dir = path.join(this.root, "profiles");
    this.activePath = path.join(this.root, "active");
  }

  getActiveKey() {
    try {
      const key = fs.readFileSync(this.activePath, "utf8").trim();
      return PROFILE_KEY.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  setActive(key) {
    if (!PROFILE_KEY.test(String(key || ""))) {
      throw new Error("올바르지 않은 계정 키입니다.");
    }
    atomicWriteText(this.activePath, `${key}\n`);
  }

  clearActive() {
    fs.rmSync(this.activePath, { force: true });
  }

  records() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }

    const records = [];
    for (const file of files) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8"));
        if (!PROFILE_KEY.test(record?.key || "") || !record.secret) continue;
        records.push(record);
      } catch {
        // 손상된 프로필 하나 때문에 정상 프로필까지 숨기지 않습니다.
      }
    }
    return records;
  }

  list() {
    const activeKey = this.getActiveKey();
    const profiles = this.records().map((record) => safeProfile(record, record.key === activeKey));
    return profiles.sort(
      (left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label)
    );
  }

  save({ secret, email, plan, active = false }) {
    const normalizedEmail = normalizeEmail(email);
    const secretKey = secretFingerprint(secret);
    const key = profileFingerprint(secret, normalizedEmail);
    if (!key) throw new Error("로그인 정보를 찾지 못했습니다.");

    const activeKey = this.getActiveKey();
    const candidates = this.records().filter((record) =>
      record.key === key ||
      (secretKey &&
        secretFingerprint(record.secret) === secretKey &&
        (!normalizedEmail || !record.email || normalizeEmail(record.email) === normalizedEmail)) ||
      (normalizedEmail && normalizeEmail(record.email) === normalizedEmail)
    );
    const existing = candidates.find((record) => record.key === activeKey) ||
      candidates.find((record) => normalizeEmail(record.email) === normalizedEmail) ||
      candidates[0] ||
      null;
    const preservedEmail = normalizedEmail || normalizeEmail(existing?.email);
    const normalizedPlan = typeof plan === "string" && plan.trim() ? plan.trim() : existing?.plan;
    const record = {
      key,
      label: preservedEmail || existing?.label || `계정 ${key.slice(0, 6)}`,
      email: preservedEmail || null,
      plan: normalizedPlan || null,
      secret,
      savedAt: existing?.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(path.join(this.dir, `${key}.json`), record);
    for (const candidate of candidates) {
      if (candidate.key !== key) {
        fs.rmSync(path.join(this.dir, `${candidate.key}.json`), { force: true });
      }
    }

    const remainsActive = active || candidates.some((candidate) => candidate.key === activeKey);
    if (remainsActive) this.setActive(key);
    return safeProfile(record, remainsActive || this.getActiveKey() === key);
  }

  findKeyBySecret(secret) {
    const key = secretFingerprint(secret);
    if (!key) return null;
    return this.records().find((record) => secretFingerprint(record.secret) === key)?.key || null;
  }

  get(key) {
    if (!PROFILE_KEY.test(String(key || ""))) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.dir, `${key}.json`), "utf8"));
      return record?.key === key && record.secret ? record : null;
    } catch {
      return null;
    }
  }

  delete(key) {
    if (!PROFILE_KEY.test(String(key || ""))) {
      throw new Error("올바르지 않은 계정 키입니다.");
    }
    if (this.getActiveKey() === key) {
      throw new Error("현재 사용 중인 계정은 삭제할 수 없습니다.");
    }

    const profile = this.get(key);
    if (!profile) throw new Error("저장된 계정을 찾지 못했습니다.");
    fs.rmSync(path.join(this.dir, `${key}.json`), { force: true });
    return safeProfile(profile, false);
  }
}

module.exports = {
  ProviderProfileStore,
  atomicWrite,
  atomicWriteText,
  fingerprint,
  normalizeEmail,
  profileFingerprint,
  safeProfile,
  secretFingerprint,
};
