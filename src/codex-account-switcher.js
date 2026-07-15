const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// CodePet 계정 전환 방식:
//  1. 실제 Codex Desktop은 항상 기본 ~/.codex/auth.json을 사용합니다.
//  2. 저장된 계정은 ~/.codepet/codex-switch/profiles/<profile>/auth.json에 보관합니다.
//  3. 전환할 때는 현재 auth.json을 백업하고, 선택한 profile auth를 ~/.codex/auth.json으로 원자 복사합니다.
//  4. 로그인은 pending profile CODEX_HOME에서 실행하고, auth.json이 생긴 뒤에만 목록에 표시합니다.
//
// 이 구조는 JHKS24/codex-usage-switcher의 "profile auth 저장소 + live auth 교체" 흐름을
// Electron CodePet에 맞춘 것입니다. 예전처럼 빈 ~/.codexN을 만들거나 auth 기록을 자동 이관하지 않습니다.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "codex_cli_rs/0.76.0 (Windows; CodePet)";
const AUTH_FILE = "auth.json";
const BACKUP_KEEP = 20;
const PENDING_PREFIX = "__login_";

class CodexAccountSwitcher {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.codexHome = options.codexHome || path.join(this.homeDir, ".codex");
    this.targetAuthPath = path.join(this.codexHome, AUTH_FILE);

    this.codePetHome = options.codePetHome || path.join(this.homeDir, ".codepet");
    this.switchHome = path.join(this.codePetHome, "codex-switch");
    this.profilesRoot = path.join(this.switchHome, "profiles");
    this.backupsRoot = path.join(this.switchHome, "backups");
    this.activePath = path.join(this.switchHome, "active");

