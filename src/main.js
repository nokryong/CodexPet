const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, shell } = require("electron");
const { spawn, spawnSync, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAccountSwitcher } = require("./codex-account-switcher");
const { CodexWatcher } = require("./codex-watcher");
const { AntigravityWatcher } = require("./antigravity-watcher");
const { ClaudeWatcher } = require("./claude-watcher");
const { ClaudeAccountSwitcher } = require("./claude-account-switcher");
const { normalizeClaudeAccountMetadata } = require("./claude-account-metadata");
const { AntigravityAccountSwitcher } = require("./antigravity-account-switcher");
const {
  clearUsageCache,
  fetchAntigravityIdentity,
  fetchClaudeUsage,
  fetchAntigravityUsage,
} = require("./provider-usage");
const { deleteCredential, readCredential, writeCredential } = require("./credential-store");
const { createClaudeLiveStore } = require("./claude-live-credentials");
const {
  CodexProxy,
  disableProxyInConfig,
  enableProxyInConfig,
} = require("./codex-proxy");
const { formatActivityTitle } = require("./activity-title");
const { ActivityBubbleState, applyActivityPrivacy } = require("./activity-bubble-state");
const {
  createStableWindowBounds,
  normalizeWindowSize,
  restoreWindowGeometry,
} = require("./window-geometry");
const { normalizeFontFamily } = require("./appearance-settings");
const { buildAccountSubmenu } = require("./account-submenu");
const { rateWindowLabel } = require("./codex-usage-label");
const { commandNeedsShell, selectCommandPath } = require("./command-resolution");
const { buildWindowsCodexLaunchScript } = require("./codex-desktop-launch");
const { getInstalledFonts } = require("./installed-fonts");
const {
  movementPreferencesPatch,
  normalizeMovementPreferences,
} = require("./movement-preferences");
const {
  advanceRoamingPosition,
  createRoamingVector,
  hasBlockingMovementReasons,
  isActivityOnlyReason,
} = require("./movement-policy");
const {
  DEFAULT_SPRITE_ROWS,
  V2_SPRITE_ROWS,
  detectSpriteRows,
  directionIndexFromVector,
} = require("./sprite-layout");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// IPC 채널명은 main/preload/renderer가 같은 문자열을 써야 하므로 상수로 모아 둡니다.
// 나중에 기능을 늘릴 때도 이 객체에 채널을 추가하면 검색과 변경이 쉬워집니다.
const IPC_CHANNELS = Object.freeze({
  GET_APP_CONFIG: "pet:get-app-config",
  SET_STATE: "pet:set-state",
  REQUEST_REACTION: "pet:request-reaction",
  SHOW_CONTEXT_MENU: "pet:show-context-menu",
  DRAG_START: "pet:drag-start",
  DRAG_MOVE: "pet:drag-move",
  DRAG_END: "pet:drag-end",
  RESIZE_WINDOW: "pet:resize-window",
  RESIZE_END: "pet:resize-end",
  SHOW_CODEX_STATUS: "pet:show-codex-status",
  SET_SPRITE: "pet:set-sprite",
});

// 말풍선 창 전용 채널입니다. bubble-preload.js와 같은 문자열을 사용해야 합니다.
const BUBBLE_CHANNELS = Object.freeze({
  UPDATE: "bubble:update",
  RESIZE: "bubble:resize",
  DISMISS: "bubble:dismiss",
  ACTION: "bubble:action",
});

// 말풍선 버튼에서 main process로 전달하는 action id입니다.
// renderer에는 인증 파일 경로나 토큰을 넘기지 않고, 이 id만 넘깁니다.
const BUBBLE_ACTIONS = Object.freeze({
  LOGIN_CODEX_ACCOUNT: "codex-account:login",
  SAVE_CODEX_ACCOUNT: "codex-account:save-current",
  SWITCH_CODEX_ACCOUNT: "codex-account:switch",
  OPEN_CODEX_THREAD: "codex-thread:open",
});

const ACTIVITY_BUBBLE_MODES = Object.freeze({
  FULL: "full",
  STATUS: "status",
  OFF: "off",
});

const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 창 크기는 스프라이트 한 칸의 크기와 같게 맞춥니다.
// 다른 셀 크기의 스프라이트시트로 바꾸면 WINDOW_CONFIG와 renderer.js의 SPRITE_CONFIG를 같이 바꾸세요.
const WINDOW_CONFIG = Object.freeze({
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  skipTaskbar: true,
  backgroundColor: "#00000000",
  hasShadow: false,
});

// 개발 중 DevTools를 열고 싶으면 PowerShell에서 `$env:PET_DEVTOOLS="1"; npm run dev`처럼 실행합니다.
// 운영처럼 조용히 확인하려면 환경변수를 비워 두면 됩니다.
const OPEN_DEVTOOLS =
  process.env.PET_DEVTOOLS === "1" || process.argv.includes("--devtools");

// 이동 관련 값은 여기만 바꾸면 됩니다.
// speedPxPerTick은 16ms마다 이동하는 픽셀 수라서 값을 키우면 펫이 더 빨리 걸어갑니다.
const MOVEMENT_CONFIG = Object.freeze({
  tickMs: 16,
  speedPxPerTick: 0.725,
  dragDirectionThresholdPx: 2,
  minWalkMs: 3200,
  maxWalkMs: 6500,
  minIdleMs: 2100,
  maxIdleMs: 3300,
  idleAfterDragMs: 900,
  idleAfterReactionMs: 650,
});

// Codex 계정 전환 뒤 Codex Desktop App을 다시 띄우는 설정입니다.
// codex-auth/codex-profile류 스위처들은 auth를 바꾼 뒤 실행 중인 클라이언트를 재시작해야
// 새 auth가 확실히 적용되는 구조를 씁니다. CodePet도 같은 흐름을 따릅니다.
// enabledAfterAccountSwitch를 false로 바꾸면 active 프로필만 저장하고 재시작은 하지 않습니다.
const CODEX_DESKTOP_RESTART_CONFIG = Object.freeze({
  enabledAfterAccountSwitch: true,
  windowsProcessPathMarker: "\\WindowsApps\\OpenAI.Codex_",
  launchDelayMs: 900,
  timeoutMs: 20000,
});

// renderer에서 크기 조절 요청이 들어와도 main process에서 다시 검증합니다.
// 잘못된 IPC 값이 BrowserWindow API까지 도달하면 드래그 때처럼 main process 예외가 날 수 있습니다.
const RESIZE_CONFIG = Object.freeze({
  minWidth: 64,
  maxWidth: 512,
  aspectRatio: 208 / 192,
});

// renderer.js의 PET_STATES와 같은 의미의 최소 정보입니다.
// main process는 반응 애니메이션이 끝날 때까지 자동 이동을 멈추기 위해 duration만 계산합니다.
const STATE_TIMING = Object.freeze({
  idle: { frames: 6, fps: 3 },
  runningRight: { frames: 8, fps: 5 },
  runningLeft: { frames: 8, fps: 5 },
  waving: { frames: 4, fps: 4 },
  jumping: { frames: 5, fps: 5 },
  failed: { frames: 8, fps: 4 },
  waiting: { frames: 8, fps: 3 },
  running: { frames: 8, fps: 4 },
  review: { frames: 8, fps: 3 },
  lookRow9: { frames: 8, fps: 4 },
  lookRow10: { frames: 8, fps: 4 },
});

// 내장 기본 스프라이트입니다. 아래 우선순위에서 마지막 fallback으로만 사용합니다.
const SPRITE_ASSET = Object.freeze({
  fileName: "spritesheet.webp",
  filePath: path.join(__dirname, "default-pet", "spritesheet.webp"),
  mimeType: "image/webp",
  spriteVersionNumber: 2,
});

// Codex CLI가 설치한 펫 에셋 폴더입니다. 폴더마다 pet.json + spritesheet.webp가 들어 있고,
// renderer가 실제 이미지 비율로 v1(8x9)과 v2(8x11)를 자동 판별합니다.
const CODEX_PETS_DIR = path.join(os.homedir(), ".codex", "pets");

// 개발 모드에서는 프로젝트 루트, 패키징된 exe에서는 exe가 있는 폴더입니다.
// 사용자가 커스텀 스프라이트를 두는 위치의 기준이 됩니다.
// portable exe는 실행 시 임시 폴더에 풀리므로 process.execPath 대신
// electron-builder가 넣어주는 PORTABLE_EXECUTABLE_DIR(원래 exe 위치)를 사용해야 합니다.
function getBaseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..");
}

// 트레이 아이콘은 개발 중에는 build/icon.ico를, 패키징된 exe에서는 extraResources로 복사된 icon.ico를 우선 사용합니다.
// 아이콘 파일을 못 찾더라도 트레이 기능 자체가 죽지 않게 투명한 1px PNG를 fallback으로 만듭니다.
function createTrayIcon() {
  // macOS 메뉴바는 .ico를 읽지 못하므로 png를 우선 사용하고, 메뉴바 크기에 맞게 줄입니다.
  const iconNames = process.platform === "darwin" ? ["icon.png", "icon.ico"] : ["icon.ico", "icon.png"];
  const iconCandidates = iconNames.flatMap((name) => [
    path.join(process.resourcesPath || "", name),
    path.join(__dirname, "..", "build", name),
    path.join(getBaseDir(), name),
  ]);

  const iconPath = iconCandidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image;
    }
  }

  console.warn("[desktop-pet] Tray icon not found. Using transparent fallback icon.");
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
  );
}

// 선택한 펫 같은 간단한 설정을 userData/settings.json에 저장합니다.
function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const current = readSettings();
  delete current.themeSource;
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.warn("[desktop-pet] Failed to save settings.", error.message);
  }
}

function getActivityBubbleMode() {
  const savedMode = readSettings().activityBubbleMode;
  return Object.values(ACTIVITY_BUBBLE_MODES).includes(savedMode)
    ? savedMode
    : ACTIVITY_BUBBLE_MODES.FULL;
}

function setActivityBubbleMode(mode) {
  if (!Object.values(ACTIVITY_BUBBLE_MODES).includes(mode)) return;

  writeSettings({ activityBubbleMode: mode });
  refreshTrayMenu();

  // 수동으로 연 사용량/계정 말풍선은 건드리지 않고 자동 작업 말풍선만 즉시 갱신합니다.
  if (pendingBubbleData?.activityPrivacy) {
    if (pendingBubbleData.activitySource === "active") {
      restoreActiveActivityBubble();
    } else {
      const visibleData = createVisibleActivityBubble(currentActivityBubbleData);
      if (visibleData) showBubble(visibleData);
      else hideBubble();
    }
    return;
  }

  // off에서 다시 켰을 때 새 watcher 이벤트를 기다리지 않고 현재 활성 목록을 즉시 복원합니다.
  // 사용량/계정 같은 수동 말풍선이 떠 있으면 그 화면은 그대로 둡니다.
  if (
    !pendingBubbleData &&
    mode !== ACTIVITY_BUBBLE_MODES.OFF &&
    isAnyProviderWorking() &&
    activeActivityBubbles.size > 0
  ) {
    restoreActiveActivityBubble();
  }
}

function buildActivityBubbleModeSubmenu() {
  const currentMode = getActivityBubbleMode();
  return [
    {
      label: "전체 내용",
      type: "radio",
      checked: currentMode === ACTIVITY_BUBBLE_MODES.FULL,
      click: () => setActivityBubbleMode(ACTIVITY_BUBBLE_MODES.FULL),
    },
    {
      label: "상태만",
      type: "radio",
      checked: currentMode === ACTIVITY_BUBBLE_MODES.STATUS,
      click: () => setActivityBubbleMode(ACTIVITY_BUBBLE_MODES.STATUS),
    },
    {
      label: "끄기",
      type: "radio",
      checked: currentMode === ACTIVITY_BUBBLE_MODES.OFF,
      click: () => setActivityBubbleMode(ACTIVITY_BUBBLE_MODES.OFF),
    },
  ];
}

// 사용할 수 있는 펫 목록을 우선순위 순서로 모읍니다.
//  1. exe(또는 프로젝트) 옆 pet/spritesheet.webp — 목록에 없는 커스텀 스프라이트용
//  2. ~/.codex/pets/* — Codex가 설치한 펫들 (pet.json의 displayName을 메뉴 이름으로 사용)
//  3. 내장 기본 스프라이트
function listAvailablePets() {
  const pets = [];

  const customDir = path.join(getBaseDir(), "pet");
  const customPath = path.join(customDir, "spritesheet.webp");
  if (fs.existsSync(customPath)) {
    let spriteVersionNumber = null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(customDir, "pet.json"), "utf8"));
      spriteVersionNumber = Number(meta.spriteVersionNumber) || null;
    } catch {
      // pet.json이 없어도 이미지 크기로 규격을 판별합니다.
    }
    pets.push({
      key: "custom",
      label: "커스텀 (pet 폴더)",
      spritePath: customPath,
      spriteVersionNumber,
    });
  }

  let codexPetNames = [];
  try {
    codexPetNames = fs.readdirSync(CODEX_PETS_DIR);
  } catch {
    // Codex가 설치되지 않은 PC면 그냥 건너뜁니다.
  }

  for (const name of codexPetNames) {
    const spritePath = path.join(CODEX_PETS_DIR, name, "spritesheet.webp");
    if (!fs.existsSync(spritePath)) continue;

    let label = name;
    let spriteVersionNumber = null;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(CODEX_PETS_DIR, name, "pet.json"), "utf8")
      );
      if (meta.displayName) label = meta.displayName;
      spriteVersionNumber = Number(meta.spriteVersionNumber) || null;
    } catch {
      // pet.json이 없거나 형식이 달라도 폴더명으로 표시하면 됩니다.
    }

    pets.push({ key: `codex:${name}`, label, spritePath, spriteVersionNumber });
  }

  if (fs.existsSync(SPRITE_ASSET.filePath)) {
    pets.push({
      key: "builtin",
      label: "기본 펫 (내장)",
      spritePath: SPRITE_ASSET.filePath,
      spriteVersionNumber: SPRITE_ASSET.spriteVersionNumber,
    });
  }

  return pets;
}

// 저장된 선택이 유효하면 그 펫을, 아니면(첫 실행, 펫 삭제됨 등) 목록의 첫 번째를 사용합니다.
function resolveSelectedPet() {
  const pets = listAvailablePets();
  if (pets.length === 0) return null;

  const savedKey = readSettings().petKey;
  return pets.find((pet) => pet.key === savedKey) || pets[0];
}

function detectPetSpriteRows(pet = resolveSelectedPet()) {
  if (!pet?.spritePath) return null;

  try {
    const size = nativeImage.createFromPath(pet.spritePath).getSize();
    return detectSpriteRows({
      width: size.width,
      height: size.height,
      spriteVersionNumber: pet.spriteVersionNumber,
    });
  } catch (error) {
    console.warn("[desktop-pet] Failed to detect sprite rows for menu.", error.message);
    return Number(pet.spriteVersionNumber) === 2 ? V2_SPRITE_ROWS : null;
  }
}

// 스프라이트 파일을 renderer가 바로 쓸 수 있는 data URL로 바꿉니다.
// portable exe에서는 내장 assets가 app.asar 안에 들어가고, renderer가 file:// 경로를 직접 읽으면
// 투명창만 뜨는 식으로 실패할 수 있습니다. main process가 파일을 읽어서 넘기면
// 내장 스프라이트, ~/.codex/pets, exe 옆 pet 폴더를 같은 방식으로 안정적으로 처리할 수 있습니다.
function createSpritePayload(pet) {
  if (!pet) {
    return {
      spriteUrl: null,
      spritePath: "pet/spritesheet.webp (not found)",
      assetExists: false,
    };
  }

  try {
    const spriteBuffer = fs.readFileSync(pet.spritePath);
    const spriteUrl = `data:${SPRITE_ASSET.mimeType};base64,${spriteBuffer.toString("base64")}`;

    return {
      spriteUrl,
      spritePath: pet.spritePath,
      spriteVersionNumber: pet.spriteVersionNumber || null,
      assetExists: true,
    };
  } catch (error) {
    console.error(`[desktop-pet] Failed to read sprite: ${pet.spritePath}`, error);

    return {
      spriteUrl: null,
      spritePath: pet.spritePath,
      assetExists: false,
    };
  }
}

