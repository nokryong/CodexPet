const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectSpriteRows,
  directionIndexFromVector,
  lookCellForDirection,
  nearestPlayableDirection,
  playableFrameColumns,
  rowsFromSpriteVersion,
  stateFrameCount,
} = require("../src/sprite-layout");

test("스프라이트 실제 크기로 v1 8x9와 v2 8x11을 자동 판별한다", () => {
  assert.equal(detectSpriteRows({ width: 1536, height: 1872 }), 9);
  assert.equal(detectSpriteRows({ width: 1536, height: 2288 }), 11);
  assert.equal(detectSpriteRows({ width: 768, height: 936 }), 9);
  assert.equal(detectSpriteRows({ width: 768, height: 1144 }), 11);
});

test("이미지 비율을 판별할 수 없으면 spriteVersionNumber를 fallback으로 사용한다", () => {
  assert.equal(rowsFromSpriteVersion(1), 9);
  assert.equal(rowsFromSpriteVersion(2), 11);
  assert.equal(detectSpriteRows({ spriteVersionNumber: 2 }), 11);
  assert.equal(detectSpriteRows({ width: 1, height: 1, spriteVersionNumber: 1 }), 9);
});

test("v2의 waiting, running, review는 투명한 뒤쪽 셀을 재생하지 않는다", () => {
  assert.equal(stateFrameCount("waiting", 9, 8), 8);
  assert.equal(stateFrameCount("running", 9, 8), 8);
  assert.equal(stateFrameCount("review", 9, 8), 8);
  assert.equal(stateFrameCount("waiting", 11, 8), 6);
  assert.equal(stateFrameCount("running", 11, 8), 6);
  assert.equal(stateFrameCount("review", 11, 8), 6);
});

test("마우스 벡터를 v2의 시계 방향 16방향 셀로 변환한다", () => {
  assert.equal(directionIndexFromVector(0, -1), 0);
  assert.equal(directionIndexFromVector(1, 0), 4);
  assert.equal(directionIndexFromVector(0, 1), 8);
  assert.equal(directionIndexFromVector(-1, 0), 12);
  assert.deepEqual(lookCellForDirection(0), { row: 9, column: 0 });
  assert.deepEqual(lookCellForDirection(7), { row: 9, column: 7 });
  assert.deepEqual(lookCellForDirection(8), { row: 10, column: 0 });
  assert.deepEqual(lookCellForDirection(15), { row: 10, column: 7 });
});

test("빈 애니메이션 프레임은 건너뛰고 빈 방향은 가장 가까운 유효 셀로 대체한다", () => {
  assert.deepEqual(
    playableFrameColumns([true, false, true, true, false, true, false, false], 6),
    [0, 2, 3, 5]
  );
  assert.deepEqual(playableFrameColumns(null, 4), [0, 1, 2, 3]);
  assert.equal(nearestPlayableDirection(3, [0, 2, 4, 8]), 2);
  assert.equal(nearestPlayableDirection(15, [0, 8]), 0);
  assert.equal(nearestPlayableDirection(4, []), null);
});
