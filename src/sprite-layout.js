(function attachSpriteLayout(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodePetSpriteLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SPRITE_COLS = 8;
  const DEFAULT_SPRITE_ROWS = 9;
  const V2_SPRITE_ROWS = 11;
  const LOOK_DIRECTION_COUNT = 16;
  const SUPPORTED_SPRITE_ROWS = Object.freeze([DEFAULT_SPRITE_ROWS, V2_SPRITE_ROWS]);
  const CELL_ASPECT_RATIO = 208 / 192;
  const V2_STATE_FRAMES = Object.freeze({
    idle: 6,
    runningRight: 8,
    runningLeft: 8,
    waving: 4,
    jumping: 5,
    failed: 8,
    waiting: 6,
    running: 6,
    review: 6,
    lookRow9: 8,
    lookRow10: 8,
  });

  function normalizeDirectionIndex(value) {
    const direction = Number(value);
    if (!Number.isFinite(direction)) return 0;
    return ((Math.round(direction) % LOOK_DIRECTION_COUNT) + LOOK_DIRECTION_COUNT) % LOOK_DIRECTION_COUNT;
  }

  function directionIndexFromVector(deltaX, deltaY) {
    const x = Number(deltaX);
    const y = Number(deltaY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;

    const clockwiseDegrees = (Math.atan2(y, x) * (180 / Math.PI) + 90 + 360) % 360;
    return normalizeDirectionIndex(clockwiseDegrees / 22.5);
  }

  function lookCellForDirection(directionIndex) {
    const normalized = normalizeDirectionIndex(directionIndex);
    return {
      row: 9 + Math.floor(normalized / SPRITE_COLS),
      column: normalized % SPRITE_COLS,
    };
  }

  function playableFrameColumns(rowOccupancy, frameCount) {
    const normalizedCount = Math.min(
      SPRITE_COLS,
      Math.max(0, Math.floor(Number(frameCount) || 0))
    );
    const expectedColumns = Array.from({ length: normalizedCount }, (_value, column) => column);

    if (!Array.isArray(rowOccupancy)) return expectedColumns;
    return expectedColumns.filter((column) => rowOccupancy[column] === true);
  }

  function nearestPlayableDirection(directionIndex, playableDirections) {
    if (!Array.isArray(playableDirections) || playableDirections.length === 0) return null;

    const target = normalizeDirectionIndex(directionIndex);
    const candidates = [...new Set(playableDirections.map(normalizeDirectionIndex))];
    let nearest = candidates[0];
    let nearestDistance = LOOK_DIRECTION_COUNT;

    for (const candidate of candidates) {
      const directDistance = Math.abs(candidate - target);
      const circularDistance = Math.min(directDistance, LOOK_DIRECTION_COUNT - directDistance);
      if (circularDistance < nearestDistance) {
        nearest = candidate;
        nearestDistance = circularDistance;
      }
    }

    return nearest;
  }

  function rowsFromSpriteVersion(spriteVersionNumber) {
    return Number(spriteVersionNumber) === 2 ? V2_SPRITE_ROWS : DEFAULT_SPRITE_ROWS;
  }

  function detectSpriteRows({ width, height, spriteVersionNumber } = {}) {
    const imageWidth = Number(width);
    const imageHeight = Number(height);

    if (
      Number.isFinite(imageWidth) &&
      Number.isFinite(imageHeight) &&
      imageWidth > 0 &&
      imageHeight > 0
    ) {
      const expectedCellHeight = (imageWidth / SPRITE_COLS) * CELL_ASPECT_RATIO;
      const estimatedRows = imageHeight / expectedCellHeight;
      const detected = SUPPORTED_SPRITE_ROWS.find(
        (rows) => Math.abs(estimatedRows - rows) <= 0.08
      );
      if (detected) return detected;
    }

    return rowsFromSpriteVersion(spriteVersionNumber);
  }

  function stateFrameCount(stateName, spriteRows, fallbackFrames) {
    if (Number(spriteRows) === V2_SPRITE_ROWS && V2_STATE_FRAMES[stateName]) {
      return V2_STATE_FRAMES[stateName];
    }
    return fallbackFrames;
  }

  return Object.freeze({
    DEFAULT_SPRITE_ROWS,
    LOOK_DIRECTION_COUNT,
    SPRITE_COLS,
    SUPPORTED_SPRITE_ROWS,
    V2_SPRITE_ROWS,
    detectSpriteRows,
    directionIndexFromVector,
    lookCellForDirection,
    nearestPlayableDirection,
    normalizeDirectionIndex,
    playableFrameColumns,
    rowsFromSpriteVersion,
    stateFrameCount,
  });
});