// 메뉴에서 펫을 고르면 저장하고 renderer의 스프라이트를 즉시 교체합니다.
function applyPet(petKey) {
  writeSettings({ petKey });

  const pet = resolveSelectedPet();
  if (!pet) return;
  runtime.spriteRows = detectPetSpriteRows(pet) || DEFAULT_SPRITE_ROWS;
  if (!petWindow || petWindow.isDestroyed()) return;

  petWindow.webContents.send(IPC_CHANNELS.SET_SPRITE, createSpritePayload(pet));
  refreshTrayMenu();
}

// 말풍선 창 관련 설정입니다. 너비는 고정하고 높이는 내용에 맞춰 renderer가 보고합니다.
const BUBBLE_CONFIG = Object.freeze({
  width: 270,
  minHeight: 48,
  maxHeight: 420,
  gapPx: 2,
  renderFallbackMs: 350,
  loadTimeoutMs: 2500,
  recreateDelayMs: 250,
  usageAutoHideMs: 12000,
  doneAutoHideMs: 8000,
  activityMaxChars: 240,
});

let petWindow = null;
let settingsWindow = null;
let movementTimer = null;
let phaseTimer = null;
let reactionTimer = null;
let dragSession = null;
let tray = null;
let isQuitting = false;
let petHiddenToTray = false;
let lastPetVisualRefreshMs = 0;
let hasInitializedWindowGeometry = false;

let bubbleWindow = null;
let bubbleHideTimer = null;
let bubbleRenderFallbackTimer = null;
let bubbleLoadWatchdogTimer = null;
let bubbleRecreateTimer = null;
let codexLoginLaunchInProgress = false;
// 말풍선 창 renderer가 아직 로드 전이어도 Codex 대화 이벤트를 잃지 않기 위한 상태입니다.
let bubbleReady = false;
let pendingBubbleData = null;
// 내용 갱신(UPDATE) 후 renderer가 높이를 보고(RESIZE)해야 창을 보여줍니다.
// 그 사이에 hide 요청이 오면 표시를 취소하기 위한 플래그입니다.
let bubblePendingShow = false;
let bubbleHeight = 80;
// 현재 화면에 올린 자동 작업 말풍선 원본입니다. 개인정보 모드 변경 시 같은 내용을 다시 필터링합니다.
let currentActivityBubbleData = null;
// rollout thread별 마지막 활동입니다. 다중 작업이면 renderer에 sections로 전달합니다.
const activeActivityBubbles = new ActivityBubbleState();

// 사용률이 이 값을 넘으면 펫이 자발적으로 경고 말풍선을 띄웁니다.
const USAGE_WARN_THRESHOLD_PERCENT = 90;
// 같은 초기화 주기 안에서 경고를 반복하지 않도록 마지막으로 경고한 resets_at을 기억합니다.
const usageWarnedResets = { primary: null, secondary: null };

const codexAccountSwitcher = new CodexAccountSwitcher();

// Codex 재시작 없는 전환 + 한도 자동 로테이션용 로컬 프록시입니다. (명시적 opt-in)
// 선호 순서: 활성 프로필 → 나머지 저장 프로필. 저장 프로필이 하나도 없으면 live auth.json 하나로 동작.
// 저장 프로필에서 직접 읽으므로 실행 중인 Codex 앱이 auth.json을 되덮어써도 전환이 유지됩니다.
// listProfiles()는 디렉토리 스캔 + auth.json 해시 등 무거운 동기 fs라서, 프록시가 요청마다
// 호출하면 메인 프로세스가 매번 블로킹됩니다. 프로필은 명시적 전환/로그인 때만 바뀌므로
// 짧은 TTL로 캐시하고, 전환 지점에서 명시적으로 무효화합니다.
const PROXY_ACCOUNTS_TTL_MS = 1500;
let cachedProxyAccounts = null;
let cachedProxyAccountsAt = 0;

function invalidateProxyAccountsCache() {
  cachedProxyAccounts = null;
}

function listCodexProxyAccounts() {
  const now = Date.now();
  if (cachedProxyAccounts && now - cachedProxyAccountsAt < PROXY_ACCOUNTS_TTL_MS) {
    return cachedProxyAccounts;
  }

  const profiles = codexAccountSwitcher.listProfiles().filter((profile) => profile.hasAuth);
  const activeKey = codexAccountSwitcher.readActiveProfileKey();
  const accounts = profiles.map((profile) => ({
    key: profile.key,
    label: profile.label,
    authPath: path.join(profile.homePath, "auth.json"),
  }));
  accounts.sort((left, right) =>
    (right.key === activeKey ? 1 : 0) - (left.key === activeKey ? 1 : 0)
  );
  if (accounts.length === 0 && fs.existsSync(codexAccountSwitcher.targetAuthPath)) {
    accounts.push({ key: "live", label: "현재 계정", authPath: codexAccountSwitcher.targetAuthPath });
  }

  cachedProxyAccounts = accounts;
  cachedProxyAccountsAt = now;
  return accounts;
}

const codexProxy = new CodexProxy({
  log: appendDebugLog,
  resolveAccounts: async () => listCodexProxyAccounts(),
  readAuth: (authPath) => {
    const summary = codexAccountSwitcher.readAuthSummaryFromFile(authPath);
    return summary.hasAuth ? { accessToken: summary.accessToken, accountId: summary.accountId } : null;
  },
  notifySwitch: (account, reason) => {
    // 프록시는 이미 이 계정으로 응답을 스트리밍하는 중입니다. 활성 프로필 영속화(디스크 백업 복사 등
    // 무거운 동기 작업)와 UI 갱신은 응답 중계를 지연시키지 않도록 다음 tick으로 미룹니다.
    setImmediate(() => {
      try {
        if (account.key !== "live") {
          codexAccountSwitcher.switchToProfile(account.key);
          invalidateProxyAccountsCache();
          refreshTrayMenu();
        }
      } catch (error) {
        appendDebugLog(`auto-switch persist failed: ${error.message || String(error)}`);
      }
      appendDebugLog(`codex auto-switch to ${account.key} (${reason})`);
      showCodexAccountBubble(
        `Codex 한도가 소진돼 "${account.label}" 계정으로 자동 전환했습니다.\n재시작 없이 바로 적용됐어요.`
      );
    });
  },
});

// PR에서 약속한 동작대로 신규/기존 설정 모두 기본값은 켜짐입니다.
// 사용자가 메뉴에서 명시적으로 끈 경우에만 false가 저장됩니다.
function isCodexProxyModeEnabled() {
  return readSettings().codexProxyMode !== false;
}

// 프록시가 실제로 config.toml에 주입되어 Codex 트래픽이 프록시를 타는 상태인지입니다.
// start()만 성공하고 주입이 실패하면 running은 true여도 이 값은 false입니다.
let codexProxyActive = false;
let codexProxyStartupPromise = null;
let codexProxyLastError = null;

async function setCodexProxyMode(enabled) {
  try {
    if (enabled) {
      const port = await codexProxy.start();
      enableProxyInConfig(port);
      codexProxyActive = true;
      codexProxyLastError = null;
      writeSettings({ codexProxyMode: true });
      showCodexAccountBubble(
        "재시작 없는 전환(프록시)을 켰습니다.\n실행 중인 Codex CLI/앱은 한 번만 다시 시작하면 이후 전환부터는 재시작이 필요 없습니다."
      );
    } else {
      disableProxyInConfig();
      codexProxy.stop();
      codexProxyActive = false;
      codexProxyLastError = null;
      writeSettings({ codexProxyMode: false });
      showCodexAccountBubble("재시작 없는 전환(프록시)을 껐습니다.\nCodex는 원래 방식으로 되돌아갑니다.");
    }
  } catch (error) {
    appendDebugLog(`codex proxy toggle failed: ${error.message || String(error)}`);
    showCodexAccountBubble(`프록시 모드 전환에 실패했습니다.\n${error.message || String(error)}`);
    if (enabled) {
      // 주입이 실패했으면 Codex가 반쯤 걸린 상태가 되지 않도록 config를 원복하고 완전히 끕니다.
      codexProxyActive = false;
      codexProxyLastError = error;
      try {
        disableProxyInConfig();
      } catch {
        // 원복 실패는 무시합니다.
      }
      codexProxy.stop();
      writeSettings({ codexProxyMode: false });
    }
  }
  refreshTrayMenu();
}

// 앱 시작 시 프록시를 복원합니다.
async function restoreCodexProxyMode() {
  // crash/강제 종료로 이전 실행이 남긴 죽은 프록시 마커를 항상 먼저 정리합니다. (fail-closed)
  // 이렇게 하지 않으면 config.toml이 죽은 포트를 가리켜 Codex 전체가 막힙니다.
  try {
    disableProxyInConfig();
  } catch (error) {
    appendDebugLog(`codex proxy stale cleanup failed: ${error.message || String(error)}`);
  }
  if (!isCodexProxyModeEnabled()) return;
  try {
    const port = await codexProxy.start();
    enableProxyInConfig(port);
    codexProxyActive = true;
    codexProxyLastError = null;
  } catch (error) {
    // 주입 실패(예: 사용자가 직접 openai_base_url을 설정)면 프록시를 완전히 끕니다.
    // 그래야 switchCodexAccount가 프록시 경로로 잘못 빠져 조용히 아무것도 안 하는 상황을 막습니다.
    appendDebugLog(`codex proxy restore failed: ${error.message || String(error)}`);
    codexProxyActive = false;
    codexProxyLastError = error;
    codexProxy.stop();
  }
}

// 종료 시 모드와 무관하게 주입된 마커를 항상 제거합니다. (다음 실행 때 필요하면 재주입)
function teardownCodexProxyOnQuit() {
  try {
    disableProxyInConfig();
  } catch {
    // 종료 경로에서는 실패해도 앱 종료를 막지 않습니다.
  }
  codexProxy.stop();
  codexProxyActive = false;
}
codexAccountSwitcher.cleanupLegacyCodePetState();
codexAccountSwitcher.ensureCurrentAccountProfile();
const codexWatcher = new CodexWatcher();
const antigravityWatcher = new AntigravityWatcher();
const claudeWatcher = new ClaudeWatcher();
// macOS에서는 Claude Code live 자격 증명이 Keychain에 있으므로 플랫폼 저장소를 주입합니다.
const claudeLiveStore = createClaudeLiveStore();
const claudeAccountSwitcher = new ClaudeAccountSwitcher({ liveStore: claudeLiveStore });
const antigravityAccountSwitcher = new AntigravityAccountSwitcher({
  read: async () => JSON.parse(await readCredential("gemini:antigravity")),
  write: async (value) => writeCredential("gemini:antigravity", value),
  clear: async () => deleteCredential("gemini:antigravity"),
  restart: restartAntigravityApp,
});

// runtime은 현재 창 위치, 이동 방향, 수동 일시정지 상태처럼 실행 중 계속 바뀌는 값입니다.
const runtime = {
  width: 192,
  height: 208,
  x: 0,
  y: 0,
  direction: 1,
  velocityX: 1,
  velocityY: 0,
  spriteRows: DEFAULT_SPRITE_ROWS,
  idleState: "waiting",
  currentState: "idle",
  lookDirectionIndex: null,
  lookFallbackState: "idle",
  movementPhase: "idle",
  manualPaused: false,
  pauseReasons: new Set(),
  pauseStates: new Map(),
  followMouse: false,
};

function restoreMovementPreferences() {
  Object.assign(runtime, normalizeMovementPreferences(readSettings()));
}

function persistMovementPreferences() {
  writeSettings(movementPreferencesPatch(runtime));
}

// 주어진 최소/최대 범위 사이에서 랜덤 시간을 뽑습니다.
function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function chooseRandomIdleState() {
  const states = ["waiting", "failed"];
  if (runtime.spriteRows === V2_SPRITE_ROWS) {
    states.push("lookRow10", "lookRow9");
  }
  return states[Math.floor(Math.random() * states.length)];
}

// renderer/preload에서 넘어온 드래그 좌표가 실제 숫자인지 확인합니다.
// 좌표가 undefined나 NaN이면 BrowserWindow.setPosition이 main process 예외를 터뜨리므로 먼저 걸러냅니다.
function isValidScreenPoint(screenPoint) {
  return (
    screenPoint &&
    Number.isFinite(screenPoint.screenX) &&
    Number.isFinite(screenPoint.screenY)
  );
}

// 여러 pause reason이 겹쳤을 때 화면에 보여줄 상태를 정합니다.
// 예: Codex 작업 중(review) 사용자가 클릭해서 waving을 재생한 뒤에는 idle이 아니라 review로 돌아가야 합니다.
function getActivePauseState() {
  for (const reason of ["drag", "reaction"]) {
    const stateName = runtime.pauseStates.get(reason);
    if (stateName) return stateName;
  }

  for (const [reason, stateName] of runtime.pauseStates) {
    if (!isActivityOnlyReason(reason) && stateName) return stateName;
  }

  return "idle";
}

function getActivityPetState() {
  return runtime.pauseStates.get("codex") || null;
}

function hasBlockingPauseReasons() {
  return hasBlockingMovementReasons(runtime.pauseReasons);
}

// 현재 펫이 있는 모니터의 사용 가능한 영역을 가져옵니다.
// 작업 표시줄 영역을 피하려고 bounds가 아니라 workArea를 사용합니다.
function getCurrentWorkArea(x = runtime.x, y = runtime.y) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + runtime.width / 2),
    y: Math.round(y + runtime.height / 2),
  });
  return display.workArea;
}

// 창이 화면 밖으로 나가지 않도록 좌표를 workArea 안쪽으로 제한합니다.
function clampToWorkArea(nextX, nextY, preferredArea = null) {
  const area = preferredArea || getCurrentWorkArea(nextX, nextY);
  const maxX = area.x + area.width - runtime.width;
  const maxY = area.y + area.height - runtime.height;

  return {
    x: Math.min(Math.max(nextX, area.x), maxX),
    y: Math.min(Math.max(nextY, area.y), maxY),
  };
}

// BrowserWindow의 실제 위치를 runtime과 동기화해서 이동시킵니다.
function moveWindowTo(nextX, nextY, { workArea = null } = {}) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    console.warn("[desktop-pet] Invalid window position ignored.", nextX, nextY);
    return;
  }

  const clamped = clampToWorkArea(nextX, nextY, workArea);
  runtime.x = clamped.x;
  runtime.y = clamped.y;
  const bounds = createStableWindowBounds(
    runtime.x,
    runtime.y,
    runtime.width,
    runtime.height
  );
  if (!bounds) {
    console.warn("[desktop-pet] Invalid window bounds ignored.", bounds);
    return;
  }

  // Windows의 100%가 아닌 DPI 배율에서는 resizable:false 창을 setPosition으로 반복 이동할 때
  // 네이티브 창 크기가 누적해서 변할 수 있습니다. 위치와 의도한 크기를 함께 적용해 drift를 막습니다.
  petWindow.setBounds(bounds, false);

  // 말풍선이 떠 있으면 펫을 따라다니게 합니다.
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
    positionBubble();
  }
}

// renderer에 새 애니메이션 상태를 보냅니다.
// 상태 이름을 잘못 보내도 renderer가 idle로 fallback하지만, main에서도 최대한 명확히 관리합니다.
function sendPetState(stateName) {
  runtime.currentState = stateName;
  runtime.lookDirectionIndex = null;
  runtime.lookFallbackState = "idle";

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(IPC_CHANNELS.SET_STATE, stateName);
  }
}

