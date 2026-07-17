// 원래 스프라이트 한 칸 크기 비율 기준 (192:208)
const BASE_WIDTH = 192;
const BASE_HEIGHT = 208;
const {
  DEFAULT_SPRITE_ROWS,
  LOOK_DIRECTION_COUNT,
  SPRITE_COLS,
  V2_SPRITE_ROWS,
  detectSpriteRows,
  lookCellForDirection,
  nearestPlayableDirection,
  normalizeDirectionIndex,
  playableFrameColumns,
  stateFrameCount,
} = globalThis.CodePetSpriteLayout;

let currentWidth = BASE_WIDTH;
let currentHeight = BASE_HEIGHT;
let spriteRows = DEFAULT_SPRITE_ROWS;

// 상태별 row/frames/fps를 한 곳에서 관리합니다.
// row는 스프라이트시트의 세로 줄, column은 해당 row 안의 가로 프레임입니다.
// 새 상태를 추가하려면 이 객체에 row, frames, fps, loop 여부를 추가하고 main.js 메뉴나 상태 전환에서 이름을 보내면 됩니다.
const PET_STATES = Object.freeze({
  idle: { row: 0, frames: 6, fps: 3, loop: true },
  runningRight: { row: 1, frames: 8, fps: 5, loop: true },
  runningLeft: { row: 2, frames: 8, fps: 5, loop: true },
  waving: { row: 3, frames: 4, fps: 4, loop: false, returnTo: "previous" },
  jumping: { row: 4, frames: 5, fps: 5, loop: false, returnTo: "previous" },
  failed: { row: 5, frames: 8, fps: 4, loop: false, returnTo: "idle" },
  waiting: { row: 6, frames: 8, fps: 3, loop: true },
  running: { row: 7, frames: 8, fps: 4, loop: true },
  review: { row: 8, frames: 8, fps: 3, loop: true },
  lookRow9: { row: 9, frames: 8, fps: 4, loop: false, returnTo: "idle", v2Only: true },
  lookRow10: { row: 10, frames: 8, fps: 4, loop: false, returnTo: "idle", v2Only: true },
});

function firstVisibleCell() {
  if (!frameOccupancy) return null;

  for (let row = 0; row < frameOccupancy.length; row += 1) {
    for (let column = 0; column < SPRITE_COLS; column += 1) {
      if (frameOccupancy[row]?.[column]) return { row, column };
    }
  }

  return null;
}

function buildStandardPetState(stateName) {
  let normalizedState = Object.prototype.hasOwnProperty.call(PET_STATES, stateName)
    ? stateName
    : "idle";
  let state = PET_STATES[normalizedState];

  if (state.v2Only && spriteRows !== V2_SPRITE_ROWS) {
    normalizedState = "idle";
    state = PET_STATES.idle;
  }

  const expectedFrames = stateFrameCount(normalizedState, spriteRows, state.frames);
  const rowOccupancy = frameOccupancy
    ? frameOccupancy[state.row] || []
    : null;
  const columns = playableFrameColumns(rowOccupancy, expectedFrames);
  let cells = columns.map((column) => ({ row: state.row, column }));

  if (cells.length === 0 && normalizedState !== "idle") {
    return buildStandardPetState("idle");
  }

  if (cells.length === 0) {
    const fallbackCell = firstVisibleCell();
    if (fallbackCell) cells = [fallbackCell];
  }

  return {
    ...state,
    stateName: normalizedState,
    cells,
    frames: Math.max(1, cells.length),
  };
}

function getPlayableLookDirections() {
  if (!frameOccupancy) {
    return Array.from({ length: LOOK_DIRECTION_COUNT }, (_value, index) => index);
  }

  const playable = [];
  for (let index = 0; index < LOOK_DIRECTION_COUNT; index += 1) {
    const cell = lookCellForDirection(index);
    if (frameOccupancy[cell.row]?.[cell.column]) playable.push(index);
  }
  return playable;
}

function getPetState(stateName = currentStateName) {
  if (stateName !== "lookDirection") return buildStandardPetState(stateName);
  if (spriteRows !== V2_SPRITE_ROWS) return buildStandardPetState(currentFallbackState);

  const directionIndex = nearestPlayableDirection(
    currentDirectionIndex,
    getPlayableLookDirections()
  );
  if (directionIndex === null) return buildStandardPetState(currentFallbackState);

  return {
    stateName: "lookDirection",
    cells: [lookCellForDirection(directionIndex)],
    frames: 1,
    fps: 8,
    loop: true,
  };
}

