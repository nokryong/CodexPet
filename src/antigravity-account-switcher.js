const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ProviderProfileStore,
  atomicWrite,
  safeProfile,
} = require("./provider-profile-store");

class AntigravityAccountSwitcher {
  constructor({
    home = os.homedir(),
    store,
    read = async () => null,
    write = async () => {},
    clear = async () => {},
    restart = async () => {},
  } = {}) {
    this.store = store || new ProviderProfileStore("antigravity", home);
    this.read = read;
    this.write = write;
    this.clear = clear;
    this.restart = restart;
    this.accountFile = path.join(home, ".gemini", "google_accounts.json");
  }

  async snapshotCurrent(meta = {}) {
    const secret = await this.read();
    if (!secret?.token?.refresh_token) {
      throw new Error("AGY 로그인 정보를 찾지 못했습니다.");
    }
    return this.store.save({
      secret,
      email: meta.email || this.currentAccountHint(),
      plan: meta.plan,
      active: true,
    });
  }

  listProfiles() {
    return this.store.list();
  }

  deleteProfile(key) {
    return this.store.delete(key);
  }

  currentAccountHint() {
    try {
      const current = JSON.parse(fs.readFileSync(this.accountFile, "utf8"));
      return typeof current?.active === "string" && current.active.trim()
        ? current.active.trim()
        : null;
    } catch {
      return null;
    }
  }

  clearAccountHint() {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(this.accountFile, "utf8"));
    } catch {
      return;
    }
    const old = [...new Set([...(Array.isArray(current.old) ? current.old : []), current.active])]
      .filter(Boolean);
    const { active: _active, ...rest } = current;
    atomicWrite(this.accountFile, { ...rest, old });
  }

  updateAccountHint(email) {
    if (!email) return;
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(this.accountFile, "utf8"));
    } catch {
      // 파일이 없으면 새로 만듭니다.
    }
    const old = [...new Set([...(Array.isArray(current.old) ? current.old : []), current.active])]
      .filter((value) => value && value !== email);
    atomicWrite(this.accountFile, { ...current, active: email, old });
  }

  async switchToProfile(key) {
    const profile = this.store.get(key);
    if (!profile?.secret?.token?.refresh_token) {
      throw new Error("저장된 AGY 계정을 찾지 못했습니다.");
    }
    try {
      await this.snapshotCurrent();
    } catch {
      // 현재 로그인이 없더라도 저장된 프로필로 복구할 수 있습니다.
    }
    await this.write(profile.secret);
    this.store.setActive(key);
    this.updateAccountHint(profile.email);
    await this.restart();
    return safeProfile(profile, true);
  }

  async prepareLogin(meta = {}) {
    // 새 로그인 전에 현재 자격 증명이 프로필에 저장돼야 되돌아올 수 있습니다.
    let current = null;
    try {
      current = await this.read();
    } catch {
      // 첫 로그인처럼 live 자격 증명이 없으면 저장 단계만 건너뜁니다.
    }
    if (current?.token?.refresh_token) {
      this.store.save({ secret: current, email: meta.email, plan: meta.plan, active: true });
    }
    await this.clear();
    this.clearAccountHint();
    this.store.clearActive();
    await this.restart();
    return true;
  }
}

module.exports = { AntigravityAccountSwitcher };
