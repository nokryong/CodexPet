const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const settingsHtml = source("src/settings.html");
const settingsJs = source("src/settings.js");
const settingsCss = source("src/settings.css");
const bubbleCss = source("src/bubble.css");
const bubbleJs = source("src/bubble.js");
const mainJs = source("src/main.js");
const rendererJs = source("src/renderer.js");

test("클릭 가능한 말풍선 hover는 사용자 지정 배경색을 덮어쓰지 않는다", () => {
  assert.match(bubbleCss, /\.bubble\s*\{[^}]*background:\s*var\(--bubble-bg\)/s);
  assert.doesNotMatch(bubbleCss, /--bubble-hover/);
  assert.doesNotMatch(bubbleCss, /\.bubble\.clickable:hover/);
  assert.doesNotMatch(bubbleCss, /\.activity-section\.clickable:hover/);
});

test("설정 창은 테마 선택 없이 색상, 설치 글꼴, 세 provider, 사용량을 제공한다", () => {
  assert.doesNotMatch(settingsHtml, /name="theme"|화면 테마|data-theme/);
  assert.doesNotMatch(settingsJs, /themeSource|resolvedTheme|prefers-color-scheme/);
  assert.doesNotMatch(settingsCss, /data-theme|theme-option|theme-preview/);
  assert.match(settingsHtml, /id="font-search"/);
  assert.match(settingsHtml, /id="font-preview"/);
  assert.match(settingsJs, /function resolveInstalledFontFamily/);
  assert.match(settingsHtml, /id="provider-groups"/);
  assert.match(settingsHtml, /id="usage-cards"/);
  assert.match(settingsHtml, /VERSION 0\.3\.2/);
  assert.match(settingsCss, /--font-body:\s*"Segoe UI Variable"/);
  assert.doesNotMatch(settingsHtml, /<link[^>]+href=["']https?:/);
  assert.doesNotMatch(settingsHtml, /\.\.\/assets\//);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "assets")), false);
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "src", "default-pet", "spritesheet.webp")),
    true
  );
  assert.match(mainJs, /path\.join\(__dirname, "default-pet", "spritesheet\.webp"\)/);
});

