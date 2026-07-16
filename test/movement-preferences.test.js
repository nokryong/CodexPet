const test = require("node:test");
const assert = require("node:assert/strict");

const {
  movementPreferencesPatch,
  normalizeMovementPreferences,
} = require("../src/movement-preferences");

test("이동 설정은 명시적인 true만 복원하고 두 토글을 함께 저장한다", () => {
  assert.deepEqual(normalizeMovementPreferences({ followMouse: true, manualPaused: true }), {
    followMouse: true,
    manualPaused: true,
  });
  assert.deepEqual(normalizeMovementPreferences({ followMouse: "true", manualPaused: 1 }), {
    followMouse: false,
    manualPaused: false,
  });
  assert.deepEqual(movementPreferencesPatch({ followMouse: true, manualPaused: false }), {
    followMouse: true,
    manualPaused: false,
  });
});
