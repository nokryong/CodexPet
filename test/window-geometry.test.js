const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeWindowSize, restoreWindowGeometry } = require("../src/window-geometry");

const RESIZE_CONFIG = {
  minWidth: 64,
  maxWidth: 512,
  aspectRatio: 208 / 192,
};

const DISPLAYS = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: -1280, y: 0, width: 1280, height: 984 } },
];

test("저장 크기는 현재 최소/최대 및 종횡비 규칙으로 정규화한다", () => {
  assert.deepEqual(normalizeWindowSize(600, RESIZE_CONFIG), { width: 512, height: 555 });
  assert.deepEqual(normalizeWindowSize(12, RESIZE_CONFIG), { width: 64, height: 69 });
  assert.equal(normalizeWindowSize(Number.NaN, RESIZE_CONFIG), null);
});

test("복원 창은 제거된 모니터 좌표와 부분 화면 밖 좌표를 현재 work area 안으로 보정한다", () => {
  assert.deepEqual(
    restoreWindowGeometry({ x: 1800, y: 1000, width: 192, height: 208 }, DISPLAYS, RESIZE_CONFIG),
    { x: 1728, y: 832, width: 192, height: 208 }
  );
  assert.deepEqual(
    restoreWindowGeometry({ x: -4000, y: 20, width: 192, height: 208 }, DISPLAYS, RESIZE_CONFIG),
    { x: -1280, y: 20, width: 192, height: 208 }
  );
  assert.deepEqual(
    restoreWindowGeometry(
      { x: 999999, y: -999999, width: 999999, height: 1 },
      DISPLAYS,
      RESIZE_CONFIG
    ),
    { x: 1408, y: 0, width: 512, height: 555 }
  );
});

test("손상되었거나 음수인 저장 geometry는 무시한다", () => {
  assert.equal(restoreWindowGeometry(null, DISPLAYS, RESIZE_CONFIG), null);
  assert.equal(
    restoreWindowGeometry({ x: 0, y: 0, width: -192, height: 208 }, DISPLAYS, RESIZE_CONFIG),
    null
  );
  assert.equal(
    restoreWindowGeometry({ x: 0, y: Number.NaN, width: 192, height: 208 }, DISPLAYS, RESIZE_CONFIG),
    null
  );
});
