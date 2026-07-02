const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexWatcher } = require("./codex-watcher");

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
  SHOW_CODEX_STATUS: "pet:show-codex-status",
  SET_SPRITE: "pet:set-sprite",
});

// 말풍선 창 전용 채널입니다. bubble-preload.js와 같은 문자열을 사용해야 합니다.
const BUBBLE_CHANNELS = Object.freeze({
  UPDATE: "bubble:update",
  RESIZE: "bubble:resize",
  DISMISS: "bubble:dismiss",
});

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
  minIdleMs: 900,
  maxIdleMs: 2200,
  idleAfterDragMs: 900,
  idleAfterReactionMs: 650,
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
});

// 내장 기본 스프라이트입니다. 아래 우선순위에서 마지막 fallback으로만 사용합니다.
const SPRITE_ASSET = Object.freeze({
  fileName: "spritesheet.webp",
  filePath: path.join(__dirname, "..", "assets", "spritesheet.webp"),
  mimeType: "image/webp",
});

// Codex CLI가 설치한 펫 에셋 폴더입니다. 폴더마다 pet.json + spritesheet.webp가 들어 있고,
// 스프라이트는 전부 같은 규격(1536x1872, 8x9 grid)이라 이미지만 바꿔도 렌더링이 됩니다.
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
  const iconCandidates = [
    path.join(process.resourcesPath || "", "icon.ico"),
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(getBaseDir(), "icon.ico"),
  ];

  const iconPath = iconCandidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (iconPath) {
    return nativeImage.createFromPath(iconPath);
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
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.warn("[desktop-pet] Failed to save settings.", error.message);
  }
}

// 사용할 수 있는 펫 목록을 우선순위 순서로 모읍니다.
//  1. exe(또는 프로젝트) 옆 pet/spritesheet.webp — 목록에 없는 커스텀 스프라이트용
//  2. ~/.codex/pets/* — Codex가 설치한 펫들 (pet.json의 displayName을 메뉴 이름으로 사용)
//  3. 내장 기본 스프라이트
function listAvailablePets() {
  const pets = [];

  const customPath = path.join(getBaseDir(), "pet", "spritesheet.webp");
  if (fs.existsSync(customPath)) {
    pets.push({ key: "custom", label: "커스텀 (pet 폴더)", spritePath: customPath });
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
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(CODEX_PETS_DIR, name, "pet.json"), "utf8")
      );
      if (meta.displayName) label = meta.displayName;
    } catch {
      // pet.json이 없거나 형식이 달라도 폴더명으로 표시하면 됩니다.
    }

    pets.push({ key: `codex:${name}`, label, spritePath });
  }

  if (fs.existsSync(SPRITE_ASSET.filePath)) {
    pets.push({ key: "builtin", label: "기본 펫 (내장)", spritePath: SPRITE_ASSET.filePath });
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
  if (!pet || !petWindow || petWindow.isDestroyed()) return;

  petWindow.webContents.send(IPC_CHANNELS.SET_SPRITE, createSpritePayload(pet));
  refreshTrayMenu();
}

// 말풍선 창 관련 설정입니다. 너비는 고정하고 높이는 내용에 맞춰 renderer가 보고합니다.
const BUBBLE_CONFIG = Object.freeze({
  width: 270,
  minHeight: 48,
  maxHeight: 420,
  gapPx: 2,
  usageAutoHideMs: 12000,
  doneAutoHideMs: 8000,
  activityMaxChars: 240,
});

let petWindow = null;
let movementTimer = null;
let phaseTimer = null;
let reactionTimer = null;
let dragSession = null;
let tray = null;
let isQuitting = false;

let bubbleWindow = null;
let bubbleHideTimer = null;
// 내용 갱신(UPDATE) 후 renderer가 높이를 보고(RESIZE)해야 창을 보여줍니다.
// 그 사이에 hide 요청이 오면 표시를 취소하기 위한 플래그입니다.
let bubblePendingShow = false;
let bubbleHeight = 80;
// 작업 중 말풍선의 마지막 내용입니다. 사용량 말풍선이 닫힌 뒤 작업이 계속 중이면 복귀시킵니다.
let lastActivityBubble = null;

