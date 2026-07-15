"use strict";

// 표시용 정보만 조합합니다. rollout의 원본 모델 식별자는 이 경로로 전달되지 않습니다.
function formatActivityTitle(title, context = {}) {
  const parts = [];
  if (context.workerLabel) parts.push(context.workerLabel);
  parts.push(title);
  return parts.join(" · ");
}

module.exports = { formatActivityTitle };