    this.oldCodePetSwitcherDir = path.join(this.codexHome, "codepet-account-switcher");
    this.oldCodePetProfileSettings = path.join(this.codePetHome, "codex-profiles.json");
    this.oldCodePetProfilesDir = path.join(this.codePetHome, "codex-profiles");
  }

  // 계정 저장소 폴더입니다. 여기에 auth.json 사본이 들어가므로 절대 공유하거나 git에 넣으면 안 됩니다.
  getSwitcherDir() {
    return this.switchHome;
  }

  // 앱 시작 때 예전 CodePet의 잘못된 기록을 제거합니다.
  // JHKS 도구의 ~/.codex-switch는 건드리지 않습니다. CodePet이 만든 폴더만 정리합니다.
  cleanupLegacyCodePetState() {
    this.removePathIfInsideHome(this.oldCodePetSwitcherDir);
    this.removePathIfInsideHome(this.oldCodePetProfileSettings);
    this.removePathIfInsideHome(this.oldCodePetProfilesDir);
    this.cleanupBlankLegacyCodexHomes();
    this.cleanupStalePendingProfiles();
  }

  // 이전 CODEX_HOME 실험 과정에서 생긴 빈 ~/.codexN 폴더만 제거합니다.
  // auth.json이나 sessions가 있으면 사용자가 로그인/작업한 흔적이므로 자동 삭제하지 않습니다.
  cleanupBlankLegacyCodexHomes() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.homeDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.codex\d+$/.test(entry.name)) continue;

      const dirPath = path.join(this.homeDir, entry.name);
      const authPath = path.join(dirPath, AUTH_FILE);
      const sessionsPath = path.join(dirPath, "sessions");
      if (fs.existsSync(authPath) || fs.existsSync(sessionsPath)) continue;

      this.removePathIfInsideHome(dirPath);
    }
  }

  // pending 로그인 폴더는 auth.json이 생기기 전에는 UI에 표시하지 않습니다.
  // 오래된 pending 폴더는 로그인 취소/실패 찌꺼기로 보고 지웁니다.
  cleanupStalePendingProfiles(maxAgeMs = 30 * 60 * 1000) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.profilesRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory() || !dir.name.startsWith(PENDING_PREFIX)) continue;

      const fullPath = path.join(this.profilesRoot, dir.name);
      const authPath = path.join(fullPath, AUTH_FILE);
      if (fs.existsSync(authPath)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (Date.now() - stat.mtimeMs >= maxAgeMs) {
          this.removePathIfInsideHome(fullPath);
        }
      } catch {
        // 방금 사라진 폴더면 무시합니다.
      }
    }
  }

  // 삭제는 홈 디렉터리 내부로 확인된 경로에만 수행합니다.
  removePathIfInsideHome(targetPath) {
    if (!targetPath || !fs.existsSync(targetPath)) return;

    const resolved = path.resolve(targetPath);
    const home = path.resolve(this.homeDir);
    const homePrefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
    if (!resolved.toLowerCase().startsWith(homePrefix.toLowerCase())) {
      throw new Error(`홈 디렉터리 밖 경로는 삭제하지 않습니다: ${resolved}`);
    }

    fs.rmSync(resolved, { recursive: true, force: true });
  }

  ensureDirs() {
    fs.mkdirSync(this.profilesRoot, { recursive: true });
    fs.mkdirSync(this.backupsRoot, { recursive: true });
  }

  readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  writeTextAtomic(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);

    try {
      fs.writeFileSync(tmpPath, text, "utf8");
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  copyFileAtomic(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(destinationPath),
      `.${path.basename(destinationPath)}.${crypto.randomUUID()}.tmp`
    );

    try {
      fs.copyFileSync(sourcePath, tmpPath);
      fs.renameSync(tmpPath, destinationPath);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  sha256File(filePath) {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    } catch {
      return null;
    }
  }

  decodeJwtPayload(token) {
    if (!token || typeof token !== "string" || !token.includes(".")) return {};

    try {
      const payloadPart = token.split(".")[1];
      const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      return {};
    }
  }

  summarizeAuth(auth, authPath = null) {
    const idPayload = this.decodeJwtPayload(auth?.tokens?.id_token);
    const accessPayload = this.decodeJwtPayload(auth?.tokens?.access_token);
    const openAiAuth =
      idPayload["https://api.openai.com/auth"] ||
      accessPayload["https://api.openai.com/auth"] ||
      {};
    const accountId =
      auth?.tokens?.account_id ||
      auth?.account_id ||
      openAiAuth.chatgpt_account_id ||
      accessPayload.chatgpt_account_id ||
      null;
    const accessToken = auth?.tokens?.access_token || auth?.access_token || null;
    const email = idPayload.email || accessPayload.email || null;
    const displayId =
      email ||
      idPayload.name ||
      accessPayload.name ||
      (accountId ? String(accountId).slice(0, 8) : null);
    const planType = openAiAuth.chatgpt_plan_type || auth?.plan_type || null;
    const organization = openAiAuth.organization_id || openAiAuth.org_id || null;

    return {
      hasAuth: Boolean(accessToken),
      authPath,
      accountId,
      accessToken,
      email,
      displayId,
      planType,
      organization,
      authMode: auth?.auth_mode || "unknown",
      label: this.formatProfileLabel(displayId, planType),
    };
  }

  readAuthSummaryFromFile(authPath) {
    try {
      return this.summarizeAuth(this.readJson(authPath), authPath);
    } catch (error) {
      return {
        hasAuth: false,
        authPath,
        accountId: null,
        accessToken: null,
        email: null,
        displayId: null,
        planType: null,
        organization: null,
        authMode: "unknown",
        label: "로그인 정보 없음",
        error: error.message || String(error),
      };
    }
  }

  readCurrentAuthSummary() {
    return this.readAuthSummaryFromFile(this.targetAuthPath);
  }

  formatProfileLabel(displayId, planType) {
    const id = displayId || "Codex 계정";
    return planType ? `${id} (${planType})` : id;
  }

  sanitizeProfileName(value) {
    const sanitized = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/@/g, "-")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72);

    return sanitized || `account-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  }

  profileNameForSummary(summary) {
    const base = summary.email || summary.displayId || summary.accountId || "codex-account";
    const plan = summary.planType ? `-${summary.planType}` : "";
    return this.sanitizeProfileName(`${base}${plan}`);
  }

  profileDir(profileKey) {
    return path.join(this.profilesRoot, this.sanitizeProfileName(profileKey));
  }

  profileAuthPath(profileKey) {
    return path.join(this.profileDir(profileKey), AUTH_FILE);
  }

  rawProfileDirs() {
    this.ensureDirs();
    try {
      return fs
        .readdirSync(this.profilesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.profilesRoot, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    } catch {
      return [];
    }
  }

  listProfileDirs() {
    this.ensureDirs();
    this.normalizeCompletedPendingProfiles();
    this.cleanupStalePendingProfiles();
    return this.rawProfileDirs();
  }

  sameIdentity(left, right) {
    if (!left || !right) return false;
    if (left.accountId && right.accountId && left.accountId === right.accountId) return true;
    if (!left.email || !right.email || left.email !== right.email) return false;
    if ((left.planType || null) !== (right.planType || null)) return false;
    if (left.organization && right.organization && left.organization !== right.organization) return false;
    return true;
  }

  findMatchingProfile(summary, excludeKey = null) {
    const targetDigest = summary.authPath ? this.sha256File(summary.authPath) : null;

    for (const dirPath of this.rawProfileDirs()) {
      const key = path.basename(dirPath);
      if (excludeKey && key === excludeKey) continue;

      const authPath = path.join(dirPath, AUTH_FILE);
      if (!fs.existsSync(authPath)) continue;

      const digest = this.sha256File(authPath);
      if (targetDigest && digest && targetDigest === digest) {
        return key;
      }

      const profileSummary = this.readAuthSummaryFromFile(authPath);
      if (this.sameIdentity(summary, profileSummary)) {
        return key;
      }
    }

    return null;
  }

  readActiveProfileKey() {
    try {
      const value = fs.readFileSync(this.activePath, "utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  }

  writeActiveProfileKey(profileKey) {
    this.writeTextAtomic(this.activePath, `${profileKey}\n`);
  }

  uniqueAvailableProfileName(baseName) {
    let name = this.sanitizeProfileName(baseName);
    let index = 2;
    while (fs.existsSync(this.profileDir(name))) {
      name = `${this.sanitizeProfileName(baseName)}-${index}`;
      index += 1;
    }
    return name;
  }

  ensureUniqueProfileName(baseName, summary) {
    const matching = this.findMatchingProfile(summary);
    if (matching) return matching;
    return this.uniqueAvailableProfileName(baseName);
  }

  // pending 폴더에 auth.json이 생기면 표시용 이메일/플랜 기반 이름으로 확정합니다.
  normalizeCompletedPendingProfiles() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.profilesRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory() || !dir.name.startsWith(PENDING_PREFIX)) continue;

      const pendingDir = path.join(this.profilesRoot, dir.name);
      const pendingAuth = path.join(pendingDir, AUTH_FILE);
      if (!fs.existsSync(pendingAuth)) continue;

      const summary = this.readAuthSummaryFromFile(pendingAuth);
      if (!summary.hasAuth) continue;

      const targetName =
        this.findMatchingProfile(summary, dir.name) ||
        this.uniqueAvailableProfileName(this.profileNameForSummary(summary));
      const targetDir = this.profileDir(targetName);

      if (path.resolve(targetDir).toLowerCase() === path.resolve(pendingDir).toLowerCase()) {
        continue;
      }

      if (fs.existsSync(targetDir)) {
        this.copyFileAtomic(pendingAuth, path.join(targetDir, AUTH_FILE));
        this.removePathIfInsideHome(pendingDir);
      } else {
        fs.renameSync(pendingDir, targetDir);
      }
    }
  }

  // 목록에는 auth.json이 있는 프로필만 표시합니다. 빈 pending 폴더는 절대 UI에 나오지 않습니다.
  listProfiles() {
    const current = this.readCurrentAuthSummary();
    const activeKey = this.findMatchingProfile(current) || this.readActiveProfileKey();

    return this.listProfileDirs()
      .map((dirPath) => {
        const key = path.basename(dirPath);
        const authPath = path.join(dirPath, AUTH_FILE);
        if (!fs.existsSync(authPath)) return null;

        const summary = this.readAuthSummaryFromFile(authPath);
        if (!summary.hasAuth) return null;

        return {
          key,
          id: key,
          homePath: dirPath,
          profilePath: dirPath,
          active: key === activeKey || this.sameIdentity(current, summary),
          hasAuth: true,
          accountId: summary.accountId,
          shortId: summary.accountId ? String(summary.accountId).slice(0, 8) : key,
          displayId: summary.displayId,
          email: summary.email,
          planType: summary.planType,
          authMode: summary.authMode,
          label: summary.label,
        };
      })
      .filter(Boolean);
  }

  getCurrentAccountSummary() {
    const summary = this.readCurrentAuthSummary();
    const matchedProfile = summary.hasAuth ? this.findMatchingProfile(summary) : null;

    return {
      hasAuth: summary.hasAuth,
      key: matchedProfile,
      label: summary.label,
      accountId: summary.accountId,
      shortId: summary.accountId ? String(summary.accountId).slice(0, 8) : null,
      displayId: summary.displayId,
      email: summary.email,
      planType: summary.planType,
      authMode: summary.authMode,
      homePath: this.codexHome,
      source: "live-auth",
      error: summary.error,
    };
  }

  getActiveProfile() {
    const current = this.getCurrentAccountSummary();
    return {
      ...current,
      id: current.key || "current",
      key: current.key || "current",
      homePath: this.codexHome,
    };
  }

  // 현재 live ~/.codex/auth.json을 저장소에 등록합니다.
  saveCurrentAccount() {
    const summary = this.readCurrentAuthSummary();
    if (!summary.hasAuth || !fs.existsSync(this.targetAuthPath)) {
      throw new Error("현재 ~/.codex/auth.json에 로그인 정보가 없습니다.");
    }

    const profileKey = this.ensureUniqueProfileName(this.profileNameForSummary(summary), summary);
    const destination = this.profileAuthPath(profileKey);
    const backupId = fs.existsSync(destination)
      ? this.backupExistingFile(destination, new Date())
      : null;

    try {
      this.copyFileAtomic(this.targetAuthPath, destination);
      this.writeActiveProfileKey(profileKey);
    } catch (error) {
      this.restoreBackupTo(backupId, destination);
      throw error;
    }

    return this.listProfiles().find((profile) => profile.key === profileKey) || {
      key: profileKey,
      id: profileKey,
      homePath: this.profileDir(profileKey),
      hasAuth: true,
      label: summary.label,
    };
  }

  // 앱 시작/계정 추가 전 current auth를 한 번 저장해 두면 새 로그인 후 원래 계정으로 되돌아갈 수 있습니다.
  ensureCurrentAccountProfile() {
    try {
      return this.saveCurrentAccount();
    } catch {
      return null;
    }
  }

  // 새 로그인은 pending profile CODEX_HOME에서 실행합니다.
  // 로그인 성공 전까지는 auth.json이 없으므로 프로필 목록에 나타나지 않습니다.
  createLoginProfile() {
    this.ensureDirs();
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const profileKey = `${PENDING_PREFIX}${stamp}_${crypto.randomUUID().slice(0, 8)}`;
    const homePath = this.profileDir(profileKey);
    fs.mkdirSync(homePath, { recursive: true });

    return {
      key: profileKey,
      id: "new-login",
      homePath,
      pending: true,
      label: "새 Codex 로그인",
    };
  }

  getProfile(profileKey) {
    return this.listProfiles().find((profile) => profile.key === profileKey) || null;
  }

  // 저장소 안의 auth 사본만 지웁니다. live ~/.codex/auth.json은 절대 삭제하지 않습니다.
  deleteProfile(profileKey) {
    const profile = this.getProfile(profileKey);
    if (!profile) throw new Error("저장된 Codex 계정을 찾지 못했습니다.");
    if (profile.active) throw new Error("현재 사용 중인 계정은 삭제할 수 없습니다.");
    this.removePathIfInsideHome(profile.profilePath);
    return profile;
  }

  // 저장된 프로필 auth를 live ~/.codex/auth.json으로 교체합니다. 실패하면 직전 백업으로 되돌립니다.
  switchToProfile(profileKey) {
    const profile = this.getProfile(profileKey);
    if (!profile) {
      throw new Error("저장된 Codex 계정을 찾지 못했습니다.");
    }

    // 전환 전 현재 계정도 저장소에 갱신합니다. 그래야 되돌아갈 계정이 사라지지 않습니다.
    this.ensureCurrentAccountProfile();

    const source = this.profileAuthPath(profile.key);
    if (!fs.existsSync(source)) {
      throw new Error(`선택한 프로필에 auth.json이 없습니다: ${profile.key}`);
    }

    const backupId = this.createBackup(new Date());
    try {
      this.copyFileAtomic(source, this.targetAuthPath);
      this.writeActiveProfileKey(profile.key);
      return {
        profile,
        backupPath: backupId ? path.join(this.backupsRoot, backupId, AUTH_FILE) : null,
      };
    } catch (error) {
      this.restoreBackupTo(backupId, this.targetAuthPath);
      throw error;
    }
  }

  createBackup(now) {
    return fs.existsSync(this.targetAuthPath) ? this.backupExistingFile(this.targetAuthPath, now) : null;
  }

  backupExistingFile(sourceFile, now) {
    this.ensureDirs();
    const stamp = this.formatBackupStamp(now);
    let dir = path.join(this.backupsRoot, stamp);
    let suffix = 2;
    while (fs.existsSync(dir)) {
      dir = path.join(this.backupsRoot, `${stamp}-${suffix}`);
      suffix += 1;
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sourceFile, path.join(dir, AUTH_FILE));
    this.pruneBackups(dir);
    return path.basename(dir);
  }

  formatBackupStamp(now) {
    const pad = (n) => String(n).padStart(2, "0");
    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join("");
  }

  pruneBackups(keepDir) {
    let dirs = [];
    try {
      dirs = fs
        .readdirSync(this.backupsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.backupsRoot, entry.name))
        .sort();
    } catch {
      return;
    }

    const stale = dirs.filter((dir) => path.resolve(dir).toLowerCase() !== path.resolve(keepDir).toLowerCase());
    for (const dir of stale.slice(0, Math.max(0, stale.length - (BACKUP_KEEP - 1)))) {
      this.removePathIfInsideHome(dir);
    }
  }

  restoreBackupTo(backupId, destinationPath) {
    if (!backupId) return;

    const backupAuth = path.join(this.backupsRoot, backupId, AUTH_FILE);
    if (!fs.existsSync(backupAuth)) return;

    try {
      this.copyFileAtomic(backupAuth, destinationPath);
    } catch {
      // 원래 오류를 가리지 않기 위해 rollback 실패는 호출부로 다시 던지지 않습니다.
    }
  }

  resolveCodexCommandForBatch() {
    try {
      const result = spawnSync("where.exe", ["codex"], {
        encoding: "utf8",
        windowsHide: true,
      });

      if (result.status !== 0) return null;

      const candidates = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      return (
        candidates.find((candidate) => candidate.toLowerCase().endsWith(".cmd")) ||
        candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ||
        candidates[0] ||
        null
      );
    } catch {
      return null;
    }
  }

  normalizeUsageWindow(window, { source = "main", windowKey, scope = null } = {}) {
    if (!window || typeof window !== "object") return null;

    const usedPercent = Number(window.used_percent ?? window.usedPercent);
    const absoluteReset = Number(
      window.resets_at ?? window.reset_at ?? window.resetsAt ?? window.resetAt
    );
    const resetAfterSeconds = Number(window.reset_after_seconds ?? window.resetAfterSeconds);
    const resetsAt = Number.isFinite(absoluteReset)
      ? absoluteReset
      : Number.isFinite(resetAfterSeconds)
        ? Math.floor(Date.now() / 1000 + resetAfterSeconds)
        : null;
    const minuteDuration = Number(window.window_minutes ?? window.windowMinutes);
    const secondDuration = Number(
      window.limit_window_seconds ??
      window.limitWindowSeconds ??
      window.window_seconds ??
      window.windowSeconds ??
      window.duration_seconds ??
      window.durationSeconds ??
      window.period_seconds ??
      window.periodSeconds
    );
    const windowMinutes = Number.isFinite(minuteDuration) && minuteDuration > 0
      ? minuteDuration
      : Number.isFinite(secondDuration) && secondDuration > 0
        ? secondDuration / 60
        : null;

    return {
      used_percent: Number.isFinite(usedPercent) ? usedPercent : 0,
      window_minutes: windowMinutes,
      resets_at: Number.isFinite(resetsAt) ? resetsAt : null,
      source,
      window_key: windowKey || null,
      scope,
    };
  }

  normalizeRateLimitWindows(rateLimit, { source, scope = null } = {}) {
    if (!rateLimit || typeof rateLimit !== "object") return [];
    const candidates = [
      ["primary", rateLimit.primary_window ?? rateLimit.primaryWindow],
      ["secondary", rateLimit.secondary_window ?? rateLimit.secondaryWindow],
    ];
    const knownKeys = new Set(["primary", "secondary"]);
    for (const [key, window] of Object.entries(rateLimit)) {
      if (!/(?:_window|Window)$/.test(key)) continue;
      const windowKey = key.replace(/_window$/, "").replace(/Window$/, "");
      if (!windowKey || knownKeys.has(windowKey)) continue;
      knownKeys.add(windowKey);
      candidates.push([windowKey, window]);
    }

    const windows = candidates
      .map(([windowKey, window]) => this.normalizeUsageWindow(window, { source, windowKey, scope }))
      .filter(Boolean);
    return windows;
  }

  normalizeUsageWindows(payload) {
    const windows = [];
    const seen = new Set();
    const add = (items) => {
      for (const item of items) {
        const key = `${item.source}:${item.window_key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        windows.push(item);
      }
    };

    add(this.normalizeRateLimitWindows(payload.rate_limit ?? payload.rateLimit, { source: "main" }));
    const additional = payload.additional_rate_limits ?? payload.additionalRateLimits;
    if (Array.isArray(additional)) {
      additional.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const limitName = String(item.limit_name ?? item.limitName ?? "추가 사용량").trim() || "추가 사용량";
        add(this.normalizeRateLimitWindows(item.rate_limit ?? item.rateLimit, {
          source: `additional:${index}:${limitName}`,
          scope: limitName,
        }));
      });
    }
    add(this.normalizeRateLimitWindows(payload.code_review_rate_limit ?? payload.codeReviewRateLimit, {
      source: "code-review",
      scope: "코드 리뷰",
    }));
    return windows;
  }

  // 더블클릭 사용량 조회는 live ~/.codex/auth.json 기준으로 매번 직접 조회합니다.
  async fetchCurrentUsage() {
    if (typeof fetch !== "function") {
      throw new Error("이 Electron 런타임에서 fetch를 사용할 수 없습니다.");
    }

    const current = this.readCurrentAuthSummary();
    if (!current.hasAuth || !current.accessToken) {
      throw new Error("현재 Codex 로그인 정보가 없습니다.");
    }

    const headers = {
      Authorization: `Bearer ${current.accessToken}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };

    if (current.accountId) {
      headers["ChatGPT-Account-Id"] = current.accountId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(CODEX_USAGE_URL, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`사용량 API가 HTTP ${response.status}를 반환했습니다.`);
    }

    const payload = await response.json();
    const windows = this.normalizeUsageWindows(payload);
    const primary = windows.find((window) => window.source === "main" && window.window_key === "primary") || null;
    const secondary = windows.find((window) => window.source === "main" && window.window_key === "secondary") || null;
    const planType = payload.plan_type || payload.planType || current.planType || null;
    const email = payload.email || current.email || current.displayId || null;

    return {
      profile: {
        ...current,
        displayId: email,
        planType,
        label: this.formatProfileLabel(email || current.displayId, planType),
      },
      source: "backend-api",
      recordedAt: new Date().toISOString(),
      rateLimits: {
        plan_type: planType,
        primary,
        secondary,
        windows,
      },
    };
  }
}

module.exports = {
  CodexAccountSwitcher,
};