// 사용률이 이 값을 넘으면 펫이 자발적으로 경고 말풍선을 띄웁니다.
const USAGE_WARN_THRESHOLD_PERCENT = 90;
// 같은 초기화 주기 안에서 경고를 반복하지 않도록 마지막으로 경고한 resets_at을 기억합니다.
const usageWarnedResets = { primary: null, secondary: null };

const codexWatcher = new CodexWatcher();

// runtime은 현재 창 위치, 이동 방향, 수동 일시정지 상태처럼 실행 중 계속 바뀌는 값입니다.
const runtime = {
  width: 192,
  height: 208,
  x: 0,
  y: 0,
  direction: 1,
  currentState: "idle",
  movementPhase: "idle",
  manualPaused: false,
  pauseReasons: new Set(),
  pauseStates: new Map(),
  followMouse: false,
};

// 주어진 최소/최대 범위 사이에서 랜덤 시간을 뽑습니다.
function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
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

function normalizeWindowSize(width) {
  const requestedWidth = Number(width);

  if (!Number.isFinite(requestedWidth)) {
    return null;
  }

  const nextWidth = Math.round(
    Math.min(Math.max(requestedWidth, RESIZE_CONFIG.minWidth), RESIZE_CONFIG.maxWidth)
  );
  const nextHeight = Math.round(nextWidth * RESIZE_CONFIG.aspectRatio);

  return {
    width: nextWidth,
    height: nextHeight,
  };
}

// 여러 pause reason이 겹쳤을 때 화면에 보여줄 상태를 정합니다.
// 예: Codex 작업 중(review) 사용자가 클릭해서 waving을 재생한 뒤에는 idle이 아니라 review로 돌아가야 합니다.
function getActivePauseState() {
  for (const reason of ["codex", "drag", "reaction"]) {
    const stateName = runtime.pauseStates.get(reason);
    if (stateName) return stateName;
  }

  return runtime.pauseStates.values().next().value || "idle";
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
function clampToWorkArea(nextX, nextY) {
  const area = getCurrentWorkArea(nextX, nextY);
  const maxX = area.x + area.width - runtime.width;
  const maxY = area.y + area.height - runtime.height;

  return {
    x: Math.min(Math.max(nextX, area.x), maxX),
    y: Math.min(Math.max(nextY, area.y), maxY),
  };
}

// BrowserWindow의 실제 위치를 runtime과 동기화해서 이동시킵니다.
function moveWindowTo(nextX, nextY) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    console.warn("[desktop-pet] Invalid window position ignored.", nextX, nextY);
    return;
  }

  const clamped = clampToWorkArea(nextX, nextY);
  runtime.x = clamped.x;
  runtime.y = clamped.y;
  petWindow.setPosition(Math.round(runtime.x), Math.round(runtime.y), false);

  // 말풍선이 떠 있으면 펫을 따라다니게 합니다.
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
    positionBubble();
  }
}

// renderer에 새 애니메이션 상태를 보냅니다.
// 상태 이름을 잘못 보내도 renderer가 idle로 fallback하지만, main에서도 최대한 명확히 관리합니다.
function sendPetState(stateName) {
  runtime.currentState = stateName;

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(IPC_CHANNELS.SET_STATE, stateName);
  }
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

  if (runtime.pauseReasons.size > 0) {
    sendPetState(getActivePauseState());
    return;
  }

  runtime.movementPhase = "idle";
  sendPetState("idle");
  schedulePhase(beginWalkingPhase, delayMs);
}

// 걸어가는 phase를 시작합니다.
// 방향에 따라 runningRight/runningLeft 상태를 renderer에 보냅니다.
function beginWalkingPhase() {
  if (runtime.manualPaused || runtime.pauseReasons.size > 0) return;

  runtime.movementPhase = "walking";
  sendPetState(runtime.direction > 0 ? "runningRight" : "runningLeft");

  const walkMs = randomBetween(MOVEMENT_CONFIG.minWalkMs, MOVEMENT_CONFIG.maxWalkMs);
  schedulePhase(beginIdlePhase, walkMs);
}

// 잠시 멈추는 phase를 시작합니다.
// 이동과 대기를 번갈아 쓰면 펫이 더 자연스럽게 보이고, idle 애니메이션도 확인하기 쉽습니다.
function beginIdlePhase() {
  if (runtime.manualPaused || runtime.pauseReasons.size > 0) return;

  runtime.movementPhase = "idle";
  sendPetState("idle");

  const idleMs = randomBetween(MOVEMENT_CONFIG.minIdleMs, MOVEMENT_CONFIG.maxIdleMs);
  schedulePhase(beginWalkingPhase, idleMs);
}