function sendLookDirectionState(directionIndex, fallbackState) {
  const normalizedDirection = ((Math.round(Number(directionIndex) || 0) % 16) + 16) % 16;
  const normalizedFallback = fallbackState === "runningLeft"
    ? "runningLeft"
    : fallbackState === "runningRight"
      ? "runningRight"
      : "idle";

  runtime.currentState = "lookDirection";
  runtime.lookDirectionIndex = normalizedDirection;
  runtime.lookFallbackState = normalizedFallback;

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(IPC_CHANNELS.SET_STATE, {
      state: "lookDirection",
      directionIndex: normalizedDirection,
      fallbackState: normalizedFallback,
    });
  }
}

function ensurePetState(stateName) {
  if (runtime.currentState === stateName && runtime.lookDirectionIndex === null) return;
  sendPetState(stateName);
}

function ensureLookDirectionState(directionIndex, fallbackState) {
  if (
    runtime.currentState === "lookDirection" &&
    runtime.lookDirectionIndex === directionIndex &&
    runtime.lookFallbackState === fallbackState
  ) {
    return;
  }
  sendLookDirectionState(directionIndex, fallbackState);
}

function resendCurrentPetState() {
  if (runtime.currentState === "lookDirection" && runtime.lookDirectionIndex !== null) {
    sendLookDirectionState(runtime.lookDirectionIndex, runtime.lookFallbackState);
    return;
  }
  sendPetState(runtime.currentState || "idle");
}

function ensureMouseLookState() {
  const mouse = screen.getCursorScreenPoint();
  const deltaX = mouse.x - (runtime.x + runtime.width / 2);
  const deltaY = mouse.y - (runtime.y + runtime.height / 2);
  const directionIndex = directionIndexFromVector(deltaX, deltaY);
  if (directionIndex === null) {
    ensurePetState(runtime.idleState || "waiting");
    return;
  }
  ensureLookDirectionState(directionIndex, "idle");
}

function ensureRoamingMotionState() {
  ensurePetState(runtime.direction > 0 ? "runningRight" : "runningLeft");
}

function syncMovementAnimation() {
  if (runtime.manualPaused) {
    ensurePetState("idle");
    return;
  }
  if (hasBlockingPauseReasons()) {
    ensurePetState(getActivePauseState());
    return;
  }

  if (!runtime.followMouse && runtime.movementPhase === "walking") {
    ensureRoamingMotionState();
    return;
  }

  if (runtime.followMouse) {
    ensureMouseLookState();
    return;
  }

  const activityState = getActivityPetState();
  if (activityState) {
    ensurePetState(activityState);
    return;
  }

  ensurePetState(runtime.idleState || "waiting");
}

// 지정 시간 뒤에 다음 이동 phase로 넘어가도록 예약합니다.
function schedulePhase(callback, delayMs) {
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(callback, delayMs);
}

// 자동 이동이 잠깐 멈춰야 하는 이유를 등록합니다.
// drag, reaction처럼 여러 이유가 겹칠 수 있어서 Set으로 관리합니다.
function pauseAutoMovement(reason, stateName = "idle") {
  runtime.pauseReasons.add(reason);
  runtime.pauseStates.set(reason, stateName);

  if (isActivityOnlyReason(reason)) {
    syncMovementAnimation();
    return;
  }

  runtime.movementPhase = "paused";
  clearTimeout(phaseTimer);
  sendPetState(stateName);
}

// 특정 일시정지 이유를 해제합니다.
// 수동 Pause가 켜져 있으면 drag/reaction이 끝나도 자동 이동은 다시 시작하지 않습니다.
function resumeAutoMovement(reason, delayMs = 0) {
  runtime.pauseReasons.delete(reason);
  runtime.pauseStates.delete(reason);

  if (runtime.manualPaused) {
    sendPetState("idle");
    return;
  }

  if (hasBlockingPauseReasons()) {
    sendPetState(getActivePauseState());
    return;
  }

  if (isActivityOnlyReason(reason)) {
    syncMovementAnimation();
    return;
  }

  if (runtime.followMouse) {
    runtime.movementPhase = "looking";
    syncMovementAnimation();
    return;
  }

  runtime.movementPhase = "idle";
  runtime.idleState = chooseRandomIdleState();
  ensurePetState(getActivityPetState() || runtime.idleState);
  schedulePhase(beginWalkingPhase, delayMs);
}

// 걸어가는 phase를 시작합니다.
// 방향에 따라 runningRight/runningLeft 상태를 renderer에 보냅니다.
function beginWalkingPhase() {
  if (runtime.manualPaused || hasBlockingPauseReasons() || runtime.followMouse) return;

  const vector = createRoamingVector();
  runtime.velocityX = vector.x;
  runtime.velocityY = vector.y;
  if (Math.abs(vector.x) >= 0.05) runtime.direction = vector.x > 0 ? 1 : -1;
  runtime.movementPhase = "walking";
  ensureRoamingMotionState();

  const walkMs = randomBetween(MOVEMENT_CONFIG.minWalkMs, MOVEMENT_CONFIG.maxWalkMs);
  schedulePhase(beginIdlePhase, walkMs);
}

// 잠시 멈추는 phase를 시작합니다.
// 이동과 대기를 번갈아 쓰면 펫이 더 자연스럽게 보이고, idle 애니메이션도 확인하기 쉽습니다.
function beginIdlePhase() {
  if (runtime.manualPaused || hasBlockingPauseReasons() || runtime.followMouse) return;

  runtime.movementPhase = "idle";
  runtime.idleState = chooseRandomIdleState();
  ensurePetState(getActivityPetState() || runtime.idleState);

  const idleMs = randomBetween(MOVEMENT_CONFIG.minIdleMs, MOVEMENT_CONFIG.maxIdleMs);
  schedulePhase(beginWalkingPhase, idleMs);
}

function updateMovementTick() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (runtime.manualPaused || hasBlockingPauseReasons()) return;

  if (runtime.followMouse) {
    syncMovementAnimation();
    return;
  }

  if (runtime.movementPhase !== "walking") return;

  const area = getCurrentWorkArea();
  const next = advanceRoamingPosition({
    x: runtime.x,
    y: runtime.y,
    width: runtime.width,
    height: runtime.height,
    velocityX: runtime.velocityX,
    velocityY: runtime.velocityY,
    speed: MOVEMENT_CONFIG.speedPxPerTick,
    workArea: area,
    previousDirection: runtime.direction,
  });
  if (!next) return;

  runtime.velocityX = next.velocityX;
  runtime.velocityY = next.velocityY;
  runtime.direction = next.direction;
  ensureRoamingMotionState();
  moveWindowTo(next.x, next.y);
}

// 앱 시작 시 펫을 기본 모니터의 아래쪽 근처에 배치합니다.
function placeInitialWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  runtime.x = area.x + Math.floor(area.width * 0.55);
  runtime.y = area.y + area.height - runtime.height - 32;
  moveWindowTo(runtime.x, runtime.y);
}

// 사용자 조작으로 확정된 geometry만 저장합니다. 자동 보행 위치는 저장하지 않습니다.
function persistWindowGeometry() {
  writeSettings({
    windowBounds: {
      x: Math.round(runtime.x),
      y: Math.round(runtime.y),
      width: runtime.width,
      height: runtime.height,
    },
  });
}

// 첫 창을 만들기 전에만 저장 geometry를 적용합니다. renderer 복구 창은 현재 runtime 위치를 유지합니다.
function initializeWindowGeometry() {
  if (hasInitializedWindowGeometry) return;

  hasInitializedWindowGeometry = true;
  const restored = restoreWindowGeometry(
    readSettings().windowBounds,
    screen.getAllDisplays(),
    RESIZE_CONFIG
  );

  if (restored) {
    runtime.x = restored.x;
    runtime.y = restored.y;
    runtime.width = restored.width;
    runtime.height = restored.height;
    return;
  }

  placeInitialWindow();
}

// 자동 이동 타이머를 멈춥니다.
// 창을 트레이로 숨길 때는 보이지 않는 창을 계속 움직일 필요가 없으므로 타이머를 정리합니다.
function stopMovementLoop() {
  clearInterval(movementTimer);
  clearTimeout(phaseTimer);
  clearTimeout(reactionTimer);
  movementTimer = null;
  phaseTimer = null;
  reactionTimer = null;
}

// 자동 이동 타이머를 시작합니다.
// resetPosition이 true면 앱 시작처럼 화면 아래쪽에 새로 배치하고,
// false면 트레이에서 다시 보이게 할 때처럼 사용자가 마지막으로 둔 위치를 유지합니다.
function startMovementLoop({ resetPosition = true } = {}) {
  const activityState = getActivityPetState();
  runtime.spriteRows = detectPetSpriteRows() || DEFAULT_SPRITE_ROWS;
  stopMovementLoop();
  runtime.pauseReasons.clear();
  runtime.pauseStates.clear();
  if (activityState) {
    runtime.pauseReasons.add("codex");
    runtime.pauseStates.set("codex", activityState);
  }
  runtime.movementPhase = "idle";

  if (resetPosition) {
    placeInitialWindow();
  } else {
    moveWindowTo(runtime.x, runtime.y);
  }

  if (runtime.followMouse) {
    runtime.movementPhase = "looking";
    syncMovementAnimation();
  } else {
    beginIdlePhase();
  }
  movementTimer = setInterval(updateMovementTick, MOVEMENT_CONFIG.tickMs);
}

// 반응 애니메이션의 재생 시간을 계산합니다.
// fps를 바꾸면 이 계산도 같이 바뀌므로 메뉴/클릭 반응 후 복귀 시간이 자연스럽게 유지됩니다.
function getStateDurationMs(stateName) {
  const timing = STATE_TIMING[stateName] || STATE_TIMING.idle;
  return Math.ceil((timing.frames / timing.fps) * 1000) + 80;
}

// 클릭/더블클릭/메뉴 테스트용 단발 애니메이션을 재생합니다.
// 나중에 Codex 상태 연동을 붙이면, 상태 이벤트를 받아 이 함수나 sendPetState를 호출하면 됩니다.
function playReaction(stateName) {
  const nextState = STATE_TIMING[stateName] ? stateName : "idle";

  clearTimeout(reactionTimer);

  if (nextState === "idle") {
    pauseAutoMovement("reaction", "idle");
    reactionTimer = setTimeout(() => {
      resumeAutoMovement("reaction", MOVEMENT_CONFIG.idleAfterReactionMs);
    }, getStateDurationMs("idle"));
    return;
  }

  pauseAutoMovement("reaction", nextState);
  reactionTimer = setTimeout(() => {
    resumeAutoMovement("reaction", MOVEMENT_CONFIG.idleAfterReactionMs);
  }, getStateDurationMs(nextState));
}

function playManualReaction(stateName) {
  const next = STATE_TIMING[stateName] ? stateName : "idle";
  clearTimeout(reactionTimer);
  pauseAutoMovement("reaction", next);
  const duration = getStateDurationMs(next);
  let remaining = 2;

  const repeat = () => {
    if (remaining > 0) {
      remaining -= 1;
      sendPetState(next);
      reactionTimer = setTimeout(repeat, duration);
      return;
    }
    resumeAutoMovement("reaction", MOVEMENT_CONFIG.idleAfterReactionMs);
  };
  reactionTimer = setTimeout(repeat, duration);
}

function isAnyProviderWorking() {
  return codexWatcher.working || antigravityWatcher.working || claudeWatcher.working;
}

// 수동 Pause/Resume 메뉴 항목에서 자동 이동을 토글합니다.
function toggleManualPause() {
  runtime.manualPaused = !runtime.manualPaused;
  persistMovementPreferences();

  if (runtime.manualPaused) {
    clearTimeout(phaseTimer);
    sendPetState("idle");
    refreshTrayMenu();
    return;
  }

  if (runtime.followMouse) {
    runtime.movementPhase = "looking";
    syncMovementAnimation();
  } else {
    beginIdlePhase();
  }
  refreshTrayMenu();
}

// 윈도우 로그인 시 자동 실행 설정입니다.
// - portable exe: 임시 폴더의 execPath가 아니라 원래 exe 경로를 등록해야 합니다.
// - 개발 모드(npm run dev): 실행 파일이 electron.exe라서 앱 경로를 인자로 함께 등록합니다.
// - 설치형/일반 패키징: 실행 파일 자체를 등록하면 됩니다.
function getLoginItemOptions() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return { path: process.env.PORTABLE_EXECUTABLE_FILE };
  }
  return app.isPackaged
    ? {}
    : { path: process.execPath, args: [app.getAppPath()] };
}

function isAutoLaunchEnabled() {
  return app.getLoginItemSettings(getLoginItemOptions()).openAtLogin;
}

function toggleAutoLaunch() {
  app.setLoginItemSettings({
    openAtLogin: !isAutoLaunchEnabled(),
    ...getLoginItemOptions(),
  });
}

// 펫 선택 메뉴는 펫 우클릭 메뉴와 시스템 트레이 메뉴에서 같이 사용합니다.
// 새 펫 소스를 추가할 때 listAvailablePets()만 확장하면 두 메뉴가 동시에 갱신됩니다.
function buildPetSelectionSubmenu() {
  const currentPetKey = resolveSelectedPet()?.key;
  const pets = listAvailablePets();

  if (pets.length === 0) {
    return [
      {
        label: "사용 가능한 스프라이트 없음",
        enabled: false,
      },
    ];
  }

  return pets.map((pet) => ({
    label: pet.label,
    type: "radio",
    checked: pet.key === currentPetKey,
    click: () => applyPet(pet.key),
  }));
}

// Codex 계정은 저장된 auth profile 단위로 표시합니다.
// 빈 pending 로그인 폴더는 codex-account-switcher.js에서 걸러서 UI에 나오지 않습니다.
function formatCodexAccountLabel(profile) {
  const label = profile.hasAuth
    ? profile.label || `Codex ${profile.shortId || "unknown"}`
    : `${profile.id || profile.key} (로그인 필요)`;
  return profile.active ? `${label} (현재)` : label;
}

// PowerShell 명령 문자열에 파일 경로를 안전하게 넣기 위한 작은 helper입니다.
// 경로 안에 작은따옴표가 있어도 PowerShell single-quoted string 규칙에 맞게 이스케이프합니다.
function quotePowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// cmd.exe /c start 안에 들어갈 경로를 큰따옴표로 감쌉니다.
// Windows 파일 경로에는 보통 큰따옴표가 없지만, 혹시 모를 값을 이스케이프해 둡니다.
function quoteCmdArgument(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

// userData에 남기는 간단한 디버그 로그입니다.
// 로그인 터미널처럼 사용자가 "아무 일도 안 일어났다"고 느끼는 작업은 실제 launcher 오류를 남겨야 추적이 됩니다.
function appendDebugLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "codepet.log"), line, "utf8");
  } catch {
    // 로그 쓰기 실패 때문에 앱 기능 자체를 막지는 않습니다.
  }
}

