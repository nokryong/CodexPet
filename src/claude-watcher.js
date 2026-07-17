const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const { ExternalWatcher, recursiveJsonl, text } = require("./external-watcher");

function serializeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  return text(input.command || input.file_path || input.path || input.pattern || input.query || "", 220);
}

function claudeEventId(row) {
  const payload = JSON.stringify({
    uuid: row.uuid,
    timestamp: row.timestamp,
    type: row.type,
    stop: row.message?.stop_reason,
    content: row.message?.content,
  });
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

function parseClaudeRow(row, file = "") {
  const message = row.message || {};
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  const tool = content.find((part) => part && part.type === "tool_use");
  const visibleText = content
    .filter(
      (part) =>
        typeof part === "string" ||
        part?.type === "text" ||
        (!part?.type && typeof part?.text === "string")
    )
    .map((part) => (typeof part === "string" ? part : part.text || ""))
    .filter(Boolean)
    .join(" ");
  const isToolResult =
    row.type === "user" && content.length > 0 && content.every((part) => part?.type === "tool_result");

  let type = null;
  let visible = visibleText;
  let kind = null;
  if (row.type === "user" && !isToolResult && visible) type = "user";
  else if (tool) {
    type = "tool";
    const detail = serializeToolInput(tool.input);
    visible = [tool.name, detail].filter(Boolean).join(": ");
    kind = /write|edit|patch/i.test(tool.name || "")
      ? "patch"
      : /grep|search|glob/i.test(tool.name || "")
        ? "search"
        : "command";
  } else if (row.type === "assistant" && visible) {
    type = "assistant";
  }

  return {
    sessionId: row.sessionId || row.session_id || path.basename(file, path.extname(file)),
    eventId: type ? claudeEventId(row) : null,
    cwd: row.cwd || null,
    text: text(visible),
    type,
    kind,
    // thinking-only end_turn 뒤에 실제 text end_turn이 한 줄 더 오는 경우가 있어, 보이는 응답에서만 종료합니다.
    finished: type === "assistant" && message.stop_reason === "end_turn" && Boolean(visible),
  };
}

class ClaudeWatcher extends ExternalWatcher {
  constructor(options = {}) {
    // Windows 데스크톱 앱의 Claude Code 세션 저장소입니다.
    // macOS 데스크톱 앱의 세션 transcript는 ~/.claude/projects에 .jsonl로 함께 기록되므로
    // 아래 첫 번째 root에서 이미 잡힙니다. (Application Support 쪽은 .json 상태 파일이라
    // recursiveJsonl과 형식이 달라 별도 root로 추가하지 않습니다.)
    const appDataRoot = process.env.APPDATA
      ? path.join(process.env.APPDATA, "Claude", "claude-code-sessions")
      : null;
    super({
      provider: "claude",
      roots: options.roots || [path.join(os.homedir(), ".claude", "projects"), appDataRoot],
      findFiles: recursiveJsonl,
      parseRow: parseClaudeRow,
      quietMs: 12000,
      ...options,
    });
  }
}

module.exports = { ClaudeWatcher, parseClaudeRow, serializeToolInput };