function updateMovementTick() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (runtime.manualPaused || runtime.pauseReasons.size > 0) return;

  if (runtime.followMouse) {
    const mouse = screen.getCursorScreenPoint();
    const centerX = runtime.x + runtime.width / 2;
    const centerY = runtime.y + runtime.height / 2;
    const dx = mouse.x - centerX;
    const dy = mouse.y - centerY;
    const dist = Math.hypot(dx, dy);

    if (dist > MOVEMENT_CONFIG.speedPxPerTick * 2) {
      const nextX = runtime.x + (dx / dist) * MOVEMENT_CONFIG.speedPxPerTick;
      const nextY = runtime.y + (dy / dist) * MOVEMENT_CONFIG.speedPxPerTick;
      
      const nextDirection = dx > 0 ? 1 : -1;
      runtime.direction = nextDirection;
      
      const nextState = nextDirection > 0 ? "runningRight" : "runningLeft";
      if (runtime.currentState !== nextState) {
        sendPetState(nextState);
      }
      
      moveWindowTo(nextX, nextY);
    } else {
      if (runtime.currentState !== "idle" && runtime.currentState !== "waving") {
        sendPetState("idle");
      }
    }
    return;
  }

  if (runtime.movementPhase !== "walking") return;

  const area = getCurrentWorkArea();
  let nextX = runtime.x + runtime.direction * MOVEMENT_CONFIG.speedPxPerTick;
  let nextY = runtime.y;

  if (nextX <= area.x) {
    nextX = area.x;
    runtime.direction = 1;
    sendPetState("runningRight");
  }

  if (nextX + runtime.width >= area.x + area.width) {
    nextX = area.x + area.width - runtime.width;
    runtime.direction = -1;
    sendPetState("runningLeft");
  }

  moveWindowTo(nextX, nextY);
}

// 앱 시작 시 펫을 기본 모니터의 아래쪽 근처에 배치합니다.
function placeInitialWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  runtime.x = area.x + Math.floor(area.width * 0.55);
  runtime.y = area.y + area.height - runtime.height - 32;
  moveWindowTo(runtime.x, runtime.y);
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
  stopMovementLoop();
  runtime.pauseReasons.clear();
  runtime.pauseStates.clear();
  runtime.movementPhase = "idle";

  if (resetPosition) {
    placeInitialWindow();
  } else {
    moveWindowTo(runtime.x, runtime.y);
  }

  beginIdlePhase();
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