// macOS에서 더블클릭(shell.openPath)하면 Terminal이 실행하는 .command 셸 스크립트를 만듭니다.
function writeMacLoginScript(fileName, lines) {
  const scriptPath = path.join(app.getPath("userData"), fileName);
  fs.writeFileSync(
    scriptPath,
    ["#!/bin/bash", 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"', ...lines, 'read -r -p "Press Enter to close..." _', ""].join("\n"),
    { encoding: "utf8", mode: 0o755 }
  );
  return scriptPath;
}

function quoteShellArgument(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Codex 공식 로그인 흐름을 실행할 스크립트를 만듭니다. (Windows: .cmd / macOS: .command)
// CodePet은 토큰을 직접 받지 않고, pending profile CODEX_HOME 안에서 `codex login`만 실행하게 합니다.
function writeCodexLoginScript(profile) {
  if (process.platform === "darwin") {
    const codexCommand = resolveCommand("codex", codexCommandCandidates());
    const scriptPath = writeMacLoginScript("codepet-codex-login.command", [
      `echo "CodePet Codex Login - ${profile.id}"`,
      `export CODEX_HOME=${quoteShellArgument(profile.homePath)}`,
      `${codexCommand ? quoteShellArgument(codexCommand) : "codex"} login`,
    ]);
    appendDebugLog(
      `login script written: ${scriptPath}; profile=${profile.key}; home=${profile.homePath}; codex=${codexCommand || "PATH"}`
    );
    return scriptPath;
  }

  const scriptPath = path.join(app.getPath("userData"), "codepet-codex-login.cmd");
  const codexCommand = codexAccountSwitcher.resolveCodexCommandForBatch();
  const codexLoginLine = codexCommand
    ? `call ${quoteCmdArgument(codexCommand)} login`
    : "call codex login";

  fs.writeFileSync(
    scriptPath,
    [
      "@echo off",
      `title CodePet Codex Login - ${profile.id}`,
      "echo CodePet Codex Login",
      "echo.",
      `echo Profile: ${profile.id}`,
      `echo CODEX_HOME: ${profile.homePath}`,
      "set \"CODEX_HOME=" + profile.homePath + "\"",
      "echo.",
      codexCommand
        ? `echo Using Codex command: ${codexCommand}`
        : "echo Codex command was not resolved by CodePet. Trying PATH lookup...",
      "echo.",
      codexCommand ? "" : "where codex >nul 2>nul",
      codexCommand ? "" : "if errorlevel 1 (",
      codexCommand ? "" : "  echo codex command was not found in PATH.",
      codexCommand ? "" : "  echo Install Codex CLI or open a terminal where codex works.",
      codexCommand ? "" : "  echo.",
      codexCommand ? "" : "  pause",
      codexCommand ? "" : "  exit /b 1",
      codexCommand ? "" : ")",
      codexLoginLine,
      "set CODEPET_LOGIN_EXIT=%ERRORLEVEL%",
      "echo.",
      "if not \"%CODEPET_LOGIN_EXIT%\"==\"0\" (",
      "  echo Codex login exited with code %CODEPET_LOGIN_EXIT%.",
      ") else (",
      "  echo Codex login command finished.",
      ")",
      "echo Return to CodePet and open the account switch menu.",
      "echo.",
      "pause",
      "",
    ].filter((line) => line !== "").join("\r\n"),
    "utf8"
  );

  appendDebugLog(
    `login script written: ${scriptPath}; profile=${profile.key}; home=${profile.homePath}; codex=${codexCommand || "PATH"}`
  );
  return scriptPath;
}

// Codex 로그인은 브라우저/OAuth/터미널 상호작용이 필요하므로 CodePet 내부에서 직접 처리하지 않습니다.
// 대신 pending profile CODEX_HOME을 만든 뒤 별도 터미널에서 `codex login`을 한 번만 실행합니다.
async function openCodexLoginTerminal() {
  if (codexLoginLaunchInProgress) {
    showCodexAccountBubble("이미 Codex 로그인 터미널을 여는 중입니다.");
    return false;
  }

  codexLoginLaunchInProgress = true;

  try {
    codexAccountSwitcher.ensureCurrentAccountProfile();
    if (!["win32", "darwin"].includes(process.platform)) {
      throw new Error("현재 CodePet 로그인 실행기는 Windows/macOS용으로 작성되어 있습니다.");
    }

    const profile = codexAccountSwitcher.createLoginProfile();
    const scriptPath = writeCodexLoginScript(profile);

    showCodexAccountBubble(
      "새 Codex 로그인 터미널을 여는 중입니다."
    );

    // 여러 launcher를 순차 시도하면 실패 판정이 애매해서 터미널이 여러 개 뜹니다.
    // ShellExecute 한 경로만 사용하고, 실패하면 사용자가 직접 실행할 스크립트 경로를 보여줍니다.
    const error = await shell.openPath(scriptPath);
    appendDebugLog(`login terminal ShellExecute: ${error || "ok"}`);

    if (error) {
      showCodexAccountBubble(
        `Codex 로그인 터미널을 열지 못했어요.\n직접 이 파일을 실행해 주세요:\n${scriptPath}\n\n${error}`
      );
      return false;
    }

    showCodexAccountBubble(
      "Codex 로그인 터미널을 열었어요.\n로그인이 끝나면 '전환' 목록에 실제 계정명으로 나타납니다."
    );
    return true;
  } catch (error) {
    showCodexAccountBubble(
      `Codex 로그인 터미널을 열지 못했어요.\n${error.message || String(error)}`
    );
    return false;
  } finally {
    setTimeout(() => {
      codexLoginLaunchInProgress = false;
    }, 3000);
  }
}

// PowerShell helper를 숨김 창으로 실행합니다.
// Codex Desktop 재시작처럼 Windows 프로세스 목록을 다뤄야 하는 작업만 이 helper를 사용합니다.
function runHiddenPowerShell(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(),
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: error.message || String(error),
      });
    });

    child.once("close", (code) => {
      finish({
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function resolveCommand(command, candidates = []) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const result = spawnSync(lookup, [command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    return selectCommandPath(result.stdout, process.platform);
  } catch {
    return null;
  }
}

// GUI로 실행된 macOS 앱은 셸 PATH를 물려받지 않으므로 자주 쓰이는 설치 경로를 후보로 함께 넘깁니다.
function claudeCommandCandidates() {
  if (process.platform === "win32") {
    return [path.join(os.homedir(), ".local", "bin", "claude.exe")];
  }
  return [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function codexCommandCandidates() {
  if (process.platform === "win32") return [];
  return [
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
}

function resolveAntigravityExecutable() {
  if (process.platform === "darwin") {
    const appPath = "/Applications/Antigravity.app";
    return fs.existsSync(appPath) ? appPath : null;
  }
  return resolveCommand("Antigravity.exe", [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "antigravity", "Antigravity.exe"),
    path.join(process.env.ProgramFiles || "", "Antigravity", "Antigravity.exe"),
  ]);
}

// osascript로 앱 종료를 요청합니다. 앱이 떠 있지 않아도 실패로 보지 않습니다.
function quitMacApp(appName, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", `if application "${appName}" is running then quit app "${appName}"`],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
      }
    );
  });
}

async function restartAntigravityApp() {
  if (process.platform === "darwin") {
    const executable = resolveAntigravityExecutable();
    if (!executable) throw new Error("AGY 실행 파일을 찾지 못했습니다.");
    await quitMacApp("Antigravity");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const child = spawn("open", ["-a", executable], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  }

  const executable = resolveAntigravityExecutable();
  if (!executable) throw new Error("AGY 실행 파일을 찾지 못했습니다.");
  const executablePath = quotePowerShellString(path.resolve(executable));
  const directoryPath = quotePowerShellString(`${path.dirname(path.resolve(executable))}${path.sep}`);
  const command = `
$ErrorActionPreference = 'Stop'
$executable = ${executablePath}
$directory = ${directoryPath}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and ($_.ExecutablePath -eq $executable -or $_.ExecutablePath.StartsWith($directory)))
})
foreach ($process in $processes) {
  try { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Milliseconds 700
Write-Output "Stopped $($processes.Count) AGY process(es)."
`.trim();
  const result = await runHiddenPowerShell(command, 15000);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "AGY를 종료하지 못했습니다.");
  }
  const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return true;
}

function writeClaudeLoginScript() {
  const claudeCommand = resolveCommand("claude", claudeCommandCandidates());
  if (!claudeCommand) throw new Error("Claude 명령을 찾지 못했습니다.");

  if (process.platform === "darwin") {
    return writeMacLoginScript("codepet-claude-login.command", [
      'echo "CodePet Claude Login"',
      `${quoteShellArgument(claudeCommand)} auth login`,
    ]);
  }

  const scriptPath = path.join(app.getPath("userData"), "codepet-claude-login.cmd");
  fs.writeFileSync(
    scriptPath,
    [
      "@echo off",
      "title CodePet Claude Login",
      `call ${quoteCmdArgument(claudeCommand)} auth login`,
      "echo.",
      "pause",
      "",
    ].join("\r\n"),
    "utf8"
  );
  return scriptPath;
}

function getClaudeAuthStatus() {
  return new Promise((resolve, reject) => {
    const command = resolveCommand("claude", claudeCommandCandidates());
    if (!command) {
      reject(new Error("Claude 명령을 찾지 못했습니다."));
      return;
    }
    execFile(
      command,
      ["auth", "status", "--json"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        shell: commandNeedsShell(command, process.platform),
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Claude 로그인 상태를 확인하지 못했습니다."));
          return;
        }
        try {
          resolve(normalizeClaudeAccountMetadata(JSON.parse(stdout)));
        } catch {
          reject(new Error("Claude 로그인 상태 형식이 올바르지 않습니다."));
        }
      }
    );
  });
}

// Windows의 Codex Desktop App만 선별적으로 종료합니다.
// 일반 터미널 Codex CLI 세션까지 죽이지 않기 위해 WindowsApps 패키지 경로를 가진 프로세스만 대상으로 삼습니다.
async function stopCodexDesktopApp() {
  if (!CODEX_DESKTOP_RESTART_CONFIG.enabledAfterAccountSwitch) {
    return { ok: true, skipped: true, stdout: "Restart disabled by config." };
  }

  if (process.platform === "darwin") {
    const result = await quitMacApp("Codex", CODEX_DESKTOP_RESTART_CONFIG.timeoutMs);
    // osascript 실패(자동화 권한 거부/타임아웃)를 성공으로 보고하면, 실제로는 멈추지 않은 앱을
    // 멈춘 것으로 오인해 사용자에게 "전환됨"이라고 잘못 알립니다. 실제 결과를 그대로 전달합니다.
    if (!result.ok) {
      throw new Error(result.stderr || "Codex Desktop 종료에 실패했습니다. (자동화 권한을 확인하세요)");
    }
    return { ok: true, skipped: false, stdout: result.stderr || "Codex Desktop quit requested." };
  }

  if (process.platform !== "win32") {
    return { ok: true, skipped: true, stdout: "No Windows process stop needed." };
  }

  const marker = quotePowerShellString(CODEX_DESKTOP_RESTART_CONFIG.windowsProcessPathMarker);
  const launchDelayMs = CODEX_DESKTOP_RESTART_CONFIG.launchDelayMs;
  const command = `
$ErrorActionPreference = 'Stop'
$marker = ${marker}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.Contains($marker)) -or
  ($_.CommandLine -and $_.CommandLine.Contains($marker))
})
$ids = @($processes | Select-Object -ExpandProperty ProcessId -Unique)
foreach ($id in $ids) {
  try {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  } catch {}
}
Start-Sleep -Milliseconds ${launchDelayMs}
Write-Output "Stopped $($ids.Count) Codex Desktop process(es)."
`.trim();

  const result = await runHiddenPowerShell(command, CODEX_DESKTOP_RESTART_CONFIG.timeoutMs);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Codex Desktop stop failed.");
  }

  return result;
}

