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

function secretIdentity(secret) {
  return (
    secret?.refresh_token ||
    secret?.refreshToken ||
    secret?.token?.refresh_token ||
    secret?.claudeAiOauth?.refreshToken ||
    null
  );
}

function secretFingerprint(secret) {
  return fingerprint(secretIdentity(secret));
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

  list() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }

    const activeKey = this.getActiveKey();
    const profiles = [];
    for (const file of files) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8"));
        if (!PROFILE_KEY.test(record?.key || "") || !record.secret) continue;
        profiles.push(safeProfile(record, record.key === activeKey));
      } catch {
        // 손상된 프로필 하나 때문에 정상 프로필까지 숨기지 않습니다.
      }
    }
    return profiles.sort(
      (left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label)
    );
  }

  save({ secret, email, plan, active = false }) {
    const key = secretFingerprint(secret);
    if (!key) throw new Error("로그인 정보를 찾지 못했습니다.");
    const existing = this.get(key);
    const normalizedEmail = typeof email === "string" && email.trim() ? email.trim() : existing?.email;
    const normalizedPlan = typeof plan === "string" && plan.trim() ? plan.trim() : existing?.plan;
    const record = {
      key,
      label: normalizedEmail || existing?.label || `계정 ${key.slice(0, 6)}`,
      email: normalizedEmail || null,
      plan: normalizedPlan || null,
      secret,
      savedAt: existing?.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(path.join(this.dir, `${key}.json`), record);
    if (active) this.setActive(key);
    return safeProfile(record, active || this.getActiveKey() === key);
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
  fingerprint,
  safeProfile,
  secretFingerprint,
};