// 수동 Pause/Resume 메뉴 항목에서 자동 이동을 토글합니다.
function toggleManualPause() {
  runtime.manualPaused = !runtime.manualPaused;

  if (runtime.manualPaused) {
    clearTimeout(phaseTimer);
    sendPetState("idle");
    refreshTrayMenu();
    return;
  }

  beginIdlePhase();
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

// 시스템 트레이 메뉴는 창이 투명해져서 펫 우클릭 메뉴를 못 여는 상황에서도 접근할 수 있는 안전장치입니다.
function buildTrayMenu() {
  const isPetVisible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());

  return Menu.buildFromTemplate([
    {
      label: "CodexPet 보이기",
      enabled: !isPetVisible,
      click: showPetWindowFromTray,
    },
    {
      label: "CodexPet 숨기기",
      enabled: isPetVisible,
      click: hidePetWindowToTray,
    },
    { type: "separator" },
    {
      label: "Codex 사용량 보기",
      click: () => {
        showPetWindowFromTray();
        showUsageBubble();
      },
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
  tray.setToolTip("CodexPet");
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
// 사용자가 창을 찾지 못하는 상황에서도 트레이의 "CodexPet 보이기" 또는 "완전 종료"를 쓸 수 있습니다.
function hidePetWindowToTray() {
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
    createWindow();
    refreshTrayMenu();
    return;
  }

  petWindow.showInactive();
  petWindow.moveTop();
  startMovementLoop({ resetPosition: false });
  sendPetState(runtime.currentState || "idle");
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

  if (runtime.followMouse) {
    clearTimeout(phaseTimer);
  } else if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
    beginIdlePhase();
  }

  refreshTrayMenu();
}

// renderer가 우클릭을 감지하면 main process에서 네이티브 메뉴를 띄웁니다.
function showContextMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;

  const template = [
    {
      label: "Codex 사용량 보기",
      click: showUsageBubble,
    },
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
      label: "기본 대기",
      click: () => playReaction("idle"),
    },
    {
      label: "인사",
      click: () => playReaction("waving"),
    },
    {
      label: "점프",
      click: () => playReaction("jumping"),
    },
    {
      label: "축 처짐",
      click: () => playReaction("failed"),
    },
    {
      label: "대기",
      click: () => playReaction("waiting"),
    },
    {
      label: "검토 중",
      click: () => playReaction("review"),
    },
    {
      label: "작업 중",
      click: () => playReaction("running"),
    },
    {
      label: "오른쪽 이동",
      click: () => playReaction("runningRight"),
    },
    {
      label: "왼쪽 이동",
      click: () => playReaction("runningLeft"),
    },
    { type: "separator" },
    {
      label: "윈도우 시작 시 자동 실행",
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
  dragSession = {
    startScreenX: screenPoint.screenX,
    startScreenY: screenPoint.screenY,
    lastScreenX: screenPoint.screenX,
    lastScreenY: screenPoint.screenY,
    startWindowX: bounds.x,
    startWindowY: bounds.y,
    stateName: "idle",
  };

  pauseAutoMovement("drag", "idle");
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

// 말풍선 내용을 갱신합니다. 실제 표시는 renderer가 높이를 보고한 뒤(BUBBLE_CHANNELS.RESIZE) 이루어집니다.
function showBubble(data) {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;

  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = null;
  bubblePendingShow = true;
  bubbleWindow.webContents.send(BUBBLE_CHANNELS.UPDATE, data);
}

function hideBubble() {
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = null;
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
function rateWindowLabel(windowMinutes) {
  if (!Number.isFinite(windowMinutes)) return "사용 한도";
  if (windowMinutes === 10080) return "주간 한도";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}일 한도`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}시간 한도`;
  return `${windowMinutes}분 한도`;
}

// resets_at(unix 초)을 "7/3 14:22 (3시간 12분 후 초기화)" 형태로 만듭니다.
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

// codex-watcher가 준 rate_limits를 말풍선 렌더링용 데이터로 바꿉니다.
function buildUsageBubbleData(usage) {
  const { rateLimits, recordedAt } = usage;
  const gauges = [];

  for (const window of [rateLimits.primary, rateLimits.secondary]) {
    if (!window) continue;

    // 기록 이후 초기화 시각이 이미 지났으면 실제 사용량은 0으로 리셋된 상태입니다.
    // 오래된 used_percent를 그대로 보여주면 오해를 부르므로 초기화된 것으로 표시합니다.
    const resetPassed =
      Number.isFinite(window.resets_at) && window.resets_at * 1000 <= Date.now();

    gauges.push({
      label: rateWindowLabel(window.window_minutes),
      usedPercent: resetPassed ? 0 : Number(window.used_percent) || 0,
      resetText: resetPassed
        ? "이미 초기화됨 (Codex 실행 시 갱신)"
        : formatResetInfo(window.resets_at),
    });
  }

  const footerParts = [];
  if (rateLimits.plan_type) footerParts.push(`플랜: ${rateLimits.plan_type}`);
  if (recordedAt) {
    const recorded = new Date(recordedAt);
    if (!Number.isNaN(recorded.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      footerParts.push(`${pad(recorded.getHours())}:${pad(recorded.getMinutes())} 기준`);
    }
  }

  return {
    kind: "usage",
    title: "Codex 사용량",
    gauges,
    footer: footerParts.join(" · "),
  };
}

// 더블클릭 시 호출됩니다. 사용량 말풍선을 잠시 보여준 뒤,
// Codex가 아직 작업 중이면 작업 말풍선으로 되돌립니다.
function showUsageBubble() {
  const usage = codexWatcher.getUsage();

  const data = usage
    ? buildUsageBubbleData(usage)
    : {
        kind: "activity",
        title: "Codex 사용량",
        busy: false,
        text: "사용량 기록을 찾지 못했어요.\nCodex를 한 번 실행하면 표시됩니다.",
      };

  showBubble(data);
  bubbleHideTimer = setTimeout(() => {
    if (codexWatcher.working && lastActivityBubble) {
      showBubble(lastActivityBubble);
    } else {
      hideBubble();
    }
  }, BUBBLE_CONFIG.usageAutoHideMs);
}

// Codex 세션 이벤트를 펫 애니메이션과 말풍선에 연결합니다.
function registerCodexWatcher() {
  codexWatcher.on("working-changed", (isWorking, result) => {
    if (isWorking) {
      // 작업 중에는 자동 이동을 멈추고 "살펴보기" 모션을 재생합니다.
      pauseAutoMovement("codex", "review");
      lastActivityBubble = {
        kind: "activity",
        title: "Codex 작업 중",
        busy: true,
        text: "Codex가 작업을 시작했어요.",
      };
      showBubble(lastActivityBubble);
      return;
    }

    lastActivityBubble = null;
    resumeAutoMovement("codex", MOVEMENT_CONFIG.idleAfterReactionMs);

    const aborted = result?.reason === "aborted";
    playReaction(aborted ? "failed" : "jumping");
    showBubble({
      kind: "activity",
      title: aborted ? "작업 중단" : "작업 완료",
      busy: false,
      text: aborted
        ? "작업이 중단됐어요."
        : truncateForBubble(result?.message) || "Codex 작업이 끝났어요.",
    });
    bubbleHideTimer = setTimeout(hideBubble, BUBBLE_CONFIG.doneAutoHideMs);
  });

  codexWatcher.on("user-message", (message) => {
    if (!codexWatcher.working) return;
    lastActivityBubble = {
      kind: "activity",
      title: "Codex 작업 중",
      busy: true,
      text: `요청: ${truncateForBubble(message)}`,
    };
    showBubble(lastActivityBubble);
  });

  codexWatcher.on("agent-message", (message) => {
    if (!codexWatcher.working) return;
    lastActivityBubble = {
      kind: "activity",
      title: "Codex 작업 중",
      busy: true,
      text: truncateForBubble(message),
    };
    showBubble(lastActivityBubble);
  });

  // 파일 수정/웹 검색 같은 도구 사용을 실시간으로 보여줍니다.
  codexWatcher.on("tool-activity", (activity) => {
    if (!codexWatcher.working) return;

    let text;
    if (activity.kind === "patch") {
      const prefix = activity.success ? "📝 파일 수정" : "⚠️ 파일 수정 실패";
      text = `${prefix}: ${truncateForBubble(activity.files.join(", "))}`;
    } else if (activity.kind === "search") {
      text = activity.query ? `🔍 웹 검색: ${truncateForBubble(activity.query)}` : "🔍 웹 검색 중";
    } else if (activity.kind === "image") {
      text = "🖼️ 이미지 생성 중";
    } else {
      return;
    }

    lastActivityBubble = { kind: "activity", title: "Codex 작업 중", busy: true, text };
    showBubble(lastActivityBubble);
  });

  // 사용량이 갱신될 때마다 한도 임박 여부를 확인합니다.
  codexWatcher.on("usage-updated", (usage) => {
    maybeWarnUsage(usage);
  });
}

// 한도 사용률이 기준을 넘으면 초기화 주기당 한 번만 경고 말풍선을 띄웁니다.
function maybeWarnUsage(usage) {
  const rateLimits = usage?.rateLimits;
  if (!rateLimits) return;

  for (const key of ["primary", "secondary"]) {
    const window = rateLimits[key];
    if (!window) continue;
    if (!(Number(window.used_percent) >= USAGE_WARN_THRESHOLD_PERCENT)) continue;
    if (usageWarnedResets[key] === window.resets_at) continue;

    usageWarnedResets[key] = window.resets_at;

    // 작업 중이 아닐 때만 쓰러지는 모션을 재생합니다.
    // 작업 중에 재생하면 반응이 끝난 뒤 review 모션으로 돌아오지 않기 때문입니다.
    if (!codexWatcher.working) {
      playReaction("failed");
    }

    showBubble({
      kind: "activity",
      title: "⚠️ Codex 한도 임박",
      busy: false,
      text: `${rateWindowLabel(window.window_minutes)}를 ${Math.round(window.used_percent)}% 사용했어요.\n${formatResetInfo(window.resets_at)}`,
    });
    bubbleHideTimer = setTimeout(() => {
      if (codexWatcher.working && lastActivityBubble) {
        showBubble(lastActivityBubble);
      } else {
        hideBubble();
      }
    }, BUBBLE_CONFIG.usageAutoHideMs);
    return; // 한 번에 하나만 경고합니다.
  }
}

// 말풍선용 투명 창을 만듭니다. 포커스를 뺏지 않도록 focusable을 끕니다.
function createBubbleWindow() {
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

  bubbleWindow.setMenuBarVisibility(false);
  bubbleWindow.loadFile(path.join(__dirname, "bubble.html"));

  bubbleWindow.on("closed", () => {
    bubbleWindow = null;
  });
}

function createWindow() {
  let didShowPetWindow = false;

  petWindow = new BrowserWindow({
    ...WINDOW_CONFIG,
    width: runtime.width,
    height: runtime.height,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  petWindow.setMenuBarVisibility(false);
  petWindow.loadFile(path.join(__dirname, "index.html"));

  if (OPEN_DEVTOOLS) {
    petWindow.webContents.openDevTools({ mode: "detach" });
  }

  // 투명 BrowserWindow는 렌더링 타이밍에 따라 ready-to-show가 기대보다 늦거나 애매하게 동작할 수 있습니다.
  // 그래서 ready-to-show와 did-finish-load fallback 둘 중 먼저 오는 쪽에서 한 번만 표시합니다.
  function showPetWindowOnce() {
    if (didShowPetWindow || !petWindow || petWindow.isDestroyed()) return;

    didShowPetWindow = true;
    petWindow.showInactive();
    startMovementLoop({ resetPosition: true });

    // watcher가 창 로드 전에 상태를 복원했을 수 있으므로 현재 상태를 다시 보냅니다.
    sendPetState(runtime.currentState);
    refreshTrayMenu();
  }

  petWindow.once("ready-to-show", showPetWindowOnce);
  petWindow.webContents.once("did-finish-load", () => {
    setTimeout(showPetWindowOnce, 250);
  });

  // 사용자가 Alt+F4 등으로 창을 닫으면 프로세스를 끝내지 않고 트레이로 숨깁니다.
  // 실제 종료는 트레이/메뉴의 "완전 종료"만 사용합니다.
  petWindow.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    hidePetWindowToTray();
  });

  petWindow.on("hide", refreshTrayMenu);
  petWindow.on("show", refreshTrayMenu);

  petWindow.on("closed", () => {
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
    playReaction(stateName);
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

    const nextSize = normalizeWindowSize(w, h);
    if (!nextSize) {
      console.warn("[desktop-pet] Invalid resize request ignored.", w, h);
      return;
    }

    runtime.width = nextSize.width;
    runtime.height = nextSize.height;
    petWindow.setContentSize(runtime.width, runtime.height, false);
    moveWindowTo(runtime.x, runtime.y);
  });
  ipcMain.on(IPC_CHANNELS.SHOW_CODEX_STATUS, () => {
    showUsageBubble();
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

    if (bubblePendingShow && !bubbleWindow.isVisible()) {
      bubbleWindow.showInactive();
    }
  });

  ipcMain.on(BUBBLE_CHANNELS.DISMISS, hideBubble);
}

// 앱 수명주기 진입점입니다.
app.whenReady().then(() => {
  registerIpcHandlers();
  registerCodexWatcher();
  createTray();
  createWindow();
  createBubbleWindow();

  // 말풍선 renderer가 준비된 뒤에 감시를 시작해야
  // 시작 직후 복원된 "작업 중" 말풍선이 유실되지 않습니다.
  bubbleWindow.webContents.once("did-finish-load", () => {
    codexWatcher.start();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

// 타이머를 모두 정리하고 앱을 종료합니다.
app.on("window-all-closed", () => {
  stopMovementLoop();
  clearTimeout(phaseTimer);
  clearTimeout(reactionTimer);
  clearTimeout(bubbleHideTimer);
  codexWatcher.stop();

  // 트레이에 남아 있어야 하는 일반 닫힘과, "완전 종료"를 명확히 분리합니다.
  if (isQuitting) {
    app.quit();
  }
});