// 현재 ~/.codex/auth.json 기준으로 Codex Desktop App을 실행합니다.
function launchCodexDesktopApp() {
  if (process.platform === "darwin") {
    const codexCommand = resolveCommand("codex", codexCommandCandidates());
    const child = codexCommand
      ? spawn(codexCommand, ["app"], { detached: true, stdio: "ignore" })
      : spawn("open", ["-a", "Codex"], { detached: true, stdio: "ignore" });
    child.unref();
    return Promise.resolve({ ok: true, skipped: false, stdout: "Launched Codex Desktop." });
  }

  if (process.platform !== "win32") {
    const child = spawn("codex", ["app"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return Promise.resolve({ ok: true, skipped: false, stdout: "Launched codex app." });
  }

  return runHiddenPowerShell(
    buildWindowsCodexLaunchScript(),
    CODEX_DESKTOP_RESTART_CONFIG.timeoutMs
  ).then((result) => {
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Codex Desktop launch failed.");
    }
    return result;
  });
}

async function restartCodexDesktopApp() {
  const stopResult = await stopCodexDesktopApp();
  const launchResult = await launchCodexDesktopApp();
  return {
    ok: true,
    skipped: stopResult.skipped && launchResult.skipped,
    stdout: `${stopResult.stdout}\n${launchResult.stdout}`.trim(),
  };
}

async function restartCurrentCodexDesktopApp() {
  try {
    showCodexAccountBubble("Codex Desktop App을 다시 실행하는 중입니다.");
    await restartCodexDesktopApp();
    showCodexAccountBubble("Codex Desktop App 재실행을 요청했습니다.");
  } catch (error) {
    showCodexAccountBubble(
      `Codex Desktop App 재실행에 실패했습니다.\n${error.message || String(error)}`
    );
  }
}

// 사용량 말풍선 하단에 붙일 계정 관리 버튼입니다.
function buildCodexAccountActions() {
  const profiles = codexAccountSwitcher.listProfiles();
  const readyCount = profiles.filter((profile) => profile.hasAuth).length;

  return [
    {
      id: BUBBLE_ACTIONS.LOGIN_CODEX_ACCOUNT,
      label: "계정 추가",
    },
    {
      id: BUBBLE_ACTIONS.SAVE_CODEX_ACCOUNT,
      label: "현재 저장",
    },
    {
      id: BUBBLE_ACTIONS.SWITCH_CODEX_ACCOUNT,
      label: readyCount > 0 ? `전환 (${readyCount})` : "전환",
    },
  ];
}

// 계정 프로필 실행/전환 결과를 펫 말풍선으로 알려줍니다.
function showCodexAccountBubble(text) {
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = null;

  showPetWindowFromTray();
  showBubble({
    kind: "activity",
    title: "Codex 계정",
    busy: false,
    text,
  });

  bubbleHideTimer = setTimeout(() => {
    restoreActiveActivityBubble();
  }, BUBBLE_CONFIG.doneAutoHideMs);
}

// 현재 live ~/.codex/auth.json을 CodePet 저장소에 저장합니다.
function saveCurrentCodexAccount() {
  try {
    const profile = codexAccountSwitcher.saveCurrentAccount();
    invalidateProxyAccountsCache();
    refreshTrayMenu();
    showCodexAccountBubble(
      `"${profile.label}" 계정을 저장했습니다.\n전환 목록에는 로그인된 계정만 표시됩니다.`
    );
  } catch (error) {
    showCodexAccountBubble(
      `현재 Codex 계정을 저장하지 못했어요.\n${error.message || String(error)}`
    );
  }
}

// 저장된 계정 목록을 네이티브 메뉴로 띄웁니다.
// auth.json이 없는 pending/빈 프로필은 codex-account-switcher.js에서 제거되어 여기에 나오지 않습니다.
function showCodexAccountSwitchMenu() {
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = null;

  const profiles = codexAccountSwitcher.listProfiles();

  if (profiles.length === 0) {
    showCodexAccountBubble(
      "저장된 Codex 계정이 없습니다.\n먼저 '현재 저장'을 누르거나 '계정 추가'로 새 계정에 로그인하세요."
    );
    return;
  }

  const template = profiles.map((profile) => ({
    label: formatCodexAccountLabel(profile),
    type: "radio",
    checked: profile.active,
    enabled: profile.hasAuth,
    click: () => switchCodexAccount(profile.key),
  }));

  Menu.buildFromTemplate(template).popup({
    window: bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()
      ? bubbleWindow
      : petWindow,
  });
}

// 실제 계정 전환입니다.
// Codex Desktop을 먼저 멈추고, 저장된 auth를 ~/.codex/auth.json으로 교체한 뒤 다시 실행합니다.
// 이미 떠 있는 일반 Codex CLI 터미널 세션은 사용자가 새로 시작해야 합니다.
async function switchCodexAccount(profileKey) {
  const proxyModeRequested = isCodexProxyModeEnabled();
  if (proxyModeRequested && codexProxyStartupPromise) {
    await codexProxyStartupPromise;
  }

  if (proxyModeRequested && !codexProxyActive) {
    const reason = codexProxyLastError?.message || "프록시가 아직 활성화되지 않았습니다.";
    showCodexAccountBubble(
      `Codex 계정을 전환하지 않았습니다.\n재시작 없는 프록시 모드 시작에 실패했습니다.\n${reason}`
    );
    return false;
  }

  // 프록시가 실제로 config에 주입되어 트래픽이 프록시를 탈 때만 무재시작 경로를 씁니다.
  // (start만 되고 주입이 실패한 상태에서 이 경로로 빠지면 전환이 조용히 무시됩니다.)
  if (codexProxyActive) {
    try {
      const result = codexAccountSwitcher.switchToProfile(profileKey);
      invalidateProxyAccountsCache();
      refreshTrayMenu();
      showCodexAccountBubble(
        `"${result.profile.label}" 계정으로 전환했습니다.\n프록시 모드: 재시작 없이 다음 요청부터 바로 적용됩니다.`
      );
      return true;
    } catch (error) {
      showCodexAccountBubble(`Codex auth 전환에 실패했습니다.\n${error.message || String(error)}`);
      return false;
    }
  }

  try {
    showCodexAccountBubble(
      "Codex Desktop App을 멈추고 계정 전환을 준비하는 중입니다."
    );

    let stopError = null;
    try {
      await stopCodexDesktopApp();
    } catch (error) {
      stopError = error;
      appendDebugLog(`Codex Desktop stop failed before switch: ${error.message || String(error)}`);
    }

    try {
      const result = codexAccountSwitcher.switchToProfile(profileKey);
      refreshTrayMenu();

      let launchText = "Codex Desktop App 재실행을 요청했습니다.";
      try {
        const restartResult = await launchCodexDesktopApp();
        launchText = restartResult.skipped
          ? "재시작 설정이 꺼져 있어 auth만 교체했습니다."
          : "Codex Desktop App 재실행을 요청했습니다.";
      } catch (launchError) {
        launchText = `auth 교체는 완료됐지만 Codex Desktop 재실행은 실패했습니다.\n${launchError.message || String(launchError)}`;
        appendDebugLog(`Codex Desktop launch failed after switch: ${launchError.message || String(launchError)}`);
      }

      const stopText = stopError
        ? `Codex Desktop 종료 확인은 실패했지만 auth 교체는 진행했습니다.\n${stopError.message || String(stopError)}\n`
        : "";

      showCodexAccountBubble(
        `"${result.profile.label}" 계정으로 전환했습니다.\n${stopText}${launchText}\n열려 있던 Codex CLI 터미널은 새로 시작해야 적용됩니다.`
      );
      return true;
    } catch (switchError) {
      showCodexAccountBubble(
        `Codex auth 전환에 실패했습니다.\n${switchError.message || String(switchError)}`
      );
      return false;
    }
  } catch (error) {
    showCodexAccountBubble(
      `Codex 계정을 전환하지 못했어요.\n${error.message || String(error)}`
    );
    return false;
  }
}

// 트레이/우클릭 메뉴에서도 같은 기능을 쓸 수 있게 작은 서브메뉴를 만듭니다.
function buildCodexAccountSubmenu() {
  const profiles = codexAccountSwitcher.listProfiles();
  return buildAccountSubmenu({
    profiles,
    formatLabel: formatCodexAccountLabel,
    onSwitch: (key) => switchCodexAccount(key),
    onLogin: () => openCodexLoginTerminal(),
  });
}

// 시스템 트레이 메뉴는 창이 투명해져서 펫 우클릭 메뉴를 못 여는 상황에서도 접근할 수 있는 안전장치입니다.
function buildTrayMenu() {
  const isPetVisible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());

  return Menu.buildFromTemplate([
    {
      label: "설정…",
      click: openSettingsWindow,
    },
    { type: "separator" },
    {
      label: "CodePet 보이기",
      enabled: !isPetVisible,
      click: showPetWindowFromTray,
    },
    {
      label: "CodePet 숨기기",
      enabled: isPetVisible,
      click: hidePetWindowToTray,
    },
    { type: "separator" },
    { label: "계정", submenu: buildProviderAccountSubmenu() },
    {
      label: "Codex 재시작 없는 전환 (프록시)",
      type: "checkbox",
      checked: isCodexProxyModeEnabled(),
      click: () => setCodexProxyMode(!isCodexProxyModeEnabled()),
    },
    {
      label: "펫 바꾸기",
      submenu: buildPetSelectionSubmenu(),
    },
    { type: "separator" },
    {
      label: runtime.manualPaused ? "이동 다시 시작" : "이동 일시 정지",
      click: toggleManualPause,
    },
    {
      label: "마우스 따라가기",
      type: "checkbox",
      checked: runtime.followMouse,
      click: toggleFollowMouse,
    },
    { type: "separator" },
    {
      label: "완전 종료",
      click: quitApp,
    },
  ]);
}

// 트레이 메뉴는 현재 표시 상태, 일시정지 상태, 펫 선택 상태를 반영해야 하므로 상태가 바뀔 때마다 다시 만듭니다.
function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip("CodePet");
  tray.setContextMenu(buildTrayMenu());
}

// 시스템 트레이를 생성합니다.
// 아이콘을 더 바꾸고 싶으면 build/icon.ico를 교체한 뒤 다시 빌드하면 됩니다.
function createTray() {
  if (tray) return;

  tray = new Tray(createTrayIcon());
  tray.on("click", showPetWindowFromTray);
  tray.on("double-click", showPetWindowFromTray);
  refreshTrayMenu();
}

// 창을 숨기면 앱은 트레이에 남습니다.
// 사용자가 창을 찾지 못하는 상황에서도 트레이의 "CodePet 보이기" 또는 "완전 종료"를 쓸 수 있습니다.
function hidePetWindowToTray() {
  petHiddenToTray = true;
  stopMovementLoop();
  hideBubble();

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.hide();
  }

  refreshTrayMenu();
}

// 트레이에서 다시 보이기를 누르면 기존 창을 다시 보여주고, 창이 파괴된 상태라면 새로 만듭니다.
function showPetWindowFromTray() {
  if (!petWindow || petWindow.isDestroyed()) {
    petHiddenToTray = false;
    createWindow();
    refreshTrayMenu();
    return;
  }

  petHiddenToTray = false;
  petWindow.showInactive();
  petWindow.moveTop();
  startMovementLoop({ resetPosition: false });
  resendCurrentPetState();
  refreshPetSprite({ force: true });
  refreshTrayMenu();
}

// 실제 앱 종료는 이 함수만 통하게 합니다.
// 일반 close는 트레이로 숨기고, "완전 종료"만 프로세스를 끝내도록 분리합니다.
function quitApp() {
  isQuitting = true;
  stopMovementLoop();
  clearTimeout(bubbleHideTimer);
  codexWatcher.stop();

  if (tray) {
    tray.destroy();
    tray = null;
  }

  app.quit();
}

// 마우스 따라가기 토글은 펫 메뉴와 트레이 메뉴가 같은 상태를 공유합니다.
function toggleFollowMouse() {
  runtime.followMouse = !runtime.followMouse;
  persistMovementPreferences();

  if (runtime.followMouse) {
    clearTimeout(phaseTimer);
    runtime.movementPhase = "looking";
    syncMovementAnimation();
  } else if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
    beginIdlePhase();
  }

  refreshTrayMenu();
}

function buildManualMotionSubmenu() {
  const motions = [
    { label: "기본 대기", click: () => playManualReaction("idle") },
    { label: "인사", click: () => playManualReaction("waving") },
    { label: "점프", click: () => playManualReaction("jumping") },
    { label: "축 처짐", click: () => playManualReaction("failed") },
    { label: "대기", click: () => playManualReaction("waiting") },
    { label: "검토 중", click: () => playManualReaction("review") },
    { label: "작업 중", click: () => playManualReaction("running") },
    { label: "오른쪽 이동", click: () => playManualReaction("runningRight") },
    { label: "왼쪽 이동", click: () => playManualReaction("runningLeft") },
  ];

  if (detectPetSpriteRows() === V2_SPRITE_ROWS) {
    motions.push(
      { type: "separator" },
      { label: "왼쪽 둘러보기", click: () => playManualReaction("lookRow10") },
      { label: "오른쪽 둘러보기", click: () => playManualReaction("lookRow9") }
    );
  }

  return motions;
}

// renderer가 우클릭을 감지하면 main process에서 네이티브 메뉴를 띄웁니다.
function showContextMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;

  const template = [
    { label: "설정…", click: openSettingsWindow },
    { type: "separator" },
    { label: "계정", submenu: buildProviderAccountSubmenu() },
    {
      label: "펫 바꾸기",
      submenu: buildPetSelectionSubmenu(),
    },
    { type: "separator" },
    {
      label: runtime.manualPaused ? "다시 시작" : "일시 정지",
      click: toggleManualPause,
    },
    { type: "separator" },
    {
      label: "마우스 따라가기",
      type: "checkbox",
      checked: runtime.followMouse,
      click: toggleFollowMouse,
    },
    { type: "separator" },
    {
      label: "모션 실행",
      submenu: buildManualMotionSubmenu(),
    },
    { type: "separator" },
    {
      label: "Codex 재시작 없는 전환 (프록시)",
      type: "checkbox",
      checked: isCodexProxyModeEnabled(),
      click: () => setCodexProxyMode(!isCodexProxyModeEnabled()),
    },
    {
      label: "로그인 시 자동 실행",
      type: "checkbox",
      checked: isAutoLaunchEnabled(),
      click: toggleAutoLaunch,
    },
    { type: "separator" },
    {
      label: "숨기기",
      click: hidePetWindowToTray,
    },
  ];

  Menu.buildFromTemplate(template).popup({ window: petWindow });
}

// 드래그 시작 시 자동 이동을 멈추고 기준 좌표를 저장합니다.
function handleDragStart(screenPoint) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!isValidScreenPoint(screenPoint)) {
    console.warn("[desktop-pet] Invalid drag start ignored.", screenPoint);
    return;
  }

  const bounds = petWindow.getBounds();
  const initialDragState = runtime.direction > 0 ? "runningRight" : "runningLeft";
  dragSession = {
    startScreenX: screenPoint.screenX,
    startScreenY: screenPoint.screenY,
    lastScreenX: screenPoint.screenX,
    lastScreenY: screenPoint.screenY,
    startWindowX: bounds.x,
    startWindowY: bounds.y,
    stateName: initialDragState,
  };

  pauseAutoMovement("drag", initialDragState);
}

// renderer에서 넘어온 현재 마우스 screen 좌표를 기준으로 창 위치를 갱신합니다.
function handleDragMove(screenPoint) {
  if (!dragSession) return;
  if (!isValidScreenPoint(screenPoint)) {
    console.warn("[desktop-pet] Invalid drag move ignored.", screenPoint);
    return;
  }

  const deltaX = screenPoint.screenX - dragSession.startScreenX;
  const deltaY = screenPoint.screenY - dragSession.startScreenY;
  const stepX = screenPoint.screenX - dragSession.lastScreenX;

  // 드래그 중에도 실제 마우스 이동 방향에 맞춰 달리는 row를 재생합니다.
  // 아주 작은 흔들림은 무시해서 좌우 애니메이션이 빠르게 깜빡이지 않게 합니다.
  if (Math.abs(stepX) >= MOVEMENT_CONFIG.dragDirectionThresholdPx) {
    const nextDirection = stepX > 0 ? 1 : -1;
    const nextDragState = nextDirection > 0 ? "runningRight" : "runningLeft";

    runtime.direction = nextDirection;

    if (dragSession.stateName !== nextDragState) {
      dragSession.stateName = nextDragState;
      sendPetState(nextDragState);
    }
  }

  dragSession.lastScreenX = screenPoint.screenX;
  dragSession.lastScreenY = screenPoint.screenY;
  moveWindowTo(dragSession.startWindowX + deltaX, dragSession.startWindowY + deltaY);
}

// 드래그가 끝나면 잠깐 idle을 보여준 뒤 자동 이동을 재개합니다.
function handleDragEnd() {
  if (!dragSession) return;

  dragSession = null;
  persistWindowGeometry();
  resumeAutoMovement("drag", MOVEMENT_CONFIG.idleAfterDragMs);
}

// renderer가 쓸 수 있는 설정을 내려줍니다.
// assetExists가 false면 renderer가 화면에 명확한 오류 메시지를 표시합니다.
function getRendererConfig() {
  const pet = resolveSelectedPet();
  const spriteConfig = createSpritePayload(pet);

  if (!pet) {
    console.error(
      `[desktop-pet] No pet sprite found. Checked: pet/, ${CODEX_PETS_DIR}, ${SPRITE_ASSET.filePath}`
    );
  }

  return {
    ...spriteConfig,
    windowWidth: runtime.width,
    windowHeight: runtime.height,
  };
}

// 말풍선을 펫 머리 위 중앙에 배치합니다. 위쪽 공간이 부족하면 펫 아래에 표시합니다.
function refreshPetSprite({ force = false } = {}) {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return;

  const now = Date.now();
  if (!force && now - lastPetVisualRefreshMs < 2000) return;

  lastPetVisualRefreshMs = now;
  try {
    petWindow.webContents.send(IPC_CHANNELS.SET_SPRITE, createSpritePayload(resolveSelectedPet()));
  } catch (error) {
    console.warn("[desktop-pet] Failed to refresh pet sprite.", error.message);
  }
}

function recoverPetWindowVisuals({ forceSprite = false } = {}) {
  if (isQuitting || petHiddenToTray || !petWindow || petWindow.isDestroyed()) return false;

  try {
    const wasVisible = petWindow.isVisible();
    if (!wasVisible) {
      petWindow.showInactive();
      startMovementLoop({ resetPosition: false });
    }

    petWindow.moveTop();
    resendCurrentPetState();
    refreshPetSprite({ force: forceSprite || !wasVisible });
    refreshTrayMenu();
    return true;
  } catch (error) {
    console.warn("[desktop-pet] Failed to recover pet window visuals.", error.message);
    return false;
  }
}

function ensurePetWindowVisibleForBubble() {
  if (petHiddenToTray) return false;
  return recoverPetWindowVisuals();
}

function positionBubble() {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;

  const area = getCurrentWorkArea();
  let x = Math.round(runtime.x + runtime.width / 2 - BUBBLE_CONFIG.width / 2);
  x = Math.min(Math.max(x, area.x), area.x + area.width - BUBBLE_CONFIG.width);

  let y = Math.round(runtime.y - bubbleHeight - BUBBLE_CONFIG.gapPx);
  if (y < area.y) {
    y = Math.round(runtime.y + runtime.height + BUBBLE_CONFIG.gapPx);
  }

  bubbleWindow.setBounds({ x, y, width: BUBBLE_CONFIG.width, height: bubbleHeight });
}

// 준비된 말풍선 renderer로 보류 중인 데이터를 보냅니다.
// Codex 대화 말풍선은 앱 시작 직후에도 바로 들어올 수 있으므로, load 전 UPDATE 유실을 막아야 합니다.
function clearBubbleLoadWatchdog() {
  clearTimeout(bubbleLoadWatchdogTimer);
  bubbleLoadWatchdogTimer = null;
}

function ensureBubbleWindow() {
  if (isQuitting || !petWindow || petWindow.isDestroyed()) return null;
  if (bubbleWindow && !bubbleWindow.isDestroyed()) return bubbleWindow;

  createBubbleWindow();
  return bubbleWindow;
}

function scheduleBubbleLoadWatchdog(reason) {
  clearBubbleLoadWatchdog();
  bubbleLoadWatchdogTimer = setTimeout(() => {
    if (!bubblePendingShow) return;

    if (bubbleReady && bubbleWindow && !bubbleWindow.isDestroyed()) {
      flushPendingBubbleData();
      return;
    }

    console.warn("[desktop-pet] Bubble window did not become ready. Recreating.", reason);
    recreateBubbleWindow(reason);
  }, BUBBLE_CONFIG.loadTimeoutMs);
}