// 클릭과 드래그를 구분하기 위한 기준값입니다.
// 이 거리보다 많이 움직이면 클릭 반응을 실행하지 않고 드래그로만 처리합니다.
const POINTER_CONFIG = Object.freeze({
  dragThresholdPx: 6,
  doubleClickMs: 260,
});

const petElement = document.querySelector("#pet");
const petCanvas = document.querySelector("#pet-canvas");
const petContext = petCanvas.getContext("2d", { alpha: true });
const resizeHandle = document.querySelector("#resize-handle");
const errorElement = document.querySelector("#error");

let appConfig = null;
let spriteImage = null;
let frameOccupancy = null;
let currentStateName = "idle";
let currentDirectionIndex = 0;
let currentFallbackState = "idle";
let previousLoopStateName = "idle";
let currentFrame = 0;
let animationTimer = null;
let clickTimer = null;
let lastClickAt = 0;

let pointerState = {
  isPointerDown: false,
  isDragging: false,
  pointerId: null,
  startClientX: 0,
  startClientY: 0,
};

// 투명창이 막 뜨는 순간 ResizeObserver가 0x0 크기를 보고할 때가 있습니다.
// 그 값을 그대로 background-size에 넣으면 스프라이트가 완전히 투명한 것처럼 보이므로,
// 실제로 그릴 수 있는 양수 크기만 애니메이션 기준 크기로 반영합니다.
function resizePetCanvas() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(currentWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(currentHeight * dpr));

  if (petCanvas.width !== pixelWidth || petCanvas.height !== pixelHeight) {
    petCanvas.width = pixelWidth;
    petCanvas.height = pixelHeight;
  }

  petContext.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function updateSpriteMetrics(width, height) {
  const nextWidth = Number(width);
  const nextHeight = Number(height);

  if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) return;
  if (nextWidth <= 0 || nextHeight <= 0) return;

  currentWidth = nextWidth;
  currentHeight = nextHeight;
  resizePetCanvas();
  applySpriteFrame();
}

// 현재 DOM에서 펫 영역 크기를 읽습니다.
// 아직 레이아웃이 완성되지 않은 순간에는 main process가 내려준 창 크기 또는 기본 192x208을 fallback으로 씁니다.
function getRenderablePetSize() {
  const rect = petElement.getBoundingClientRect();
  const fallbackWidth = appConfig?.windowWidth || window.innerWidth || BASE_WIDTH;
  const fallbackHeight = appConfig?.windowHeight || window.innerHeight || BASE_HEIGHT;

  return {
    width: rect.width > 0 ? rect.width : fallbackWidth,
    height: rect.height > 0 ? rect.height : fallbackHeight,
  };
}

// 알 수 없는 상태 이름이 들어오면 idle로 fallback합니다.
function normalizeStateName(stateName) {
  if (Object.prototype.hasOwnProperty.call(PET_STATES, stateName)) {
    return stateName;
  }

  console.warn(`[desktop-pet] Unknown state "${stateName}", fallback to idle.`);
  return "idle";
}

function normalizeStateRequest(request) {
  const requestedState = typeof request === "object" && request
    ? request.state
    : request;

  if (requestedState === "lookDirection") {
    return {
      stateName: "lookDirection",
      directionIndex: normalizeDirectionIndex(
        typeof request === "object" ? request.directionIndex : currentDirectionIndex
      ),
      fallbackState: normalizeStateName(
        typeof request === "object" ? request.fallbackState : currentFallbackState
      ),
    };
  }

  return {
    stateName: normalizeStateName(requestedState),
    directionIndex: currentDirectionIndex,
    fallbackState: currentFallbackState,
  };
}

function currentStateRequest() {
  if (currentStateName !== "lookDirection") return currentStateName;
  return {
    state: "lookDirection",
    directionIndex: currentDirectionIndex,
    fallbackState: currentFallbackState,
  };
}

