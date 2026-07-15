const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExternalWatcher } = require("../src/external-watcher");
const { parseAntigravityRow } = require("../src/antigravity-watcher");
const { parseClaudeRow } = require("../src/claude-watcher");

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-watcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("AGY는 thinking을 노출하지 않고 단계 DONE을 전체 완료로 오인하지 않는다", () => {
  const file = "C:\\brain\\session-1\\.system_generated\\logs\\transcript.jsonl";
  const tool = parseAntigravityRow(
    {
      step_index: 1,
      type: "RUN_COMMAND",
      status: "DONE",
      created_at: "2026-01-01T00:00:00Z",
      content: "npm test",
      thinking: "보이면 안 됨",
    },
    file
  );
  const response = parseAntigravityRow(
    {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-01-01T00:00:01Z",
      content: "진행 중",
    },
    file
  );
  assert.equal(tool.type, "tool");
  assert.equal(tool.text, "npm test");
  assert.equal(tool.finished, false);
  assert.equal(response.type, "assistant");
  assert.equal(response.finished, false);
});

test("Claude는 tool_result와 thinking-only 행을 숨기고 보이는 end_turn에서 완료한다", () => {
  const tool = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: {
      content: [{ type: "tool_use", name: "Read", input: { file_path: "C:\\work\\app.js" } }],
      stop_reason: "tool_use",
    },
  });
  const toolResult = parseClaudeRow({
    type: "user",
    sessionId: "session-1",
    message: { content: [{ type: "tool_result", content: "result" }] },
  });
  const thinkingOnly = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: { content: [{ type: "thinking", thinking: "hidden" }], stop_reason: "end_turn" },
  });
  const complete = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: { content: [{ type: "text", text: "완료" }], stop_reason: "end_turn" },
  });

  assert.equal(tool.type, "tool");
  assert.match(tool.text, /Read: C:\\work\\app\.js/);
  assert.equal(toolResult.type, null);
  assert.equal(thinkingOnly.type, null);
  assert.equal(thinkingOnly.finished, false);
  assert.equal(complete.type, "assistant");
  assert.equal(complete.finished, true);
});

test("EOF watcher는 시작 전 기록은 건너뛰고 새 파일의 첫 한글 이벤트부터 읽는다", (t) => {
  const root = tempDir(t);
  const existing = path.join(root, "existing.jsonl");
  fs.writeFileSync(existing, `${JSON.stringify({ id: "old", sessionId: "s", type: "user", text: "과거" })}\n`);
  const watcher = new ExternalWatcher({
    provider: "test",
    roots: [root],
    findFiles: (directory) =>
      fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(directory, name)),
    parseRow: (row) => row,
    quietMs: 60_000,
  });
  const messages = [];
  watcher.on("user-message", (message) => messages.push(message));
  watcher.seed();

  fs.appendFileSync(
    existing,
    `${JSON.stringify({ id: "new-1", sessionId: "s", type: "user", text: "한글 요청" })}\n`
  );
  const created = path.join(root, "created.jsonl");
  fs.writeFileSync(
    created,
    `${JSON.stringify({ id: "new-2", sessionId: "n", type: "user", text: "첫 이벤트" })}\n`
  );
  watcher.poll();

  assert.deepEqual(messages.sort((left, right) => left.localeCompare(right, "ko")), ["첫 이벤트", "한글 요청"]);
  assert.equal(watcher.offsets.get(existing), fs.statSync(existing).size);
  assert.equal(watcher.offsets.get(created), fs.statSync(created).size);
});

test("같은 provider 이벤트 id가 반복 기록돼도 한 번만 발행한다", (t) => {
  const root = tempDir(t);
  const file = path.join(root, "events.jsonl");
  fs.writeFileSync(file, "");
  const watcher = new ExternalWatcher({
    provider: "test",
    roots: [root],
    findFiles: () => [file],
    parseRow: (row) => row,
    quietMs: 60_000,
  });
  let count = 0;
  watcher.on("agent-message", () => {
    count += 1;
  });
  watcher.seed();
  const row = JSON.stringify({ id: "same", eventId: "same", sessionId: "s", type: "assistant", text: "응답" });
  fs.appendFileSync(file, `${row}\n${row}\n`);
  watcher.poll();
  assert.equal(count, 1);
});
