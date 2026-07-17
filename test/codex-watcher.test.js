const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CodexWatcher,
  classifyShellCommand,
  extractThreadIdFromRolloutPath,
  normalizeWorkerLabel,
} = require("../src/codex-watcher");
const { formatActivityTitle } = require("../src/activity-title");

const THREAD_ID = "019f4a30-b0a7-73f1-8080-2ba11b4e5d25";
const ROLLOUT_PATH = path.join(
  "C:\\Users\\tester\\.codex\\sessions\\2026\\07\\10",
  `rollout-2026-07-10T13-02-17-${THREAD_ID}.jsonl`
);

test("rollout 파일명에서 Codex thread id를 추출한다", () => {
  assert.equal(extractThreadIdFromRolloutPath(ROLLOUT_PATH), THREAD_ID);
  assert.equal(extractThreadIdFromRolloutPath("rollout-without-thread.jsonl"), null);
  assert.equal(extractThreadIdFromRolloutPath(""), null);
});

test("shell 명령을 테스트, 빌드, 일반 명령으로 분류한다", () => {
  assert.equal(classifyShellCommand("npm test").kind, "test");
  assert.equal(classifyShellCommand("node --test test/codex-watcher.test.js").kind, "test");
  assert.equal(classifyShellCommand("npm run dist").kind, "build");
  assert.equal(classifyShellCommand("git status --short").kind, "read");
  assert.equal(classifyShellCommand("Get-Content src/main.js").kind, "read");
  assert.equal(classifyShellCommand("node scripts/update.js").kind, "command");
});

test("세션별 완료 이벤트에 정확한 thread id를 포함한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const finished = [];
  watcher.on("task-finished", (result) => finished.push(result));

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })
  );
  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "완료" },
    })
  );

  assert.deepEqual(finished, [
    {
      reason: "complete",
      message: "완료",
      threadId: THREAD_ID,
      otherTasksWorking: false,
      workerLabel: null,
      activeTaskCount: 0,
    },
  ]);
});

test("shell function call을 실시간 도구 상태로 변환한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const activities = [];
  watcher.on("tool-activity", (activity) => activities.push(activity));

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "npm test" }),
      },
    })
  );

  assert.equal(activities.length, 1);
  assert.equal(activities[0].kind, "test");
  assert.equal(activities[0].threadId, THREAD_ID);
});

test("동시 작업 중 먼저 끝난 세션의 thread id를 유지한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondThreadId = "019f4a31-1111-7222-8333-444444444444";
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, secondThreadId);
  const finished = [];
  watcher.on("task-finished", (result) => finished.push(result));

  for (const filePath of [ROLLOUT_PATH, secondPath]) {
    watcher.handleLine(
      filePath,
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })
    );
  }

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  );

  assert.equal(finished[0].threadId, THREAD_ID);
  assert.equal(finished[0].otherTasksWorking, true);
  assert.equal(watcher.working, true);
});

test("구조화된 사용자 입력 요청을 대기 상태로 변환한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const waiting = [];
  watcher.on("waiting", (state) => waiting.push(state));

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "request_user_input", input: "{}" },
    })
  );

  assert.deepEqual(waiting, [{ kind: "user-input", threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1 }]);
});

test("허용된 rollout 모델만 작업자 이름으로 정규화한다", () => {
  assert.equal(normalizeWorkerLabel("gpt-5.6-sol"), "Sol");
  assert.equal(normalizeWorkerLabel("gpt-5.6-terra"), "Terra");
  assert.equal(normalizeWorkerLabel("gpt-5.6-luna"), "Luna");
  assert.equal(normalizeWorkerLabel("gpt-5.6-sol-preview"), null);
  assert.equal(normalizeWorkerLabel("gpt-4.1"), null);
  assert.equal(normalizeWorkerLabel(null), null);
});

test("동시 rollout은 각자의 작업자 이름과 활성 수를 유지한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const messages = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, context }));

  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-terra" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "a" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "b" } }));

  assert.deepEqual(messages.map((item) => item.context), [
    { threadId: THREAD_ID, workerLabel: "Terra", activeTaskCount: 2 },
    { threadId: "019f4a31-1111-7222-8333-444444444444", workerLabel: "Luna", activeTaskCount: 2 },
  ]);
});

test("작업 시작은 파일별로 멱등이고 완료와 중단에서 활성 수를 줄인다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  assert.equal(watcher.workingFiles.size, 2);
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));
  assert.equal(watcher.workingFiles.size, 1);
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }));
  assert.equal(watcher.workingFiles.size, 0);
});

test("오래된 작업은 stale 처리에서 활성 수를 0으로 되돌린다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const changes = [];
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.setWorking(ROLLOUT_PATH);
  watcher.lastEventAtByFile.set(ROLLOUT_PATH, 0);
  watcher.listRecentRolloutFiles = () => [];
  watcher.poll();

  assert.equal(watcher.workingFiles.size, 0);
  assert.deepEqual(changes.at(-1), {
    working: false,
    context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 0, activityChange: "removed" },
  });
});