function recreateBubbleWindow(reason) {
  clearTimeout(bubbleRecreateTimer);
  bubbleRecreateTimer = setTimeout(() => {
    if (isQuitting || !bubblePendingShow || !petWindow || petWindow.isDestroyed()) return;

    const oldWindow = bubbleWindow;
    bubbleWindow = null;
    bubbleReady = false;
    clearTimeout(bubbleRenderFallbackTimer);
    bubbleRenderFallbackTimer = null;

    if (oldWindow && !oldWindow.isDestroyed()) {
      oldWindow.removeAllListeners("closed");
      oldWindow.destroy();
    }

    console.warn("[desktop-pet] Recreated bubble window.", reason);
    createBubbleWindow();
    scheduleBubbleLoadWatchdog(`recreate:${reason}`);
  }, BUBBLE_CONFIG.recreateDelayMs);
}

function flushPendingBubbleData() {
  const window = ensureBubbleWindow();
  if (!pendingBubbleData || !window || window.isDestroyed()) return;

  if (!bubbleReady || window.webContents.isDestroyed()) {
    scheduleBubbleLoadWatchdog("flush-not-ready");
    return;
  }

  try {
    window.webContents.send(BUBBLE_CHANNELS.UPDATE, pendingBubbleData);
    clearBubbleLoadWatchdog();
  } catch (error) {
    console.warn("[desktop-pet] Failed to send bubble update. Recreating.", error.message);
    recreateBubbleWindow("send-failed");
    return;
  }

  // 정상 경로는 bubble.js가 내용 높이를 보고하고 RESIZE 핸들러에서 showInactive()를 호출하는 것입니다.
  // 그래도 renderer IPC가 한 번 누락되면 계속 숨겨지는 문제가 생기므로 기본 높이로라도 표시하는 fallback을 둡니다.
  clearTimeout(bubbleRenderFallbackTimer);
  bubbleRenderFallbackTimer = setTimeout(() => {
    if (!bubblePendingShow || !bubbleWindow || bubbleWindow.isDestroyed()) return;

    try {
      positionBubble();
      if (!bubbleWindow.isVisible()) {
        bubbleWindow.showInactive();
      }
      bubbleWindow.moveTop();
    } catch (error) {
      console.warn("[desktop-pet] Failed to show bubble fallback. Recreating.", error.message);
      recreateBubbleWindow("fallback-show-failed");
    }
  }, BUBBLE_CONFIG.renderFallbackMs);
}

// 말풍선 내용을 갱신합니다. 창이 아직 로드 전이면 pendingBubbleData에 보관했다가 로드 후 보냅니다.
function showBubble(data) {
  if (!ensurePetWindowVisibleForBubble()) return;
  if (!ensureBubbleWindow()) return;

  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = null;
  pendingBubbleData = data;
  bubblePendingShow = true;
  flushPendingBubbleData();
}

function createVisibleActivityBubble(data) {
  const visible = applyActivityPrivacy(data, getActivityBubbleMode());
  return visible ? { ...visible, activityPrivacy: true } : null;
}

function buildActiveActivityBubble() {
  return activeActivityBubbles.toBubbleData();
}

function showWatcherActivityBubble(data, { active = false } = {}) {
  const activityData = {
    ...data,
    activityPrivacy: true,
    activitySource: active ? "active" : "temporary",
  };
  currentActivityBubbleData = activityData;

  // 더블클릭 사용량이나 계정 결과처럼 사용자가 직접 연 말풍선은 자동 작업 이벤트보다 우선합니다.
  // 최신 작업 상태는 위에서 저장해 두고, 수동 말풍선의 타이머가 끝난 뒤 복원합니다.
  if (pendingBubbleData && !pendingBubbleData.activityPrivacy) return false;

  const visibleData = createVisibleActivityBubble(activityData);
  if (visibleData) {
    showBubble(visibleData);
    return true;
  } else if (pendingBubbleData?.activityPrivacy) {
    hideBubble();
  }
  return false;
}

function showActiveActivityBubble({ force = false } = {}) {
  // 완료/사용량/계정 화면이 정해진 시간 동안 유지되는 동안에는 상태만 갱신하고 화면은 덮지 않습니다.
  if (!force && pendingBubbleData && pendingBubbleData.activitySource !== "active") return false;

  const data = buildActiveActivityBubble();
  if (!data) {
    return false;
  }
  return showWatcherActivityBubble(data, { active: true });
}

async function openCodexThread(threadId) {
  const normalizedThreadId = String(threadId || "").trim().toLowerCase();
  if (!CODEX_THREAD_ID_PATTERN.test(normalizedThreadId)) {
    console.warn("[desktop-pet] Invalid Codex thread id ignored.", threadId);
    return;
  }

  try {
    hideBubble();
    await shell.openExternal(`codex://threads/${normalizedThreadId}`);
  } catch (error) {
    showBubble({
      kind: "activity",
      title: "Codex 작업 열기 실패",
      busy: false,
      text: error.message || String(error),
    });
    bubbleHideTimer = setTimeout(hideBubble, BUBBLE_CONFIG.doneAutoHideMs);
  }
}

function restoreActiveActivityBubble() {
  if (!codexWatcher.working || activeActivityBubbles.size === 0) {
    hideBubble();
    return;
  }

  if (!showActiveActivityBubble({ force: true })) {
    hideBubble();
  }
}

function hideBubble() {
  clearTimeout(bubbleHideTimer);
  clearTimeout(bubbleRenderFallbackTimer);
  clearTimeout(bubbleRecreateTimer);
  clearBubbleLoadWatchdog();
  bubbleHideTimer = null;
  bubbleRenderFallbackTimer = null;
  bubbleRecreateTimer = null;
  pendingBubbleData = null;
  bubblePendingShow = false;

  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.hide();
  }
}

