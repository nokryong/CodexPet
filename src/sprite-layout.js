(function attachSpriteLayout(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodePetSpriteLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SPRITE_COLS = 8;
  const DEFAULT_SPRITE_ROWS = 9;
  const V2_SPRITE_ROWS = 11;
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
  });

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
    SPRITE_COLS,
    SUPPORTED_SPRITE_ROWS,
    V2_SPRITE_ROWS,
    detectSpriteRows,
    rowsFromSpriteVersion,
    stateFrameCount,
  });
});