test("동시 작업 하나만 stale이면 그 파일만 활성 수에서 제거한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const changes = [];
  watcher.workerLabels.set(ROLLOUT_PATH, "Terra");
  watcher.workerLabels.set(secondPath, "Luna");
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.setWorking(ROLLOUT_PATH);
  watcher.setWorking(secondPath);
  watcher.lastEventAtByFile.set(ROLLOUT_PATH, 0);
  watcher.listRecentRolloutFiles = () => [];
  watcher.poll();

  assert.equal(watcher.workingFiles.size, 1);
  assert.equal(watcher.workingFiles.has(secondPath), true);
  assert.equal(watcher.workerLabels.has(ROLLOUT_PATH), false);
  assert.equal(watcher.workerLabels.get(secondPath), "Luna");
  assert.deepEqual(changes.at(-1), {
    working: true,
    context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1, activityChange: "removed" },
  });
});

test("첫 poll에서 이미 실행 중인 여러 rollout의 작업자와 활성 수를 복원한다", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-watcher-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const secondThreadId = "019f4a31-1111-7222-8333-444444444444";
  const firstPath = path.join(tempDir, `rollout-test-${THREAD_ID}.jsonl`);
  const secondPath = path.join(tempDir, `rollout-test-${secondThreadId}.jsonl`);

  for (const [filePath, model, timestamp] of [
    [firstPath, "gpt-5.6-terra", "2026-07-10T13:02:30.000Z"],
    [secondPath, "gpt-5.6-luna", "2026-07-10T13:02:10.000Z"],
  ]) {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ type: "turn_context", payload: { model } })}\n${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "task_started" },
      })}\n`,
      "utf8"
    );
  }

  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const restored = [];
  watcher.on("working-changed", (working, _result, context) => {
    if (working && context?.activityChange === "started") restored.push(context);
  });
  watcher.listRecentRolloutFiles = () => [firstPath, secondPath].map((filePath) => {
    const stat = fs.statSync(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  watcher.poll();

  assert.equal(watcher.workingFiles.size, 2);
  assert.equal(watcher.workerLabels.get(firstPath), "Terra");
  assert.equal(watcher.workerLabels.get(secondPath), "Luna");
  // 목록 입력은 최신순(first, second)이므로 복원 이벤트는 오래된 second부터, 최신 first가 마지막입니다.
  assert.deepEqual(restored.map((context) => context.threadId), [secondThreadId, THREAD_ID]);
  assert.deepEqual(restored.map((context) => context.taskStartedAt), [
    "2026-07-10T13:02:10.000Z",
    "2026-07-10T13:02:30.000Z",
  ]);
});

test("두 번째 작업 시작은 즉시 활성 수 변경 문맥을 발행한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const changes = [];
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  assert.deepEqual(changes, [
    { working: true, context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1, activityChange: "started" } },
    { working: true, context: { threadId: "019f4a31-1111-7222-8333-444444444444", workerLabel: null, activeTaskCount: 2, activityChange: "started" } },
  ]);
});

test("활동 제목은 작업자와 상태만 표시하고 작업 수는 행에 반복하지 않는다", () => {
  assert.equal(formatActivityTitle("작업 중", { workerLabel: "Terra", activeTaskCount: 1 }), "Terra · 작업 중");
  assert.equal(formatActivityTitle("작업 중", { activeTaskCount: 3 }), "작업 중");
  assert.equal(formatActivityTitle("작업 중", { workerLabel: "Terra", activeTaskCount: 3 }), "Terra · 작업 중");
  assert.equal(formatActivityTitle("작업 중", { workerLabel: "Terra", activeTaskCount: 0 }), "Terra · 작업 중");
  assert.equal(formatActivityTitle("작업 중", { activeTaskCount: 1 }), "작업 중");
});

test("runtime task_started의 구조화 timestamp를 작업 문맥에 전달한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const changes = [];
  watcher.on("working-changed", (_working, _result, context) => changes.push(context));
  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      timestamp: "2026-07-10T13:02:17.000Z",
      type: "event_msg",
      payload: { type: "task_started" },
    })
  );
  assert.equal(changes[0].taskStartedAt, "2026-07-10T13:02:17.000Z");
});

test("동시 작업 하나가 끝나면 완료 작업자 이름을 남은 작업 문맥에 재사용하지 않는다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const changes = [];
  const finished = [];
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.on("task-finished", (result) => finished.push(result));

  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-terra" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));

  assert.deepEqual(changes.at(-1), {
    working: true,
    context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1, activityChange: "removed" },
  });
  assert.equal(finished.at(-1).workerLabel, "Terra");
  assert.equal(finished.at(-1).activeTaskCount, 1);
  assert.equal(watcher.workerLabels.has(ROLLOUT_PATH), false);
  assert.equal(watcher.workerLabels.get(secondPath), "Luna");
});