// agent_message는 마크다운 원문이므로 말풍선용 평문으로 정리합니다.
// 완벽한 파싱이 아니라 자주 쓰이는 기호(코드블록/백틱/볼드/헤더/링크)만 걷어냅니다.
function stripMarkdown(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " [코드] ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

// 말풍선에 넣기 좋게 메시지를 정리합니다. 너무 길면 잘라서 화면을 덮지 않게 합니다.
function truncateForBubble(text) {
  const trimmed = stripMarkdown(text).trim();
  if (trimmed.length <= BUBBLE_CONFIG.activityMaxChars) return trimmed;
  return `${trimmed.slice(0, BUBBLE_CONFIG.activityMaxChars)}…`;
}

// window_minutes를 "5시간 한도", "주간 한도" 같은 라벨로 바꿉니다.
// reset_at/resets_at(unix 초)을 "7/3 14:22 (3시간 12분 후 초기화)" 형태로 만듭니다.
function formatResetInfo(resetsAtSec) {
  if (!Number.isFinite(resetsAtSec)) return "초기화 정보 없음";

  const resetDate = new Date(resetsAtSec * 1000);
  const diffMinutes = Math.round((resetDate.getTime() - Date.now()) / 60000);

  let relative;
  if (diffMinutes <= 0) {
    relative = "곧 초기화";
  } else {
    const days = Math.floor(diffMinutes / 1440);
    const hours = Math.floor((diffMinutes % 1440) / 60);
    const minutes = diffMinutes % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}일`);
    if (hours > 0) parts.push(`${hours}시간`);
    if (minutes > 0 && days === 0) parts.push(`${minutes}분`);
    relative = `${parts.join(" ") || "1분 미만"} 후 초기화`;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${resetDate.getMonth() + 1}/${resetDate.getDate()} ${pad(resetDate.getHours())}:${pad(resetDate.getMinutes())}`;
  return `${clock} (${relative})`;
}

// Codex 버전에 따라 reset_at 또는 resets_at으로 들어오므로 화면 로직에서는 이 helper만 사용합니다.
function getResetAtSec(rateWindow) {
  const resetAt = Number(rateWindow?.resets_at ?? rateWindow?.reset_at);
  return Number.isFinite(resetAt) ? resetAt : null;
}

// 현재 live ~/.codex/auth.json의 토큰으로 직접 조회한 rate_limits를 말풍선 렌더링용 데이터로 바꿉니다.
function buildUsageBubbleData(usage) {
  const { rateLimits, recordedAt } = usage;
  const gauges = [];

  for (const window of rateLimits.windows || [rateLimits.primary, rateLimits.secondary]) {
    if (!window) continue;

    // 기록 이후 초기화 시각이 이미 지났으면 실제 사용량은 0으로 리셋된 상태입니다.
    // 오래된 used_percent를 그대로 보여주면 오해를 부르므로 초기화된 것으로 표시합니다.
    const resetAtSec = getResetAtSec(window);
    const resetPassed = Number.isFinite(resetAtSec) && resetAtSec * 1000 <= Date.now();

    gauges.push({
      label: rateWindowLabel(window),
      usedPercent: resetPassed ? 0 : Number(window.used_percent) || 0,
      resetText: resetPassed ? "이미 초기화됨" : formatResetInfo(resetAtSec),
    });
  }

  const footerParts = [];
  const account = usage.profile || codexAccountSwitcher.getCurrentAccountSummary();
  const planType = rateLimits.plan_type || account.planType;
  if (planType) footerParts.push(planType);
  if (recordedAt) {
    const recorded = new Date(recordedAt);
    if (!Number.isNaN(recorded.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      footerParts.push(`${pad(recorded.getHours())}:${pad(recorded.getMinutes())} 기준`);
    }
  }

  footerParts.push(
    account.hasAuth === false ? "계정 없음" : `${account.displayId || account.shortId || account.label}`
  );

  return {
    kind: "usage",
    title: "Codex 사용량",
    gauges,
    footer: footerParts.join(" · "),
    actions: [],
  };
}

// 더블클릭 시 호출됩니다. 로그/세션 캐시는 쓰지 않고 현재 live auth로 즉시 조회합니다.
async function showUsageBubble() {
  showBubble({
    kind: "activity",
    title: "Codex 사용량",
    busy: true,
    text: "현재 선택된 Codex 프로필의 사용량을 조회하는 중입니다.",
    actions: [],
  });

  try {
    const usage = await codexAccountSwitcher.fetchCurrentUsage();
    const data = buildUsageBubbleData(usage);
    showBubble(data);
    maybeWarnUsage(usage);
  } catch (error) {
    const current = codexAccountSwitcher.getCurrentAccountSummary();
    showBubble({
      kind: "activity",
      title: "Codex 사용량",
      busy: false,
      text: `현재 프로필: ${current.label}\n사용량을 직접 조회하지 못했습니다.\n${error.message || String(error)}`,
      actions: [],
    });
  }

  bubbleHideTimer = setTimeout(() => {
    restoreActiveActivityBubble();
  }, BUBBLE_CONFIG.usageAutoHideMs);
}

// Codex 세션 이벤트를 펫 애니메이션과 말풍선에 연결합니다.
function showCodexActivityBubble(data, context) {
  const threadId = context?.threadId;
  if (!activeActivityBubbles.upsert(threadId, data, context)) return false;
  return showActiveActivityBubble();
}

function removeCodexActivityBubble(threadId) {
  activeActivityBubbles.remove(threadId);
}

function didTaskFail(result) {
  return Boolean(
    result?.success === false ||
    result?.error ||
    ["aborted", "failed", "error"].includes(result?.reason)
  );
}

function registerCodexWatcher() {
  codexWatcher.on("working-changed", (isWorking, result, context) => {
    if (isWorking) {
      // 요청을 처음 받으면 검토 모션으로 시작하고, 뒤의 세부 이벤트에서 읽기/쓰기를 구분합니다.
      pauseAutoMovement("codex", "review");
      if (context?.activityChange === "removed") {
        removeCodexActivityBubble(context.threadId);
        // stale/dropped rollout은 task-finished가 오지 않으므로 남은 목록을 바로 다시 그립니다.
        if (activeActivityBubbles.size > 0) showActiveActivityBubble();
        return;
      }
      if (activeActivityBubbles.refresh(context?.threadId, context)) {
        showActiveActivityBubble();
        return;
      }
      showCodexActivityBubble({
        kind: "activity",
        title: "Codex 작업 중",
        busy: true,
        text: "Codex가 작업을 시작했어요.",
        statusText: "Codex가 작업 중입니다.",
      }, context);
      return;
    }

    removeCodexActivityBubble(context?.threadId);
    if (activeActivityBubbles.size === 0) {
      if (pendingBubbleData?.activitySource === "active") hideBubble();
    } else if (pendingBubbleData?.activitySource === "active") {
      showActiveActivityBubble({ force: true });
    }
    if (!isAnyProviderWorking()) resumeAutoMovement("codex", MOVEMENT_CONFIG.idleAfterReactionMs);
  });

  // 전역 working 상태와 별개로 세션별 완료를 받아야 동시에 실행한 작업도 정확한 채팅으로 열 수 있습니다.
  codexWatcher.on("task-finished", (result) => {
    removeCodexActivityBubble(result?.threadId);
    const failed = didTaskFail(result);
    playReaction(failed ? "failed" : "jumping");

    const primaryAction = result?.threadId
      ? {
          id: BUBBLE_ACTIONS.OPEN_CODEX_THREAD,
          payload: { threadId: result.threadId },
        }
      : null;

    const completionVisible = showWatcherActivityBubble({
      kind: "activity",
      title: formatActivityTitle(failed ? "작업 실패" : "작업 완료", result),
      busy: false,
      text: failed
        ? "작업 중 문제가 발생했어요."
        : truncateForBubble(result?.message) || "Codex 작업이 끝났어요.",
      statusText: failed ? "Codex 작업 중 문제가 발생했습니다." : "Codex 작업이 완료됐습니다.",
      primaryAction,
      clickHint: primaryAction ? "클릭해서 Codex에서 열기" : null,
    });

    if (completionVisible) {
      bubbleHideTimer = setTimeout(() => {
        restoreActiveActivityBubble();
      }, BUBBLE_CONFIG.doneAutoHideMs);
    }
  });

  codexWatcher.on("user-message", (message, context) => {
    if (!codexWatcher.working) return;
    pauseAutoMovement("codex", "review");
    showCodexActivityBubble({
      kind: "activity",
      title: "요청 확인 중",
      busy: true,
      text: `요청: ${truncateForBubble(message)}`,
      statusText: "사용자 요청을 확인하고 있습니다.",
    }, context);
  });

  codexWatcher.on("agent-message", (message, context) => {
    if (!codexWatcher.working) return;
    pauseAutoMovement("codex", "running");
    showCodexActivityBubble({
      kind: "activity",
      title: "응답 작성 중",
      busy: true,
      text: truncateForBubble(message),
      statusText: "Codex가 응답을 작성하고 있습니다.",
    }, context);
  });

  // 파일 수정/웹 검색 같은 도구 사용을 실시간으로 보여줍니다.
  codexWatcher.on("tool-activity", (activity) => {
    if (!codexWatcher.working) return;

    let title;
    let text;
    let statusText;
    let petState = "review";
    if (activity.kind === "patch") {
      const prefix = activity.success ? "파일 수정" : "파일 수정 실패";
      title = activity.success ? "파일 수정 중" : "파일 수정 실패";
      text = `${prefix}: ${truncateForBubble(activity.files.join(", "))}`;
      statusText = activity.success
        ? "Codex가 파일을 수정하고 있습니다."
        : "Codex가 파일을 수정하지 못했습니다.";
      petState = activity.success ? "running" : "failed";
    } else if (activity.kind === "search") {
      title = "자료 확인 중";
      text = activity.query ? `웹 검색: ${truncateForBubble(activity.query)}` : "웹 검색 중";
      statusText = "Codex가 자료를 확인하고 있습니다.";
    } else if (activity.kind === "read") {
      title = "파일 확인 중";
      text = activity.command ? `읽기: ${truncateForBubble(activity.command)}` : "파일을 읽고 있어요.";
      statusText = "Codex가 파일을 확인하고 있습니다.";
    } else if (activity.kind === "image") {
      title = "이미지 생성 중";
      text = "이미지를 생성하고 있어요.";
      statusText = "Codex가 이미지를 생성하고 있습니다.";
      petState = "running";
    } else if (activity.kind === "test") {
      title = "테스트 중";
      text = activity.command ? `테스트 실행: ${truncateForBubble(activity.command)}` : "테스트 실행 중";
      statusText = "Codex가 테스트를 실행하고 있습니다.";
      petState = "running";
    } else if (activity.kind === "build") {
      title = "빌드 중";
      text = activity.command ? `빌드 실행: ${truncateForBubble(activity.command)}` : "빌드 실행 중";
      statusText = "Codex가 빌드를 실행하고 있습니다.";
      petState = "running";
    } else if (activity.kind === "command") {
      title = "명령 실행 중";
      text = activity.command ? `명령 실행: ${truncateForBubble(activity.command)}` : "명령 실행 중";
      statusText = "Codex가 명령을 실행하고 있습니다.";
      petState = "running";
    } else {
      return;
    }

    if (activity.success === false) petState = "failed";
    pauseAutoMovement("codex", petState);
    if (petState === "failed") playReaction("failed");
    showCodexActivityBubble({ kind: "activity", title, busy: true, text, statusText }, activity);
  });

  codexWatcher.on("waiting", (waiting) => {
    if (!codexWatcher.working) return;

    const needsApproval = waiting?.kind === "approval";
    const primaryAction = waiting?.threadId
      ? {
          id: BUBBLE_ACTIONS.OPEN_CODEX_THREAD,
          payload: { threadId: waiting.threadId },
        }
      : null;
    pauseAutoMovement("codex", "waiting");
    showCodexActivityBubble({
      kind: "activity",
      title: needsApproval ? "승인 대기" : "입력 대기",
      busy: true,
      text: needsApproval
        ? "Codex가 작업 실행 승인을 기다리고 있어요."
        : "Codex가 사용자 입력을 기다리고 있어요.",
      statusText: needsApproval
        ? "Codex가 승인을 기다리고 있습니다."
        : "Codex가 사용자 입력을 기다리고 있습니다.",
      primaryAction,
      clickHint: primaryAction ? "클릭해서 Codex에서 열기" : null,
    }, waiting);
  });

  // usage-updated 이벤트는 세션/로그에서 나온 값이라 계정 전환 직후 이전 계정 기록일 수 있습니다.
  // 한도 경고는 더블클릭 직접 조회 결과에만 연결합니다.
}

// 한도 사용률이 기준을 넘으면 초기화 주기당 한 번만 경고 말풍선을 띄웁니다.
function maybeWarnUsage(usage) {
  const rateLimits = usage?.rateLimits;
  if (!rateLimits) return;

  for (const [index, window] of (rateLimits.windows || [rateLimits.primary, rateLimits.secondary]).entries()) {
    if (!window) continue;
    if (!(Number(window.used_percent) >= USAGE_WARN_THRESHOLD_PERCENT)) continue;
    const resetAtSec = getResetAtSec(window);
    const key = `${window.source || "main"}:${window.window_key || index}`;
    if (usageWarnedResets[key] === resetAtSec) continue;

    usageWarnedResets[key] = resetAtSec;

    // 작업 중이 아닐 때만 쓰러지는 모션을 재생합니다.
    // 작업 중에 재생하면 반응이 끝난 뒤 review 모션으로 돌아오지 않기 때문입니다.
    if (!codexWatcher.working) {
      playReaction("failed");
    }

    showBubble({
      kind: "activity",
      title: "⚠️ Codex 한도 임박",
      busy: false,
      text: `${rateWindowLabel(window)}를 ${Math.round(window.used_percent)}% 사용했어요.\n${formatResetInfo(resetAtSec)}`,
    });
    bubbleHideTimer = setTimeout(() => {
      restoreActiveActivityBubble();
    }, BUBBLE_CONFIG.usageAutoHideMs);
    return; // 한 번에 하나만 경고합니다.
  }
}

async function switchProviderAccount(provider, profileKey) {
  if (provider === "codex") return switchCodexAccount(profileKey);
  const switcher = provider === "agy" ? antigravityAccountSwitcher : claudeAccountSwitcher;
  await switcher.switchToProfile(profileKey);
  clearUsageCache(provider);
  refreshTrayMenu();
  return true;
}

function deleteProviderAccount(provider, profileKey) {
  if (typeof profileKey !== "string" || !profileKey) {
    throw new Error("올바르지 않은 계정 키입니다.");
  }
  const switcher = provider === "codex"
    ? codexAccountSwitcher
    : provider === "agy"
      ? antigravityAccountSwitcher
      : provider === "claude"
        ? claudeAccountSwitcher
        : null;
  if (!switcher) throw new Error("지원하지 않는 계정 유형입니다.");
  const deleted = switcher.deleteProfile(profileKey);
  if (provider === "codex") invalidateProxyAccountsCache();
  clearUsageCache(provider);
  refreshTrayMenu();
  return deleted;
}

async function startProviderLogin(provider) {
  if (provider === "codex") return Boolean(await openCodexLoginTerminal());

  if (provider === "agy") {
    let meta = {};
    try {
      const credential = await antigravityAccountSwitcher.read();
      try {
        const identity = await fetchAntigravityIdentity({ credential, force: true });
        meta.email = identity.email;
      } catch {
        // 한도 API와 별개인 계정 조회가 막히면 기존 저장 메타데이터를 유지합니다.
      }
      try {
        const current = await fetchAntigravityUsage({ credential, force: true });
        meta = { email: current.email || meta.email, plan: current.plan };
      } catch {
        // 한도 조회가 막혀도 확인한 이메일과 현재 자격 증명은 저장할 수 있습니다.
      }
    } catch {
      // 처음 로그인하는 PC라면 저장할 현재 계정이 없습니다.
    }
    await antigravityAccountSwitcher.prepareLogin(meta);
    clearUsageCache("agy");
    refreshTrayMenu();
    return true;
  }

  if (provider === "claude") {
    try {
      const status = await getClaudeAuthStatus();
      claudeAccountSwitcher.snapshotCurrent({
        email: status.email,
        plan: status.subscriptionType,
      });
    } catch {
      // 처음 로그인하는 PC라면 저장할 현재 계정이 없습니다.
    }
    const scriptPath = writeClaudeLoginScript();
    const error = await shell.openPath(scriptPath);
    if (error) throw new Error(error);
    clearUsageCache("claude");
    return true;
  }

  throw new Error("지원하지 않는 계정 유형입니다.");
}

function showProviderAccountError(providerLabel, error) {
  playReaction("failed");
  showBubble({
    kind: "activity",
    title: `${providerLabel} 계정`,
    busy: false,
    text: error?.message || String(error),
  });
  bubbleHideTimer = setTimeout(restoreActiveActivityBubble, BUBBLE_CONFIG.doneAutoHideMs);
}

function buildSimpleProviderSubmenu(switcher, provider, providerLabel) {
  const profiles = switcher.listProfiles();
  return buildAccountSubmenu({
    profiles,
    formatLabel: (profile) => profile.active ? `${profile.label} (현재)` : profile.label,
    onSwitch: (key) => switchProviderAccount(provider, key)
      .catch((error) => showProviderAccountError(providerLabel, error)),
    onLogin: () => startProviderLogin(provider)
      .catch((error) => showProviderAccountError(providerLabel, error)),
  });
}

function buildProviderAccountSubmenu() {
  return [
    { label: "Codex", submenu: buildCodexAccountSubmenu() },
    { label: "AGY", submenu: buildSimpleProviderSubmenu(antigravityAccountSwitcher, "agy", "AGY") },
    { label: "Claude", submenu: buildSimpleProviderSubmenu(claudeAccountSwitcher, "claude", "Claude") },
  ];
}

function registerExternalWatcher(watcher, providerLabel) {
  const show = (title, text, context, state = "review") => {
    pauseAutoMovement("codex", state);
    showCodexActivityBubble({
      kind: "activity",
      title: `${providerLabel} ${title}`,
      busy: true,
      text: truncateForBubble(text),
      statusText: `${providerLabel} 작업 중입니다.`,
    }, context);
  };
  watcher.on("working-changed", (working, _result, context) => {
    if (context?.activityChange === "removed") {
      activeActivityBubbles.remove(context.threadId);
      if (!isAnyProviderWorking()) {
        resumeAutoMovement("codex", MOVEMENT_CONFIG.idleAfterReactionMs);
      }
      return;
    }
    if (working) show("작업 중", "작업을 시작했어요.", context);
  });
  watcher.on("user-message", (message, context) => show("요청 확인 중", `요청: ${message}`, context));
  watcher.on("agent-message", (message, context) => show("응답 작성 중", message, context, "running"));
  watcher.on("tool-activity", (activity, context) => {
    const title = activity.kind === "patch"
      ? "파일 수정 중"
      : ["read", "search"].includes(activity.kind)
        ? "자료 확인 중"
        : "명령 실행 중";
    const state = activity.success === false
      ? "failed"
      : ["read", "search"].includes(activity.kind)
        ? "review"
        : "running";
    show(title, activity.command || title, context, state);
    if (state === "failed") playReaction("failed");
  });
  watcher.on("task-finished", (result) => {
    activeActivityBubbles.remove(result.threadId);
    const failed = didTaskFail(result);
    playReaction(failed ? "failed" : "jumping");
    const visible = showWatcherActivityBubble({
      kind: "activity",
      title: `${providerLabel} ${failed ? "작업 실패" : "작업 완료"}`,
      busy: false,
      text: result.message || (failed
        ? `${providerLabel} 작업 중 문제가 발생했어요.`
        : `${providerLabel} 작업이 끝났어요.`),
      statusText: failed
        ? `${providerLabel} 작업 중 문제가 발생했습니다.`
        : `${providerLabel} 작업이 완료됐습니다.`,
    });
    if (visible) bubbleHideTimer = setTimeout(restoreActiveActivityBubble, BUBBLE_CONFIG.doneAutoHideMs);
  });
}

// 말풍선용 투명 창을 만듭니다. 포커스를 뺏지 않도록 focusable을 끕니다.
function createBubbleWindow() {
  bubbleReady = false;

  bubbleWindow = new BrowserWindow({
    ...WINDOW_CONFIG,
    width: BUBBLE_CONFIG.width,
    height: bubbleHeight,
    show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "bubble-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 숨겨진 동안에도 renderer가 스로틀링 없이 IPC를 처리하고 바로 다시 열릴 수 있게 합니다.
      backgroundThrottling: false,
    },
  });
  const createdWindow = bubbleWindow;

  createdWindow.setMenuBarVisibility(false);

  // 이 이벤트를 놓치면 Codex watcher 시작이나 대화 말풍선 표시가 막히므로 loadFile 전에 등록합니다.
  createdWindow.webContents.on("did-finish-load", () => {
    if (bubbleWindow !== createdWindow) return;
    bubbleReady = true;
    createdWindow.webContents.send("appearance:update", getAppearancePayload());
    clearBubbleLoadWatchdog();
    flushPendingBubbleData();
  });

  createdWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (bubbleWindow !== createdWindow) return;
    bubbleReady = false;
    console.warn("[desktop-pet] Bubble window failed to load.", errorCode, errorDescription);
    if (bubblePendingShow) recreateBubbleWindow("did-fail-load");
  });

  createdWindow.webContents.on("render-process-gone", (_event, details) => {
    if (bubbleWindow !== createdWindow) return;
    bubbleReady = false;
    console.warn("[desktop-pet] Bubble renderer exited.", details);
    if (bubblePendingShow) recreateBubbleWindow("render-process-gone");
  });

  createdWindow.webContents.on("unresponsive", () => {
    if (bubbleWindow !== createdWindow) return;
    bubbleReady = false;
    console.warn("[desktop-pet] Bubble renderer became unresponsive.");
    if (bubblePendingShow) recreateBubbleWindow("unresponsive");
  });

  createdWindow.loadFile(path.join(__dirname, "bubble.html")).catch((error) => {
    if (bubbleWindow !== createdWindow) return;
    bubbleReady = false;
    console.warn("[desktop-pet] Bubble window loadFile failed.", error.message);
    if (bubblePendingShow) recreateBubbleWindow("loadFile-failed");
  });

  createdWindow.on("closed", () => {
    if (bubbleWindow !== createdWindow) return;
    bubbleReady = false;
    bubbleWindow = null;

    if (isQuitting || !petWindow || petWindow.isDestroyed()) {
      pendingBubbleData = null;
      bubblePendingShow = false;
      clearBubbleLoadWatchdog();
      return;
    }

    if (bubblePendingShow) {
      recreateBubbleWindow("closed");
    }
  });

  if (bubblePendingShow) {
    scheduleBubbleLoadWatchdog("create");
  }
}

