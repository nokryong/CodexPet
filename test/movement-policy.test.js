const test = require("node:test");
const assert = require("node:assert/strict");

const {
  advanceRoamingPosition,
  createRoamingVector,
  hasBlockingMovementReasons,
  isActivityOnlyReason,
} = require("../src/movement-policy");

test("provider 작업 상태는 모션만 바꾸고 자동 이동은 막지 않는다", () => {
  assert.equal(isActivityOnlyReason("codex"), true);
  assert.equal(hasBlockingMovementReasons(new Set(["codex"])), false);
});

test("드래그와 수동 반응은 자동 이동을 계속 막는다", () => {
  assert.equal(hasBlockingMovementReasons(new Set(["drag"])), true);
  assert.equal(hasBlockingMovementReasons(new Set(["codex", "reaction"])), true);
});

test("자동 배회 방향은 좌우뿐 아니라 위아래와 대각선을 만든다", () => {
  assert.deepEqual(createRoamingVector(0), { x: 1, y: 0 });
  assert.deepEqual(createRoamingVector(0.25), { x: 0, y: 1 });
  const diagonal = createRoamingVector(0.125);
  assert.ok(diagonal.x > 0.7 && diagonal.y > 0.7);
});

test("2차원 자동 배회는 위아래와 좌우 화면 경계에서 방향을 반사한다", () => {
  const next = advanceRoamingPosition({
    x: 80,
    y: 80,
    width: 20,
    height: 20,
    velocityX: 1,
    velocityY: 1,
    speed: 5,
    workArea: { x: 0, y: 0, width: 100, height: 100 },
    previousDirection: 1,
  });

  assert.equal(next.x, 80);
  assert.equal(next.y, 80);
  assert.equal(next.direction, -1);
  assert.ok(Math.abs(next.velocityX + Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(next.velocityY + Math.SQRT1_2) < 1e-12);
});