test("설정 Footer는 짧은 창에서도 본문을 덮지 않고 글꼴 목록은 각 글꼴로 표시된다", () => {
  const panelActionsRule = settingsCss.match(/\.panel-actions\s*\{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(panelActionsRule, /position:\s*sticky|bottom\s*:/);
  assert.match(settingsJs, /function createFontOption/);
  assert.match(settingsJs, /option\.style\.fontFamily\s*=\s*fontFamily/);
  assert.match(settingsJs, /filteredFonts\.map\(\(font\) => createFontOption\(font, font, font\)\)/);
});

test("말풍선 글자 색상은 작업 제목과 모델 상태까지 함께 바꾼다", () => {
  assert.doesNotMatch(bubbleJs, /dataset\.theme|resolvedTheme/);
  assert.doesNotMatch(bubbleCss, /data-theme/);
  assert.match(bubbleCss, /\.title\s*\{[^}]*color:\s*var\(--bubble-ink\)/s);
  assert.match(bubbleCss, /\.activity-row-label\s*\{[^}]*color:\s*var\(--bubble-ink\)/s);
});

test("마우스 따라가기와 수동 일시정지는 설정 파일에 저장하고 시작 시 복원한다", () => {
  assert.match(mainJs, /restoreMovementPreferences\(\)/);
  assert.match(mainJs, /writeSettings\(movementPreferencesPatch\(runtime\)\)/);
  assert.match(mainJs, /persistMovementPreferences\(\)/);
});

test("클릭·작업 상태·정지 랜덤·마우스 둘러보기·2차원 배회를 동작 규칙대로 연결한다", () => {
  const animationPolicy = mainJs.slice(
    mainJs.indexOf("function syncMovementAnimation"),
    mainJs.indexOf("function schedulePhase")
  );
  assert.match(mainJs, /isActivityOnlyReason\(reason\)/);
  assert.match(rendererJs, /requestReaction\("jumping"\)/);
  assert.match(rendererJs, /requestReaction\("waving"\)/);
  assert.match(mainJs, /initialDragState = runtime\.direction > 0 \? "runningRight" : "runningLeft"/);
  assert.match(mainJs, /function didTaskFail\(result\)/);
  assert.match(mainJs, /playReaction\(failed \? "failed" : "jumping"\)/);
  assert.match(mainJs, /pauseAutoMovement\("codex", "running"\)/);
  assert.match(mainJs, /function chooseRandomIdleState\(\)/);
  assert.match(mainJs, /states = \["waiting", "failed"\]/);
  assert.match(mainJs, /states\.push\("lookRow10", "lookRow9"\)/);
  assert.match(mainJs, /function ensureMouseLookState\(\)/);
  assert.ok(
    animationPolicy.indexOf("runtime.followMouse") <
      animationPolicy.indexOf("getActivityPetState()")
  );
  assert.match(mainJs, /runtime\.movementPhase === "walking"/);
  assert.match(mainJs, /directionIndexFromVector\(deltaX, deltaY\)/);
  assert.match(mainJs, /createRoamingVector\(\)/);
  assert.match(mainJs, /advanceRoamingPosition\(\{/);
  assert.doesNotMatch(mainJs, /targetWorkArea/);
  assert.match(mainJs, /label: "왼쪽 둘러보기"[^\n]+lookRow10/);
  assert.match(mainJs, /label: "오른쪽 둘러보기"[^\n]+lookRow9/);
  assert.match(mainJs, /playManualReaction\("lookRow9"\)/);
  assert.match(mainJs, /playManualReaction\("lookRow10"\)/);
  assert.match(rendererJs, /scanSpriteFrameOccupancy/);
  assert.match(rendererJs, /playableFrameColumns\(rowOccupancy, expectedFrames\)/);
  assert.match(rendererJs, /nearestPlayableDirection/);
});

test("프로젝트 연결과 Codex 현재 저장·재실행 UI는 제거됐다", () => {
  assert.doesNotMatch(settingsHtml, /project-account|binding-list|save-binding|프로젝트 연결/);
  assert.doesNotMatch(settingsHtml, /현재 계정 저장|Codex Desktop 재실행/);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "project-account-bindings.js")), false);
});

test("사용량 카드는 한도만 렌더링하고 계정 action을 넣지 않는다", () => {
  const usageRenderer = settingsJs.slice(
    settingsJs.indexOf("function renderUsage"),
    settingsJs.indexOf("function renderAll")
  );
  assert.match(settingsJs, /function createUsageGauge/);
  assert.match(settingsJs, /function renderUsage/);
  assert.doesNotMatch(settingsHtml, /data-account=/);
  assert.doesNotMatch(usageRenderer, /runAccountAction\(/);
});

test("설정 renderer는 안전한 DOM API를 쓰고 성공 카드를 남기지 않는다", () => {
  assert.doesNotMatch(settingsJs, /\.innerHTML\s*=/);
  assert.match(settingsJs, /textContent/);
  assert.match(settingsHtml, /id="toast"/);
  assert.doesNotMatch(settingsHtml, /id="notice"/);
  assert.doesNotMatch(settingsJs, /완료했습니다|적용했습니다|setNotice/);
});

test("계정 설정은 비활성 프로필 삭제를 확인하고 삭제 중 상태를 표시한다", () => {
  assert.match(settingsJs, /action: "delete", profileKey: account\.key/);
  assert.match(settingsJs, /window\.confirm/);
  assert.match(settingsJs, /deleteButton\.disabled = account\.active/);
  assert.match(settingsJs, /"삭제 중…"/);
  assert.match(settingsCss, /\.danger-button/);
});

test("메뉴에서 사용량 보기와 활동 말풍선 항목을 제거하고 수동 모션을 세 번 재생한다", () => {
  assert.doesNotMatch(mainJs, /label:\s*"Codex 사용량 보기"/);
  assert.doesNotMatch(mainJs, /label:\s*"활동 말풍선"/);
  assert.match(mainJs, /label:\s*"설정…"/);
  assert.match(mainJs, /let remaining = 2/);
  assert.match(rendererJs, /window\.petApi\.showCodexStatus\(\)/);
  assert.match(mainJs, /SHOW_CODEX_STATUS[\s\S]*void showUsageBubble\(\)/);
  assert.match(
    mainJs,
    /function showWatcherActivityBubble[\s\S]*pendingBubbleData && !pendingBubbleData\.activityPrivacy/
  );
});
