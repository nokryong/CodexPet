const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectSpriteRows,
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
