const NON_BLOCKING_ACTIVITY_REASONS = new Set(["codex"]);

function isActivityOnlyReason(reason) {
  return NON_BLOCKING_ACTIVITY_REASONS.has(reason);
}

function hasBlockingMovementReasons(reasons) {
  if (!reasons || typeof reasons[Symbol.iterator] !== "function") return false;

  for (const reason of reasons) {
    if (!isActivityOnlyReason(reason)) return true;
  }

  return false;
}

function createRoamingVector(randomValue = Math.random()) {
  const numericValue = Number(randomValue);
  const normalizedValue = Number.isFinite(numericValue)
    ? ((numericValue % 1) + 1) % 1
    : 0;
  const angle = normalizedValue * Math.PI * 2;
  const x = Math.cos(angle);
  const y = Math.sin(angle);

  return {
    x: Math.abs(x) < 1e-12 ? 0 : x,
    y: Math.abs(y) < 1e-12 ? 0 : y,
  };
}

function advanceRoamingPosition({
  x,
  y,
  width,
  height,
  velocityX,
  velocityY,
  speed,
  workArea,
  previousDirection = 1,
} = {}) {
  const values = [x, y, width, height, velocityX, velocityY, speed];
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (width <= 0 || height <= 0 || speed < 0 || !workArea) return null;

  const areaValues = [workArea.x, workArea.y, workArea.width, workArea.height];
  if (areaValues.some((value) => !Number.isFinite(value))) return null;
  if (workArea.width <= 0 || workArea.height <= 0) return null;

  const magnitude = Math.hypot(velocityX, velocityY);
  let nextVelocityX = magnitude > 0 ? velocityX / magnitude : 1;
  let nextVelocityY = magnitude > 0 ? velocityY / magnitude : 0;
  let nextX = x + nextVelocityX * speed;
  let nextY = y + nextVelocityY * speed;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);

  if (nextX <= workArea.x) {
    nextX = workArea.x;
    nextVelocityX = Math.abs(nextVelocityX);
  } else if (nextX >= maxX) {
    nextX = maxX;
    nextVelocityX = -Math.abs(nextVelocityX);
  }

  if (nextY <= workArea.y) {
    nextY = workArea.y;
    nextVelocityY = Math.abs(nextVelocityY);
  } else if (nextY >= maxY) {
    nextY = maxY;
    nextVelocityY = -Math.abs(nextVelocityY);
  }

  const direction = Math.abs(nextVelocityX) >= 0.05
    ? nextVelocityX > 0 ? 1 : -1
    : previousDirection === -1 ? -1 : 1;

  return {
    x: nextX,
    y: nextY,
    velocityX: nextVelocityX,
    velocityY: nextVelocityY,
    direction,
  };
}

module.exports = {
  advanceRoamingPosition,
  createRoamingVector,
  hasBlockingMovementReasons,
  isActivityOnlyReason,
};