function createWindow() {
  let didShowPetWindow = false;
  initializeWindowGeometry();

  petWindow = new BrowserWindow({
    ...WINDOW_CONFIG,
    // Windows에서 resizable:false 창을 반복 이동할 때 발생하는 크기 drift를 피하기 위해
    // 네이티브 속성은 true로 유지하고, 실제 사용자 리사이즈는 will-resize에서 차단합니다.
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    minWidth: RESIZE_CONFIG.minWidth,
    minHeight: Math.round(RESIZE_CONFIG.minWidth * RESIZE_CONFIG.aspectRatio),
    maxWidth: RESIZE_CONFIG.maxWidth,
    maxHeight: Math.round(RESIZE_CONFIG.maxWidth * RESIZE_CONFIG.aspectRatio),
    width: runtime.width,
    height: runtime.height,
    x: Math.round(runtime.x),
    y: Math.round(runtime.y),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  const createdPetWindow = petWindow;

  petWindow.setMenuBarVisibility(false);
  // OS 테두리/스냅을 통한 수동 리사이즈만 막습니다. renderer의 커스텀 핸들이 호출하는
  // setContentSize는 programmatic resize라 이 이벤트의 차단 대상이 아닙니다.
  petWindow.on("will-resize", (event) => {
    event.preventDefault();
  });
  petWindow.loadFile(path.join(__dirname, "index.html"));

  if (OPEN_DEVTOOLS) {
    petWindow.webContents.openDevTools({ mode: "detach" });
  }

  // 투명 BrowserWindow는 렌더링 타이밍에 따라 ready-to-show가 기대보다 늦거나 애매하게 동작할 수 있습니다.
  // 그래서 ready-to-show와 did-finish-load fallback 둘 중 먼저 오는 쪽에서 한 번만 표시합니다.
  function showPetWindowOnce() {
    if (didShowPetWindow || !petWindow || petWindow.isDestroyed()) return;

    didShowPetWindow = true;
    petHiddenToTray = false;
    petWindow.showInactive();
    startMovementLoop({ resetPosition: false });

    // watcher가 창 로드 전에 상태를 복원했을 수 있으므로 현재 상태를 다시 보냅니다.
    resendCurrentPetState();
    refreshPetSprite({ force: true });
    refreshTrayMenu();
  }

  petWindow.once("ready-to-show", showPetWindowOnce);
  petWindow.webContents.once("did-finish-load", () => {
    setTimeout(showPetWindowOnce, 250);
  });

  // 사용자가 Alt+F4 등으로 창을 닫으면 프로세스를 끝내지 않고 트레이로 숨깁니다.
  // 실제 종료는 트레이/메뉴의 "완전 종료"만 사용합니다.
  petWindow.webContents.on("render-process-gone", (_event, details) => {
    if (petWindow !== createdPetWindow) return;
    console.warn("[desktop-pet] Pet renderer exited.", details);
    if (isQuitting || petHiddenToTray) return;

    const oldWindow = petWindow;
    petWindow = null;
    if (oldWindow && !oldWindow.isDestroyed()) {
      oldWindow.removeAllListeners("closed");
      oldWindow.destroy();
    }

    createWindow();
  });

  petWindow.webContents.on("unresponsive", () => {
    if (petWindow !== createdPetWindow) return;
    console.warn("[desktop-pet] Pet renderer became unresponsive.");
    recoverPetWindowVisuals({ forceSprite: true });
  });

  petWindow.on("close", (event) => {
    if (petWindow !== createdPetWindow) return;
    if (isQuitting) return;

    event.preventDefault();
    hidePetWindowToTray();
  });

  petWindow.on("hide", () => {
    if (petWindow !== createdPetWindow) return;
    refreshTrayMenu();
    if (isQuitting || petHiddenToTray) return;

    setTimeout(() => {
      if (!petHiddenToTray && petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) {
        recoverPetWindowVisuals({ forceSprite: true });
      }
    }, 250);
  });

  petWindow.on("show", () => {
    if (petWindow !== createdPetWindow) return;
    petHiddenToTray = false;
    refreshPetSprite({ force: true });
    refreshTrayMenu();
  });

  petWindow.on("closed", () => {
    if (petWindow !== createdPetWindow) return;
    petWindow = null;

    // 펫이 사라지면 말풍선만 남아있을 이유가 없으므로 같이 정리합니다.
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.close();
    }

    refreshTrayMenu();
  });
}

// preload가 노출한 API 호출을 main process에서 처리합니다.
function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.GET_APP_CONFIG, getRendererConfig);
  ipcMain.on(IPC_CHANNELS.REQUEST_REACTION, (_event, stateName) => {
    playManualReaction(stateName);
  });
  ipcMain.on(IPC_CHANNELS.SHOW_CONTEXT_MENU, showContextMenu);
  ipcMain.on(IPC_CHANNELS.DRAG_START, (_event, screenPoint) => {
    handleDragStart(screenPoint);
  });
  ipcMain.on(IPC_CHANNELS.DRAG_MOVE, (_event, screenPoint) => {
    handleDragMove(screenPoint);
  });
  ipcMain.on(IPC_CHANNELS.DRAG_END, handleDragEnd);
  ipcMain.on(IPC_CHANNELS.RESIZE_WINDOW, (_event, w, h) => {
    if (!petWindow || petWindow.isDestroyed()) return;

    const nextSize = normalizeWindowSize(Number(w), RESIZE_CONFIG);
    if (!nextSize) {
      console.warn("[desktop-pet] Invalid resize request ignored.", w, h);
      return;
    }

    runtime.width = nextSize.width;
    runtime.height = nextSize.height;
    petWindow.setContentSize(runtime.width, runtime.height, false);
    moveWindowTo(runtime.x, runtime.y);
  });
  ipcMain.on(IPC_CHANNELS.RESIZE_END, () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    persistWindowGeometry();
  });
  ipcMain.on(IPC_CHANNELS.SHOW_CODEX_STATUS, () => {
    void showUsageBubble();
  });

  // 말풍선 renderer가 내용 높이를 보고하면 창 크기와 위치를 맞춘 뒤 표시합니다.
  ipcMain.on(BUBBLE_CHANNELS.RESIZE, (_event, height) => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return;

    const nextHeight = Math.round(Number(height));
    if (Number.isFinite(nextHeight)) {
      bubbleHeight = Math.min(
        Math.max(nextHeight, BUBBLE_CONFIG.minHeight),
        BUBBLE_CONFIG.maxHeight
      );
    }

    positionBubble();
    clearTimeout(bubbleRenderFallbackTimer);
    bubbleRenderFallbackTimer = null;
    clearBubbleLoadWatchdog();

    if (bubblePendingShow && !bubbleWindow.isVisible()) {
      try {
        bubbleWindow.showInactive();
        bubbleWindow.moveTop();
      } catch (error) {
        console.warn("[desktop-pet] Failed to show resized bubble. Recreating.", error.message);
        recreateBubbleWindow("resize-show-failed");
      }
    } else if (bubblePendingShow) {
      bubbleWindow.moveTop();
    }
  });

  ipcMain.on(BUBBLE_CHANNELS.DISMISS, hideBubble);
  ipcMain.on(BUBBLE_CHANNELS.ACTION, (_event, actionId, payload) => {
    if (actionId === BUBBLE_ACTIONS.LOGIN_CODEX_ACCOUNT) {
      openCodexLoginTerminal();
      return;
    }

    if (actionId === BUBBLE_ACTIONS.SAVE_CODEX_ACCOUNT) {
      saveCurrentCodexAccount();
      return;
    }

    if (actionId === BUBBLE_ACTIONS.SWITCH_CODEX_ACCOUNT) {
      showCodexAccountSwitchMenu();
      return;
    }

    if (actionId === BUBBLE_ACTIONS.OPEN_CODEX_THREAD) {
      openCodexThread(payload?.threadId);
      return;
    }

    console.warn("[desktop-pet] Unknown bubble action ignored.", actionId);
  });

  ipcMain.handle("settings:get", async () => ({
    ok: true,
    data: await getSettingsData(),
  }));
  ipcMain.handle("settings:usage", async () => ({
    ok: true,
    data: await getSettingsData({ forceUsage: true }),
  }));
  ipcMain.handle("settings:fonts", async () => ({
    ok: true,
    data: await getInstalledFonts(),
  }));
  ipcMain.handle("settings:save", async (_event, input) => {
    const next = input && typeof input === "object" ? input : {};
    const fonts = await getInstalledFonts();
    const patch = {};

    if (Object.hasOwn(next, "fontFamily")) {
      patch.fontFamily = normalizeFontFamily(next.fontFamily, fonts);
    }
    if (Object.hasOwn(next, "bubbleBgColor")) {
      patch.bubbleBgColor = typeof next.bubbleBgColor === "string" ? next.bubbleBgColor.trim() : "";
    }
    if (Object.hasOwn(next, "bubbleTextColor")) {
      patch.bubbleTextColor = typeof next.bubbleTextColor === "string" ? next.bubbleTextColor.trim() : "";
    }
    if (
      typeof next.petKey === "string" &&
      listAvailablePets().some((pet) => pet.key === next.petKey)
    ) {
      applyPet(next.petKey);
    }
    if (Object.values(ACTIVITY_BUBBLE_MODES).includes(next.activityBubbleMode)) {
      setActivityBubbleMode(next.activityBubbleMode);
    }
    if (typeof next.followMouse === "boolean" && next.followMouse !== runtime.followMouse) {
      toggleFollowMouse();
    }
    if (typeof next.autoStart === "boolean" && next.autoStart !== isAutoLaunchEnabled()) {
      toggleAutoLaunch();
    }

    writeSettings(patch);
    sendAppearanceToWindows();
    refreshTrayMenu();
    return { ok: true, data: await getSettingsData() };
  });
  ipcMain.handle("settings:account", async (_event, input) => {
    try {
      const action = input?.action;
      let succeeded = false;

      if (["agy", "claude"].includes(input?.provider)) {
        if (action === "login") succeeded = await startProviderLogin(input.provider);
        else if (action === "switch" && typeof input.profileKey === "string") succeeded = await switchProviderAccount(input.provider, input.profileKey);
        else if (action === "delete" && typeof input.profileKey === "string") succeeded = Boolean(deleteProviderAccount(input.provider, input.profileKey));
        else return { ok: false, error: "알 수 없는 계정 작업입니다." };
        return succeeded ? { ok: true, data: await getSettingsData() } : { ok: false, error: "작업을 완료하지 못했습니다." };
      }

      if (input?.provider && input.provider !== "codex") {
        return { ok: false, error: "지원하지 않는 계정 유형입니다." };
      }

      if (action === "login") {
        succeeded = await openCodexLoginTerminal();
      } else if (action === "switch" && typeof input.profileKey === "string") {
        succeeded = await switchCodexAccount(input.profileKey);
      } else if (action === "delete" && typeof input.profileKey === "string") {
        succeeded = Boolean(deleteProviderAccount("codex", input.profileKey));
      } else {
        return { ok: false, error: "알 수 없는 계정 작업입니다." };
      }

      if (!succeeded) {
        return {
          ok: false,
          error: "작업을 완료하지 못했습니다. 펫 말풍선의 안내를 확인해 주세요.",
        };
      }
      return { ok: true, data: await getSettingsData() };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.on("settings:minimize", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.minimize();
    }
  });
  ipcMain.on("settings:maximize", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMaximized()) {
        settingsWindow.unmaximize();
      } else {
        settingsWindow.maximize();
      }
    }
  });
  ipcMain.on("settings:close", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });
}

// 앱 수명주기 진입점입니다.
app.whenReady().then(() => {
  // macOS에서는 데스크톱 펫이 Dock에 남아 있을 이유가 없어 메뉴바(트레이)로만 동작하게 합니다.
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  restoreMovementPreferences();
  registerIpcHandlers();
  registerCodexWatcher();
  registerExternalWatcher(antigravityWatcher, "AGY");
  registerExternalWatcher(claudeWatcher, "Claude");
  createTray();
  createWindow();
  createBubbleWindow();
  if (process.argv.includes("--settings")) {
    openSettingsWindow();
  }
  // 사용량 풍선은 수동 호출이라 문제가 없지만, 대화 말풍선은 watcher가 시작되지 않으면 절대 뜨지 않습니다.
  // 그래서 말풍선 renderer 로드 여부와 무관하게 감시를 바로 시작하고, 표시 데이터는 showBubble()에서 큐잉합니다.
  codexWatcher.start();
  antigravityWatcher.start();
  claudeWatcher.start();
  codexProxyStartupPromise = restoreCodexProxyMode();
  void codexProxyStartupPromise;

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  teardownCodexProxyOnQuit();
});

// 타이머를 모두 정리하고 앱을 종료합니다.
app.on("window-all-closed", () => {
  stopMovementLoop();
  clearTimeout(phaseTimer);
  clearTimeout(reactionTimer);
  clearTimeout(bubbleHideTimer);
  clearTimeout(bubbleRenderFallbackTimer);
  codexWatcher.stop();
  antigravityWatcher.stop();
  claudeWatcher.stop();

  // 트레이에 남아 있어야 하는 일반 닫힘과, "완전 종료"를 명확히 분리합니다.
  if (isQuitting) {
    app.quit();
  }
});

function getAppearancePayload() {
  const settings = readSettings();
  return {
    fontFamily: settings.fontFamily || "",
    bubbleBgColor: settings.bubbleBgColor || "",
    bubbleTextColor: settings.bubbleTextColor || "",
  };
}

function sendAppearanceToWindows() {
  const payload = getAppearancePayload();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("appearance:update", payload);
  }
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.webContents.send("appearance:update", payload);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("appearance:update", payload);
  }
}

function codexAccountRows() {
  return codexAccountSwitcher.listProfiles().map((profile) => ({
    key: profile.key,
    label: profile.label,
    active: profile.active,
    email: profile.email,
    plan: profile.planType,
    hasAuth: profile.hasAuth,
  }));
}

async function loadCodexUsage() {
  try {
    const data = buildUsageBubbleData(await codexAccountSwitcher.fetchCurrentUsage());
    return { id: "codex", label: "Codex", gauges: data.gauges };
  } catch {
    return { id: "codex", label: "Codex", error: "조회 불가", gauges: [] };
  }
}

async function loadAntigravityProvider(forceUsage) {
  let credential;
  try {
    credential = await antigravityAccountSwitcher.read();
  } catch {
    return {
      accounts: antigravityAccountSwitcher.listProfiles(),
      usage: { id: "agy", label: "AGY", error: "로그인 필요", gauges: [] },
    };
  }

  let identity = {};
  try {
    identity = await fetchAntigravityIdentity({ credential, force: forceUsage });
  } catch {
    // 계정 조회가 막혀도 저장된 힌트와 한도 조회는 각각 계속 시도합니다.
  }
  try {
    await antigravityAccountSwitcher.snapshotCurrent({ email: identity.email });
  } catch {
    // 로그인 정보 자체가 없으면 아래 한도 조회에서 로그인 오류로 처리합니다.
  }

  let usage;
  try {
    const data = await fetchAntigravityUsage({ credential, force: forceUsage });
    await antigravityAccountSwitcher.snapshotCurrent({
      email: data.email || identity.email,
      plan: data.plan,
    });
    usage = { id: "agy", label: "AGY", gauges: data.gauges };
  } catch {
    try {
      await antigravityAccountSwitcher.snapshotCurrent();
    } catch {
      // 로그인 정보 자체가 없으면 저장할 프로필도 없습니다.
    }
    usage = { id: "agy", label: "AGY", error: "조회 불가", gauges: [] };
  }
  return { accounts: antigravityAccountSwitcher.listProfiles(), usage };
}

async function loadClaudeProvider(forceUsage) {
  let status = {};
  try {
    status = await getClaudeAuthStatus();
  } catch {
    // 사용량과 저장된 프로필은 별도로 확인합니다.
  }
  try {
    claudeAccountSwitcher.snapshotCurrent({
      email: status.email,
      plan: status.subscriptionType,
    });
  } catch {
    return {
      accounts: claudeAccountSwitcher.listProfiles(),
      usage: { id: "claude", label: "Claude", error: "로그인 필요", gauges: [] },
    };
  }

  let usage;
  try {
    const data = await fetchClaudeUsage({ force: forceUsage, credentialStore: claudeLiveStore });
    // 토큰 갱신으로 live 파일이 바뀌었을 수 있으므로 최신 값을 다시 저장합니다.
    claudeAccountSwitcher.snapshotCurrent({
      email: status.email,
      plan: status.subscriptionType,
    });
    usage = { id: "claude", label: "Claude", gauges: data.gauges };
  } catch {
    usage = { id: "claude", label: "Claude", error: "조회 불가", gauges: [] };
  }
  return { accounts: claudeAccountSwitcher.listProfiles(), usage };
}

async function getSettingsData({ forceUsage = false } = {}) {
  const settings = readSettings();
  const pets = listAvailablePets();
  const [codexUsage, agy, claude] = await Promise.all([
    loadCodexUsage(),
    loadAntigravityProvider(forceUsage),
    loadClaudeProvider(forceUsage),
  ]);
  const codexAccounts = codexAccountRows();

  return {
    appearance: {
      fontFamily: settings.fontFamily || "",
      bubbleBgColor: settings.bubbleBgColor || "",
      bubbleTextColor: settings.bubbleTextColor || "",
    },
    pets: pets.map((pet) => ({ key: pet.key, label: pet.label })),
    petKey: resolveSelectedPet()?.key || "",
    activityBubbleMode: settings.activityBubbleMode || "full",
    followMouse: runtime.followMouse,
    autoStart: isAutoLaunchEnabled(),
    providers: [
      { id: "codex", label: "Codex", accounts: codexAccounts },
      { id: "agy", label: "AGY", accounts: agy.accounts },
      { id: "claude", label: "Claude", accounts: claude.accounts },
    ],
    usage: [codexUsage, agy.usage, claude.usage],
  };
}

function openSettingsWindow(section = "general") {
  const requestedSection = ["general", "accounts", "usage"].includes(section)
    ? section
    : "general";
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.webContents.send("settings:navigate", requestedSection);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 620,
    minHeight: 500,
    show: false,
    frame: false,
    title: "CodePet 설정",
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWindow.on("maximize", () => {
    settingsWindow.webContents.send("settings:maximized-state", true);
  });
  settingsWindow.on("unmaximize", () => {
    settingsWindow.webContents.send("settings:maximized-state", false);
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    settingsWindow.focus();
    sendAppearanceToWindows();
    settingsWindow.webContents.send("settings:navigate", requestedSection);
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
}