function scanSpriteFrameOccupancy(image, rows) {
  const scanCanvas = document.createElement("canvas");
  scanCanvas.width = image.naturalWidth;
  scanCanvas.height = image.naturalHeight;
  const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });
  if (!scanContext) return null;

  try {
    scanContext.drawImage(image, 0, 0);
    const pixels = scanContext.getImageData(
      0,
      0,
      scanCanvas.width,
      scanCanvas.height
    ).data;
    const occupancy = Array.from({ length: rows }, () => Array(SPRITE_COLS).fill(false));
    const minimumVisiblePixels = 8;

    for (let row = 0; row < rows; row += 1) {
      const top = Math.floor((row * scanCanvas.height) / rows);
      const bottom = Math.floor(((row + 1) * scanCanvas.height) / rows);

      for (let column = 0; column < SPRITE_COLS; column += 1) {
        const left = Math.floor((column * scanCanvas.width) / SPRITE_COLS);
        const right = Math.floor(((column + 1) * scanCanvas.width) / SPRITE_COLS);
        let visiblePixels = 0;

        scanCell:
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            if (pixels[(y * scanCanvas.width + x) * 4 + 3] <= 8) continue;
            visiblePixels += 1;
            if (visiblePixels >= minimumVisiblePixels) {
              occupancy[row][column] = true;
              break scanCell;
            }
          }
        }
      }
    }

    return occupancy;
  } catch (error) {
    console.warn("[desktop-pet] Failed to inspect transparent sprite cells.", error);
    return null;
  }
}

// 현재 프레임 번호에 맞춰 background-position을 옮깁니다.
// column은 x축, row는 y축이므로 둘 다 음수 픽셀로 이동해야 원하는 셀이 보입니다.
function applySpriteFrame() {
  const state = getPetState();
  const safeWidth = currentWidth > 0 ? currentWidth : BASE_WIDTH;
  const safeHeight = currentHeight > 0 ? currentHeight : BASE_HEIGHT;
  const cell = state.cells[currentFrame % state.frames] || null;

  resizePetCanvas();
  if (!spriteImage || !cell) return;
  petContext.clearRect(0, 0, safeWidth, safeHeight);

  const sourceWidth = spriteImage.naturalWidth / SPRITE_COLS;
  const sourceHeight = spriteImage.naturalHeight / spriteRows;
  petContext.drawImage(
    spriteImage,
    cell.column * sourceWidth,
    cell.row * sourceHeight,
    sourceWidth,
    sourceHeight,
    0,
    0,
    safeWidth,
    safeHeight
  );
}

// 다음 프레임으로 넘어갑니다.
// loop:false 상태는 마지막 프레임까지 재생한 뒤 returnTo 규칙에 따라 이전 상태나 idle로 돌아갑니다.
function advanceFrame() {
  const state = getPetState();

  applySpriteFrame();
  currentFrame += 1;

  if (currentFrame < state.frames) return;

  if (state.loop) {
    currentFrame = 0;
    return;
  }

  const returnState =
    state.returnTo === "previous" ? previousLoopStateName : state.returnTo || "idle";
  setAnimationState(returnState);
}

// fps에 맞춰 setInterval을 다시 설정합니다.
// fps를 빠르게 하면 같은 row의 column들이 더 빠르게 넘어가고, 느리게 하면 더 천천히 재생됩니다.
function restartAnimationTimer() {
  const state = getPetState();
  const frameMs = Math.round(1000 / state.fps);

  clearInterval(animationTimer);
  animationTimer = setInterval(advanceFrame, frameMs);
  advanceFrame();
}

// 외부에서 요청한 상태로 애니메이션을 전환합니다.
// 단발 상태가 끝나면 돌아갈 수 있도록 loop 상태를 previousLoopStateName에 기억합니다.
function setAnimationState(request) {
  const normalized = normalizeStateRequest(request);
  const previousState = getPetState(currentStateName);

  if (previousState.loop && currentStateName !== normalized.stateName) {
    previousLoopStateName = currentStateName === "lookDirection"
      ? currentFallbackState
      : currentStateName;
  }

  currentStateName = normalized.stateName;
  currentDirectionIndex = normalized.directionIndex;
  currentFallbackState = normalized.fallbackState;
  currentFrame = 0;
  petElement.dataset.state = currentStateName;
  if (currentStateName === "lookDirection") {
    petElement.dataset.lookDirection = String(currentDirectionIndex);
  } else {
    delete petElement.dataset.lookDirection;
  }

  const nextState = getPetState(currentStateName);
  if (nextState.loop) {
    previousLoopStateName = currentStateName === "lookDirection"
      ? currentFallbackState
      : currentStateName;
  }

  restartAnimationTimer();
}

