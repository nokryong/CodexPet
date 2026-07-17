const os = require("node:os");
const {
  ProviderProfileStore,
  safeProfile,
} = require("./provider-profile-store");
const {
  normalizeClaudeAccountMetadata,
  readClaudeAccountMetadata,
} = require("./claude-account-metadata");
const { createClaudeFileStore } = require("./claude-live-credentials");

class ClaudeAccountSwitcher {
  // liveStore를 넘기지 않으면 파일 저장소를 사용합니다.
  // macOS 실사용 경로는 main.js가 createClaudeLiveStore()로 Keychain 저장소를 주입합니다.
  constructor({ home = os.homedir(), store, liveStore, restart = async () => {} } = {}) {
    this.home = home;
    // live 자격 증명 경로/위치는 liveStore가 소유합니다. (파일 또는 macOS Keychain)
    this.liveStore = liveStore || createClaudeFileStore(home);
    this.store = store || new ProviderProfileStore("claude", home);
    this.restart = restart;
  }

  current() {
    return this.liveStore.read();
  }

  listProfiles() {
    const liveKey = this.store.findKeyBySecret(this.current());
    return this.store.list().map((profile) => ({
      ...profile,
      active: Boolean(liveKey && profile.key === liveKey),
    }));
  }

  // macOS 데스크톱 앱이 관리하는 인증은 refreshToken 없이 accessToken만 있을 수 있어 둘 다 허용합니다.
  static hasClaudeToken(secret) {
    const oauth = secret?.claudeAiOauth;
    return Boolean(oauth?.refreshToken || oauth?.accessToken);
  }

  snapshotCurrent(meta = {}) {
    const live = this.current();
    if (!ClaudeAccountSwitcher.hasClaudeToken(live)) {
      throw new Error("Claude 로그인 정보를 찾지 못했습니다.");
    }
    const localMeta = readClaudeAccountMetadata(this.home);
    const credentialMeta = normalizeClaudeAccountMetadata(live.claudeAiOauth);
    return this.store.save({
      secret: live,
      email: meta.email || localMeta.email,
      plan: meta.plan || credentialMeta.plan || localMeta.plan,
      active: true,
    });
  }

  deleteProfile(key) {
    const profile = this.listProfiles().find((item) => item.key === key);
    if (!profile) throw new Error("저장된 Claude 계정을 찾지 못했습니다.");
    if (profile.active) throw new Error("현재 사용 중인 계정은 삭제할 수 없습니다.");
    return this.store.delete(key);
  }

  // refreshToken 없이 이미 만료된 accessToken만 있는 프로필은 전환 대상이 될 수 없습니다.
  // 그대로 live 자격 증명에 덮어쓰면 갱신 경로가 없어 Claude 로그인이 깨집니다.
  static isProfileUsable(secret) {
    const oauth = secret?.claudeAiOauth;
    if (!oauth) return false;
    if (oauth.refreshToken) return true;
    if (!oauth.accessToken) return false;
    const expiresAt = Number(oauth.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt > Date.now();
  }

  async switchToProfile(key) {
    const profile = this.store.get(key);
    if (!ClaudeAccountSwitcher.hasClaudeToken(profile?.secret)) {
      throw new Error("저장된 Claude 계정을 찾지 못했습니다.");
    }
    if (!ClaudeAccountSwitcher.isProfileUsable(profile.secret)) {
      throw new Error(
        "이 계정의 저장된 로그인 정보가 만료됐습니다. 해당 계정으로 다시 로그인한 뒤 전환해 주세요."
      );
    }
    const liveNow = this.current();
    if (ClaudeAccountSwitcher.hasClaudeToken(liveNow)) this.snapshotCurrent();
    // mcpOAuth 같은 계정 외 항목은 유지하고 claudeAiOauth만 교체합니다.
    const next =
      liveNow && typeof liveNow === "object" && profile.secret.claudeAiOauth
        ? { ...liveNow, claudeAiOauth: profile.secret.claudeAiOauth }
        : profile.secret;
    this.liveStore.write(next);
    this.store.setActive(key);
    await this.restart();
    return safeProfile(profile, true);
  }
}

module.exports = { ClaudeAccountSwitcher };
