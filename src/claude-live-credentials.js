const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { atomicWrite } = require("./provider-profile-store");

// Claude Code의 live 자격 증명 위치는 OS마다 다릅니다.
// - Windows/리눅스: ~/.claude/.credentials.json 파일
// - macOS: 로그인 Keychain의 "Claude Code-credentials" 항목
// 이 모듈은 두 위치를 같은 read()/write() 인터페이스로 감쌉니다.
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

function createClaudeFileStore(home = os.homedir()) {
  const file = path.join(home, ".claude", ".credentials.json");
  return {
    kind: "file",
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    write(secret) {
      atomicWrite(file, secret);
    },
  };
}

function readKeychainAccount(service) {
  const result = spawnSync("security", ["find-generic-password", "-s", service], {
    encoding: "utf8",
    timeout: 10000,
  });
  const match = String(result.stdout || "").match(/"acct"<blob>="([^"]*)"/);
  return match ? match[1] : null;
}

// getSettingsData 한 번에 read()가 여러 번(snapshotCurrent 2회 + listProfiles) 호출되는데
// 각 호출이 `security` 서브프로세스를 새로 띄워 메인 프로세스를 블로킹합니다. 짧은 TTL로 캐시해
// 같은 설정 로드 안에서는 한 번만 spawn하도록 합니다. write는 캐시를 무효화합니다.
const KEYCHAIN_READ_TTL_MS = 2000;

function createClaudeKeychainStore() {
  let cached = null;
  let cachedAt = 0;

  function readFromKeychain() {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 10000 }
    );
    if (result.status !== 0) return null;
    const raw = String(result.stdout || "").trim();
    try {
      return JSON.parse(raw);
    } catch {
      // 비ASCII 바이트가 섞인 항목은 security가 hex로 출력합니다.
      if (/^[0-9a-f]+$/i.test(raw)) {
        try {
          return JSON.parse(Buffer.from(raw, "hex").toString("utf8"));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  return {
    kind: "keychain",
    read() {
      const now = Date.now();
      if (cached !== null && now - cachedAt < KEYCHAIN_READ_TTL_MS) return cached;
      cached = readFromKeychain();
      cachedAt = now;
      return cached;
    },
    write(secret) {
      const account = readKeychainAccount(CLAUDE_KEYCHAIN_SERVICE) || os.userInfo().username;
      const payload = JSON.stringify(secret);
      // security -i 대화형 파서는 따옴표/역슬래시 이스케이프를 온전히 지원하지 않아 값이 잘립니다.
      // argv 전달은 바이트 단위로 정확합니다. 실행되는 짧은 순간 ps 인수에 노출되는 트레이드오프가 있지만
      // 단일 사용자 데스크톱 전제에서 수용합니다.
      const result = spawnSync(
        "security",
        ["add-generic-password", "-U", "-a", account, "-s", CLAUDE_KEYCHAIN_SERVICE, "-w", payload],
        { encoding: "utf8", timeout: 10000 }
      );
      if (result.status !== 0) {
        throw new Error(
          String(result.stderr || "").trim() || "Keychain에 Claude 자격 증명을 저장하지 못했습니다."
        );
      }
      // 저장했으니 캐시를 비우고, 결과를 바로 다시 읽어 원문과 다르면 실패로 처리합니다. (회귀 방지)
      cached = null;
      if (JSON.stringify(readFromKeychain()) !== payload) {
        throw new Error("Keychain에 저장된 Claude 자격 증명이 원문과 일치하지 않습니다.");
      }
    },
  };
}

// 플랫폼에 맞는 live 저장소를 만듭니다. 테스트나 특수 환경에서는 file 저장소를 직접 주입하세요.
function createClaudeLiveStore({ home = os.homedir(), platform = process.platform } = {}) {
  return platform === "darwin" ? createClaudeKeychainStore() : createClaudeFileStore(home);
}

module.exports = {
  CLAUDE_KEYCHAIN_SERVICE,
  createClaudeFileStore,
  createClaudeKeychainStore,
  createClaudeLiveStore,
};
