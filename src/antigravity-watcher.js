const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const { ExternalWatcher, recursiveJsonl, text } = require("./external-watcher");

function rowId(row) {
  return crypto
    .createHash("sha1")
    .update([row.step_index, row.type, row.status, row.created_at, row.content].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

function extractCwd(value) {
  const source = String(value || "");
  const windowsMatch = source.match(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+/);
  if (windowsMatch) return windowsMatch[0].replace(/[.,;:)\]}]+$/, "");
  // macOS/리눅스 절대 경로도 표시용 cwd로 사용합니다.
  const unixMatch = source.match(/(?:^|[\s"'`(])(\/(?:Users|home|opt|var|tmp|private)\/[^\s"'`):\]]+)/);
  return unixMatch ? unixMatch[1].replace(/[.,;:)\]}]+$/, "") : null;
}

function toolLabel(type, content) {
  const value = text(content);
  if (type === "VIEW_FILE") return value || "파일 확인";
  if (type === "GREP_SEARCH") return value || "코드 검색";
  if (type === "LIST_DIRECTORY") return value || "폴더 확인";
  if (type === "CODE_ACTION") return value || "파일 수정";
  return value || "명령 실행";
}

function parseAntigravityRow(row, file) {
  const sessionId = path.basename(path.dirname(path.dirname(path.dirname(file)))) || "unknown";
  const sourceType = String(row.type || "");
  const visible = text(row.content);
  let type = null;
  let kind = null;

  if (sourceType === "USER_INPUT") type = "user";
  else if (sourceType === "PLANNER_RESPONSE" && visible) type = "assistant";
  else if (/RUN_COMMAND|CODE_ACTION|VIEW_FILE|GREP_SEARCH|LIST_DIRECTORY/.test(sourceType)) {
    type = "tool";
    kind = sourceType === "CODE_ACTION" ? "patch" : sourceType.includes("SEARCH") ? "search" : "command";
  }

  return {
    sessionId,
    eventId: rowId(row),
    cwd: extractCwd(visible),
    text: type === "tool" ? toolLabel(sourceType, visible) : visible,
    type,
    kind,
    // AGY의 DONE은 전체 대화가 아니라 각 단계의 완료 상태입니다. 최종 완료는 quiet-time으로 판정합니다.
    finished: false,
  };
}

class AntigravityWatcher extends ExternalWatcher {
  constructor(options = {}) {
    super({
      provider: "agy",
      roots: options.roots || [path.join(os.homedir(), ".gemini", "antigravity", "brain")],
      findFiles: (root) => recursiveJsonl(root).filter((file) => file.endsWith("transcript.jsonl")),
      parseRow: parseAntigravityRow,
      quietMs: 15000,
      ...options,
    });
  }
}

module.exports = { AntigravityWatcher, parseAntigravityRow, extractCwd };
