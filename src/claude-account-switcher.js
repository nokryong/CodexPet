const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ProviderProfileStore,
  atomicWrite,
  safeProfile,
  secretFingerprint,
} = require("./provider-profile-store");

class ClaudeAccountSwitcher {
  constructor({ home = os.homedir(), store, restart = async () => {} } = {}) {
    this.home = home;
    this.live = path.join(home, ".claude", ".credentials.json");
    this.store = store || new ProviderProfileStore("claude", home);
    this.restart = restart;
  }

  current() {
    try {
      return JSON.parse(fs.readFileSync(this.live, "utf8"));
    } catch {
      return null;
    }
  }

  listProfiles() {
    const liveKey = secretFingerprint(this.current());
    return this.store.list().map((profile) => ({
      ...profile,
      active: Boolean(liveKey && profile.key === liveKey),
    }));
  }

  snapshotCurrent(meta = {}) {
    const live = this.current();
    if (!live?.claudeAiOauth?.refreshToken) {
      throw new Error("Claude 로그인 정보를 찾지 못했습니다.");
    }
    return this.store.save({ secret: live, email: meta.email, plan: meta.plan, active: true });
  }

  deleteProfile(key) {
    const profile = this.listProfiles().find((item) => item.key === key);
    if (!profile) throw new Error("저장된 Claude 계정을 찾지 못했습니다.");
    if (profile.active) throw new Error("현재 사용 중인 계정은 삭제할 수 없습니다.");
    return this.store.delete(key);
  }

  async switchToProfile(key) {
    const profile = this.store.get(key);
    if (!profile?.secret?.claudeAiOauth?.refreshToken) {
      throw new Error("저장된 Claude 계정을 찾지 못했습니다.");
    }
    if (this.current()?.claudeAiOauth?.refreshToken) this.snapshotCurrent();
    atomicWrite(this.live, profile.secret);
    this.store.setActive(key);
    await this.restart();
    return safeProfile(profile, true);
  }
}

module.exports = { ClaudeAccountSwitcher };