// spritesheet.webp가 없거나 로드에 실패했을 때 작은 창 안에 명확한 메시지를 보여줍니다.
function showErrorMessage(message) {
  spriteImage = null;
  frameOccupancy = null;
  petContext.clearRect(0, 0, currentWidth || BASE_WIDTH, currentHeight || BASE_HEIGHT);
  petElement.hidden = true;
  errorElement.hidden = false;
  errorElement.textContent = message;
  console.error(`[desktop-pet] ${message}`);
}

// 스프라이트 이미지를 petElement 배경으로 적용합니다.
// keepState가 true면(실행 중 펫 교체) 현재 애니메이션 상태를 유지하고,
// false면(최초 로드) idle부터 시작합니다.
function applySpriteSheet(config, keepState = false) {
  if (!config.assetExists || !config.spriteUrl) {
    showErrorMessage(`Missing asset: ${config.spritePath}`);
    return;
  }

  const size = getRenderablePetSize();
  updateSpriteMetrics(size.width, size.height);

  const image = new Image();

  image.onload = () => {
    spriteRows = detectSpriteRows({
      width: image.naturalWidth,
      height: image.naturalHeight,
      spriteVersionNumber: config.spriteVersionNumber,
    });
    frameOccupancy = scanSpriteFrameOccupancy(image, spriteRows);
    spriteImage = image;
    petElement.dataset.spriteRows = String(spriteRows);
    petElement.hidden = false;
    errorElement.hidden = true;
    setAnimationState(keepState ? currentStateRequest() : "idle");
  };

  image.onerror = () => {
    showErrorMessage(`Failed to load: ${config.spritePath}`);
  };

  image.src = config.spriteUrl;
}

// 드래그 시작 위치에서 얼마나 움직였는지 계산합니다.
function getPointerDistance(event) {
  const deltaX = event.clientX - pointerState.startClientX;
  const deltaY = event.clientY - pointerState.startClientY;
  return Math.hypot(deltaX, deltaY);
}

// preload에는 DOM 이벤트 객체를 직접 넘기지 않고, 직렬화 가능한 숫자 좌표만 넘깁니다.
// Electron contextBridge 경계를 지날 때 PointerEvent 전체를 넘기면 screenX/screenY가 undefined가 될 수 있습니다.
function toScreenPoint(event) {
  return {
    screenX: event.screenX,
    screenY: event.screenY,
  };
}

// 클릭과 더블클릭을 직접 판정합니다.
function handleClickCandidate() {
  const now = Date.now();

  if (now - lastClickAt <= POINTER_CONFIG.doubleClickMs) {
    clearTimeout(clickTimer);
    clickTimer = null;
    lastClickAt = 0;

    // 더블클릭 시 펫이 점프하면서 설정의 사용량 화면을 엽니다.
    window.petApi.requestReaction("jumping");
    window.petApi.showCodexStatus();
    return;
  }

  // 단일 클릭은 더블클릭 대기 시간이 지난 뒤에 waving으로 처리합니다.
  lastClickAt = now;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    clickTimer = null;
    window.petApi.requestReaction("waving");
  }, POINTER_CONFIG.doubleClickMs);
}

// 왼쪽 버튼을 누르면 드래그 후보 상태로 들어갑니다.
function handlePointerDown(event) {
  if (event.button !== 0) return;

  pointerState = {
    isPointerDown: true,
    isDragging: false,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
  };

  petElement.setPointerCapture(event.pointerId);
}

// 일정 거리 이상 움직이면 드래그로 확정하고 main process에 창 이동을 요청합니다.
function handlePointerMove(event) {
  if (!pointerState.isPointerDown || event.pointerId !== pointerState.pointerId) {
    return;
  }

  const distance = getPointerDistance(event);

  if (!pointerState.isDragging && distance >= POINTER_CONFIG.dragThresholdPx) {
    pointerState.isDragging = true;
    window.petApi.dragStart(toScreenPoint(event));
  }

  if (pointerState.isDragging) {
    window.petApi.dragMove(toScreenPoint(event));
  }
}

