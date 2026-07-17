// Electron API에 의존하지 않는 창 복원용 순수 함수입니다.
// 저장 파일이 손상됐거나 모니터 구성이 바뀌어도 창이 화면 밖에 남지 않게 합니다.
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeWindowSize(width, resizeConfig) {
  if (!isFiniteNumber(width)) return null;

  const nextWidth = Math.round(
    Math.min(Math.max(width, resizeConfig.minWidth), resizeConfig.maxWidth)
  );

  return {
    width: nextWidth,
    height: Math.round(nextWidth * resizeConfig.aspectRatio),
  };
}

// 좌상단 핸들은 창의 우하단을 고정한 채 크기를 바꿉니다.
// 화면 오른쪽/아래 끝에 붙은 펫도 바깥쪽 마우스 공간 없이 확대할 수 있습니다.
function resizeWindowGeometry(currentGeometry, width, anchor, resizeConfig) {
  if (!currentGeometry || typeof currentGeometry !== "object") return null;

  const { x, y, width: currentWidth, height: currentHeight } = currentGeometry;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(currentWidth) ||
    !isFiniteNumber(currentHeight) ||
    currentWidth <= 0 ||
    currentHeight <= 0
  ) {
    return null;
  }

  const size = normalizeWindowSize(width, resizeConfig);
  if (!size) return null;

  if (anchor === "top-left") {
    return {
      x: x + currentWidth - size.width,
      y: y + currentHeight - size.height,
      ...size,
    };
  }

  return { x, y, ...size };
}

// Windows에서 비리사이즈 Electron 창을 반복 이동하면 DPI 배율에 따라 네이티브 창 크기가
// 함께 흔들릴 수 있습니다. 위치만 보내지 않고 의도한 크기를 매번 함께 적용할 수 있도록
// BrowserWindow.setBounds에 넘길 정수 bounds를 한 곳에서 만듭니다.
function createStableWindowBounds(x, y, width, height) {
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function getUsableWorkAreas(displays) {
  if (!Array.isArray(displays)) return [];

  return displays
    .map((display) => display?.workArea)
    .filter(
      (area) =>
        area &&
        isFiniteNumber(area.x) &&
        isFiniteNumber(area.y) &&
        isFiniteNumber(area.width) &&
        isFiniteNumber(area.height) &&
        area.width > 0 &&
        area.height > 0
    );
}

function distanceSquaredToWorkArea(x, y, area) {
  const nearestX = Math.min(Math.max(x, area.x), area.x + area.width);
  const nearestY = Math.min(Math.max(y, area.y), area.y + area.height);
  return (x - nearestX) ** 2 + (y - nearestY) ** 2;
}

function findNearestWorkArea(workAreas, x, y) {
  return workAreas.reduce((nearest, area) => {
    if (!nearest) return area;

    return distanceSquaredToWorkArea(x, y, area) < distanceSquaredToWorkArea(x, y, nearest)
      ? area
      : nearest;
  }, null);
}

function clampToWorkArea(x, y, width, height, area) {
  const maxX = Math.max(area.x, area.x + area.width - width);
  const maxY = Math.max(area.y, area.y + area.height - height);

  return {
    x: Math.round(Math.min(Math.max(x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(y, area.y), maxY)),
  };
}

// width/height는 모두 숫자이면서 양수여야 저장값을 신뢰합니다.
// 높이는 이전 버전/수동 편집으로 비율이 틀렸을 수 있으므로 검증만 하고,
// 실제 복원 크기는 현재 resize 규칙에 맞춰 width에서 다시 계산합니다.
function restoreWindowGeometry(savedGeometry, displays, resizeConfig) {
  if (!savedGeometry || typeof savedGeometry !== "object") return null;

  const { x, y, width, height } = savedGeometry;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const size = normalizeWindowSize(width, resizeConfig);
  const workAreas = getUsableWorkAreas(displays);
  if (!size || workAreas.length === 0) return null;

  const area = findNearestWorkArea(workAreas, x + size.width / 2, y + size.height / 2);
  const position = clampToWorkArea(x, y, size.width, size.height, area);

  return { ...position, ...size };
}

module.exports = {
  createStableWindowBounds,
  normalizeWindowSize,
  resizeWindowGeometry,
  restoreWindowGeometry,
};
