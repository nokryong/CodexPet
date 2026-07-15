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
  normalizeWindowSize,
  restoreWindowGeometry,
};