// 포인터를 놓으면 드래그 종료 또는 클릭 반응 중 하나로 처리합니다.
function handlePointerUp(event) {
  if (!pointerState.isPointerDown || event.pointerId !== pointerState.pointerId) {
    return;
  }

  const wasDragging = pointerState.isDragging;

  if (petElement.hasPointerCapture(event.pointerId)) {
    petElement.releasePointerCapture(event.pointerId);
  }

  pointerState = {
    isPointerDown: false,
    isDragging: false,
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
  };

  if (wasDragging) {
    window.petApi.dragEnd();
    return;
  }

  handleClickCandidate();
}

// 포인터가 취소되면 드래그 상태를 안전하게 정리합니다.
function handlePointerCancel(event) {
  if (pointerState.isDragging) {
    window.petApi.dragEnd();
  }

  if (pointerState.pointerId !== null && petElement.hasPointerCapture(event.pointerId)) {
    petElement.releasePointerCapture(event.pointerId);
  }

  pointerState = {
    isPointerDown: false,
    isDragging: false,
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
  };
}

// 우클릭은 renderer에서 기본 메뉴를 막고 main process의 네이티브 메뉴를 띄웁니다.
function handleContextMenu(event) {
  event.preventDefault();
  window.petApi.showContextMenu();
}

let resizeState = {
  isResizing: false,
  pointerId: null,
  startX: 0,
  startWidth: 0,
};

function handleResizePointerDown(event) {
  event.stopPropagation();
  if (event.button !== 0) return;

  resizeState = {
    isResizing: true,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: document.body.clientWidth,
  };
  resizeHandle.setPointerCapture(event.pointerId);
}

function handleResizePointerMove(event) {
  if (!resizeState.isResizing || event.pointerId !== resizeState.pointerId) return;

  const deltaX = event.clientX - resizeState.startX;
  let newWidth = Math.max(64, resizeState.startWidth + deltaX); // 최소 너비 64
  let newHeight = newWidth * (BASE_HEIGHT / BASE_WIDTH);

  window.petApi.resizeWindow(newWidth, newHeight);
}

function handleResizePointerUpOrCancel(event) {
  if (!resizeState.isResizing || event.pointerId !== resizeState.pointerId) return;

  if (resizeHandle.hasPointerCapture(event.pointerId)) {
    resizeHandle.releasePointerCapture(event.pointerId);
  }
  resizeState.isResizing = false;
  window.petApi.resizeEnd();
}

// DOM 이벤트를 한 곳에서 연결합니다.
function registerDomEvents() {
  petElement.addEventListener("pointerdown", handlePointerDown);
  petElement.addEventListener("pointermove", handlePointerMove);
  petElement.addEventListener("pointerup", handlePointerUp);
  petElement.addEventListener("pointercancel", handlePointerCancel);
  petElement.addEventListener("contextmenu", handleContextMenu);

  if (resizeHandle) {
    resizeHandle.addEventListener("pointerdown", handleResizePointerDown);
    resizeHandle.addEventListener("pointermove", handleResizePointerMove);
    resizeHandle.addEventListener("pointerup", handleResizePointerUpOrCancel);
    resizeHandle.addEventListener("pointercancel", handleResizePointerUpOrCancel);
  }
}

// renderer 진입점입니다.
// 나중에 pet.json을 붙인다면 getAppConfig 결과에 pet.json에서 읽은 스프라이트 설정을 포함시키면 됩니다.
async function startRenderer() {
  registerDomEvents();
  window.petApi.onStateChange(setAnimationState);

  // 메뉴에서 펫을 바꾸면 스프라이트 이미지만 갈아끼웁니다.
  // 모든 펫이 같은 그리드 규격이라 애니메이션 상태는 그대로 유지됩니다.
  window.petApi.onSpriteChange((spriteConfig) => {
    const normalizedConfig =
      typeof spriteConfig === "string"
        ? { assetExists: true, spriteUrl: spriteConfig, spritePath: spriteConfig }
        : spriteConfig;

    petElement.hidden = false;
    errorElement.hidden = true;
    applySpriteSheet(normalizedConfig, true);
  });

  appConfig = await window.petApi.getAppConfig();
  updateSpriteMetrics(appConfig.windowWidth, appConfig.windowHeight);

  const resizeObserver = new ResizeObserver((entries) => {
    for (let entry of entries) {
      updateSpriteMetrics(entry.contentRect.width, entry.contentRect.height);
    }
  });
  resizeObserver.observe(petElement);

  applySpriteSheet(appConfig);
}

startRenderer().catch((error) => {
  showErrorMessage(error.message || String(error));
});
