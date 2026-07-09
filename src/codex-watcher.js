const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Codex CLI는 모든 세션 이벤트를 CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl에 실시간으로 append합니다.
// 이 모듈은 최근 rollout 파일들을 tail해서 작업 상태/메시지/사용량(rate_limits)을 이벤트로 발행합니다.
// Codex 세션이 동시에 여러 개 돌아갈 수 있으므로 파일 하나가 아니라 최근 파일 여러 개를
// 각자의 오프셋으로 추적합니다.
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const DEFAULT_SESSIONS_DIR = path.join(DEFAULT_CODEX_HOME, "sessions");

const WATCHER_CONFIG = Object.freeze({
  // 파일 크기 변화를 확인하는 주기입니다. 너무 짧으면 IO 낭비, 너무 길면 말풍선 반응이 늦어집니다.
  pollMs: 1500,
  // 사용량/초기 작업 상태를 찾을 때 파일 끝에서 읽을 최대 바이트입니다.
  usageScanBytes: 512 * 1024,
  // 최근 파일에 token_count가 없으면 이전 파일까지 몇 개를 거슬러 올라갈지 정합니다.
  usageScanFiles: 5,
  // Codex Desktop/CLI의 구조화 로그에는 최신 websocket rate limit 이벤트가 들어갑니다.
  // 더블클릭 사용량 조회는 이 로그를 우선 스캔해서 세션 JSONL 캐시보다 최신 값을 가져옵니다.
  logUsageScanBytes: 32 * 1024 * 1024,
  logUsageFiles: ["logs_2.sqlite-wal", "logs_2.sqlite"],
  // Codex Desktop은 오래전에 만든 thread를 오늘 다시 이어도 원래 생성일 폴더에 계속 append합니다.
  // 그래서 "최근 날짜 폴더 N개"만 보면 현재 대화를 놓칠 수 있습니다. day 폴더는 전부 훑고,
  // 실제 tail 대상은 rollout 파일의 수정 시각(mtime) 기준 최신 N개만 고릅니다.
  maxDayDirsToScan: 180,
  // 동시에 tail할 최근 파일 수입니다. 동시 세션이 이보다 많으면 오래된 세션은 놓칠 수 있습니다.
  tailFiles: 5,
  // 작업 중 표시가 이 시간 동안 아무 이벤트 없이 유지되면 Codex가 죽었다고 보고 해제합니다.
  // 정상 작업 중에는 token_count가 주기적으로 기록되므로 이 시간을 넘길 일이 없습니다.
  staleWorkingMs: 5 * 60 * 1000,
});

// Codex 버전에 따라 reset_at 또는 resets_at으로 필드명이 다를 수 있어 둘 다 같은 값으로 맞춥니다.
function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;

  const resetAt = Number(window.resets_at ?? window.reset_at);

  return {
    ...window,
    reset_at: Number.isFinite(resetAt) ? resetAt : window.reset_at,
    resets_at: Number.isFinite(resetAt) ? resetAt : window.resets_at,
  };
}

// token_count payload와 websocket codex.rate_limits payload의 모양이 달라서
// 화면에서 쓰는 { primary, secondary, plan_type } 형태로 통일합니다.
function normalizeUsage(rateLimits, recordedAt = null, source = "sessions") {
  if (!rateLimits || typeof rateLimits !== "object") return null;

  const envelope = rateLimits.rate_limits ? rateLimits : null;
  const limits = envelope ? envelope.rate_limits : rateLimits;

  if (!limits || typeof limits !== "object") return null;

  return {
    rateLimits: {
      ...limits,
      plan_type: limits.plan_type || envelope?.plan_type || rateLimits.plan_type || null,
      primary: normalizeRateLimitWindow(limits.primary),
      secondary: normalizeRateLimitWindow(limits.secondary),
    },
    recordedAt,
    source,
  };
}

// sessions/YYYY/MM/DD 구조에서 day 폴더를 찾습니다.
// 폴더명 날짜가 아니라 rollout 파일 수정 시각이 "현재 활성 대화"를 가리키므로,
// 여기서는 넓게 모으고 listRecentRolloutFiles()에서 mtime 기준으로 다시 자릅니다.
function listSessionDayDirs(limit = WATCHER_CONFIG.maxDayDirsToScan, sessionsDir = DEFAULT_SESSIONS_DIR) {
  const dayDirs = [];

  let years;
  try {
    years = fs.readdirSync(sessionsDir).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  } catch {
    return dayDirs;
  }

  for (const year of years) {
    const yearPath = path.join(sessionsDir, year);
    let months;
    try {
      months = fs.readdirSync(yearPath).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    } catch {
      continue;
    }

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      let days;
      try {
        days = fs.readdirSync(monthPath).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
      } catch {
        continue;
      }

      for (const day of days) {
        dayDirs.push(path.join(monthPath, day));
        if (dayDirs.length >= limit) return dayDirs;
      }
    }
  }

  return dayDirs;
}

// day 폴더들에서 rollout 파일을 수정 시각 내림차순으로 모아 돌려줍니다.
// 오래된 thread가 오늘 append되는 경우 폴더명은 오래됐지만 mtime은 최신이므로 반드시 mtime을 기준으로 합니다.
function listRecentRolloutFiles(limit, sessionsDir = DEFAULT_SESSIONS_DIR) {
  const files = [];

  for (const dayDir of listSessionDayDirs(WATCHER_CONFIG.maxDayDirsToScan, sessionsDir)) {
    let names;
    try {
      names = fs.readdirSync(dayDir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;

      const filePath = path.join(dayDir, name);
      try {
        const stat = fs.statSync(filePath);
        files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // 파일이 방금 지워졌을 수 있으므로 무시하고 계속 진행합니다.
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}

// 파일 끝에서 usageScanBytes만 읽어 줄 단위로 돌려줍니다. 뒤에서부터 스캔하는 용도입니다.
function readTailLines(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }

  try {
    const size = fs.fstatSync(fd).size;
    const readBytes = Math.min(size, WATCHER_CONFIG.usageScanBytes);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
    return buffer.toString("utf8").split("\n");
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// 한 파일에서 마지막 token_count 이벤트의 rate_limits를 찾아냅니다.
function extractUsageFromFile(filePath) {
  const lines = readTailLines(filePath);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"rate_limits"')) continue;

    try {
      const entry = JSON.parse(lines[i]);
      const payload = entry?.payload;
      if (payload?.type === "token_count" && payload.rate_limits) {
        return normalizeUsage(payload.rate_limits, entry.timestamp || null, "sessions");
      }
    } catch {
      // 잘린 줄이거나 다른 형식이면 다음 줄을 계속 확인합니다.
    }
  }
  return null;
}

// 문자열 안의 JSON 객체 하나를 중괄호 균형으로 잘라냅니다.
// sqlite 로그 파일은 바이너리 데이터 사이에 plain text 로그가 섞여 있어서 줄 단위 JSON 파싱을 할 수 없습니다.
function extractJsonObjectAt(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

// sqlite/wal 텍스트 조각에서 가장 뒤에 있는 codex.rate_limits 이벤트를 찾습니다.
function extractUsageFromLogText(text, recordedAt, source) {
  let fromIndex = text.length;
  const marker = "{\"type\":\"codex.rate_limits\"";

  while (fromIndex > 0) {
    const startIndex = text.lastIndexOf(marker, fromIndex);
    if (startIndex < 0) return null;

    const jsonText = extractJsonObjectAt(text, startIndex);
    if (jsonText) {
      try {
        const event = JSON.parse(jsonText);
        const usage = normalizeUsage(event, recordedAt, source);
        if (usage?.rateLimits?.primary || usage?.rateLimits?.secondary) {
          return usage;
        }
      } catch {
        // 잘린 이벤트면 앞쪽 이벤트를 계속 찾습니다.
      }
    }

    fromIndex = startIndex;
  }

  return null;
}

// Codex 구조화 로그 파일의 끝부분에서 최신 rate limit 이벤트를 읽습니다.
function extractUsageFromLogFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  try {
    const stat = fs.fstatSync(fd);
    const readBytes = Math.min(stat.size, WATCHER_CONFIG.logUsageScanBytes);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);

    return extractUsageFromLogText(
      buffer.toString("utf8"),
      new Date(stat.mtimeMs).toISOString(),
      path.basename(filePath)
    );
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// wal이 있으면 보통 sqlite 본문보다 최신입니다. 그래도 수정 시각 내림차순으로 확인합니다.
function extractLatestUsageFromLogs() {
  const files = WATCHER_CONFIG.logUsageFiles
    .map((name) => path.join(DEFAULT_CODEX_HOME, name))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files) {
    const usage = extractUsageFromLogFile(file.filePath);
    if (usage) return usage;
  }

  return null;
}

function extractLatestUsageFromSessions() {
  const recentFiles = listRecentRolloutFiles(WATCHER_CONFIG.usageScanFiles);
  for (const file of recentFiles) {
    const usage = extractUsageFromFile(file.filePath);
    if (usage) return usage;
  }

  return null;
}

// 파일 끝부분에서 마지막 작업 상태 이벤트를 찾아, 파일이 "작업 중" 상태로 끝나 있는지 판단합니다.
// 앱 시작 시점에 Codex가 이미 작업 중이면 이 함수로 초기 상태를 복원합니다.
function detectWorkingFromFile(filePath) {
  const lines = readTailLines(filePath);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const isStart =
      line.includes('"task_started"') ||
      line.includes('"user_message"') ||
      line.includes('"agent_message"') ||
      line.includes('"token_count"') ||
      line.includes('"patch_apply_end"') ||
      line.includes('"web_search_end"') ||
      line.includes('"image_generation_end"');
    const isEnd = line.includes('"task_complete"') || line.includes('"turn_aborted"');
    if (!isStart && !isEnd) continue;

    try {
      const entry = JSON.parse(line);
      const payloadType = entry?.payload?.type;
      if (payloadType === "task_started") return true;
      if (
        payloadType === "user_message" ||
        payloadType === "agent_message" ||
        payloadType === "token_count" ||
        payloadType === "patch_apply_end" ||
        payloadType === "web_search_end" ||
        payloadType === "image_generation_end"
      ) {
        return true;
      }
      if (payloadType === "task_complete" || payloadType === "turn_aborted") return false;
    } catch {
      // 잘린 줄이면 다음 줄을 계속 확인합니다.
    }
  }
  return false;
}

// 계정 전환/로그인 실험 중 CODEX_HOME이 여러 곳으로 갈라진 상태에서도 작업 말풍선을 놓치지 않게
// 기본 ~/.codex 외에 ~/.codex2, ~/.codepet/codex-switch/profiles/* 같은 sessions 폴더도 감시합니다.
function discoverDefaultCodexHomes() {
  const homes = [DEFAULT_CODEX_HOME];
  const userHome = os.homedir();

  try {
    for (const entry of fs.readdirSync(userHome, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.codex\d+$/.test(entry.name)) {
        homes.push(path.join(userHome, entry.name));
      }
    }
  } catch {
    // 홈 디렉터리 열람 실패 시 기본 ~/.codex만 사용합니다.
  }

  const profileRoots = [
    path.join(userHome, ".codepet", "codex-switch", "profiles"),
    path.join(userHome, ".cdx", "profiles"),
  ];

  for (const root of profileRoots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          homes.push(path.join(root, entry.name));
        }
      }
    } catch {
      // 해당 도구를 쓰지 않는 환경이면 폴더가 없는 것이 정상입니다.
    }
  }

  return homes;
}

// Codex 세션 로그를 감시하는 EventEmitter입니다.
// 발행 이벤트:
//  - "working-changed" (isWorking, result)  : 작업 시작/종료. result는 { reason, message } 또는 null
//  - "agent-message" (message)              : Codex가 사용자에게 보낸 메시지
//  - "user-message" (message)               : 사용자가 Codex에 보낸 요청
//  - "tool-activity" (activity)             : 파일 수정/웹 검색/이미지 생성 등 도구 사용
//  - "usage-updated" (usage)                : rate_limits 갱신
class CodexWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    // 계정 전환 뒤에도 새 CODEX_HOME의 sessions를 감시할 수 있게 main.js에서 동적으로 주입합니다.
    this.getCodexHomes =
      typeof options.getCodexHomes === "function"
        ? options.getCodexHomes
        : discoverDefaultCodexHomes;
    this.pollTimer = null;
    // filePath -> { offset, buffer } : 파일별 읽기 위치입니다.
    // 동시 세션이 번갈아 기록해도 각 파일을 이어서 읽을 수 있습니다.
    this.tails = new Map();
    // 현재 task_started 상태인 파일들입니다. 하나라도 있으면 "작업 중"으로 봅니다.
    this.workingFiles = new Set();
    this.lastEventAtMs = 0;
    this.firstPoll = true;
    this.cachedUsage = null;
  }

  get working() {
    return this.workingFiles.size > 0;
  }

  start() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), WATCHER_CONFIG.pollMs);
    this.poll();
  }

  stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // active 프로필과 발견된 프로필들의 sessions 폴더를 모읍니다.
  // 같은 경로가 여러 번 들어오면 파일 tail 상태가 꼬일 수 있으므로 소문자 절대경로로 중복 제거합니다.
  getSessionDirs() {
    let homes;
    try {
      homes = this.getCodexHomes();
    } catch {
      homes = [DEFAULT_CODEX_HOME];
    }

    const byPath = new Map();
    for (const homePath of Array.isArray(homes) ? homes : []) {
      if (!homePath) continue;
      const sessionsDir = path.join(homePath, "sessions");
      byPath.set(path.resolve(sessionsDir).toLowerCase(), sessionsDir);
    }

    if (byPath.size === 0) {
      byPath.set(path.resolve(DEFAULT_SESSIONS_DIR).toLowerCase(), DEFAULT_SESSIONS_DIR);
    }

    return [...byPath.values()];
  }

  // 모든 CODEX_HOME의 최근 rollout을 합친 뒤 최신 순서로 tail 대상만 고릅니다.
  listRecentRolloutFiles(limit) {
    const files = [];
    for (const sessionsDir of this.getSessionDirs()) {
      files.push(...listRecentRolloutFiles(limit, sessionsDir));
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, limit);
  }

  // tail 중 캐시된 값이 있으면 그대로 쓰고,
  // 없으면(앱 시작 직후 등) 최근 로그/세션 파일들을 뒤에서부터 스캔합니다.
  getUsage() {
    if (this.cachedUsage) return this.cachedUsage;
    return this.refreshUsage();
  }

  // 더블클릭 사용량 조회용입니다.
  // 캐시를 무시하고 Codex sqlite/wal 로그를 먼저 다시 스캔한 뒤, 없으면 세션 JSONL을 스캔합니다.
  refreshUsage() {
    const usage = extractLatestUsageFromLogs() || extractLatestUsageFromSessions();

    if (usage) {
      this.cachedUsage = usage;
      return usage;
    }

    return null;
  }

  poll() {
    const recentFiles = this.listRecentRolloutFiles(WATCHER_CONFIG.tailFiles);
    const recentPaths = new Set(recentFiles.map((f) => f.filePath));

    // 최근 목록에서 밀려난 파일은 추적을 정리합니다.
    for (const filePath of [...this.tails.keys()]) {
      if (!recentPaths.has(filePath)) {
        this.tails.delete(filePath);
        this.clearWorking(filePath, { reason: "stale", message: null });
      }
    }

    for (const file of recentFiles) {
      let tail = this.tails.get(file.filePath);

      if (!tail) {
        // 처음 보는 파일: 앱 시작 시점에 이미 있던 파일은 과거 기록을 재생하지 않도록
        // 끝에서 시작하고, 실행 중 새로 생긴 세션 파일은 처음부터 읽습니다.
        tail = { offset: this.firstPoll ? file.size : 0, buffer: "" };
        this.tails.set(file.filePath, tail);

        // 앱 시작 시점에 가장 최근 파일이 "작업 중" 상태로 끝나 있고
        // 방금까지 기록 중이었다면 작업 중 상태를 복원합니다.
        if (
          this.firstPoll &&
          file.filePath === recentFiles[0].filePath &&
          Date.now() - file.mtimeMs < WATCHER_CONFIG.staleWorkingMs &&
          detectWorkingFromFile(file.filePath)
        ) {
          this.lastEventAtMs = Date.now();
          this.setWorking(file.filePath);
        }
      }

      // 파일이 줄어들었다면(비정상 케이스) 처음부터 다시 읽습니다.
      if (file.size < tail.offset) {
        tail.offset = 0;
        tail.buffer = "";
      }

      if (file.size > tail.offset) {
        this.readAppended(file.filePath, tail, file.size);
      }
    }

    this.firstPoll = false;

    // 작업 중인데 오랫동안 아무 이벤트가 없으면 Codex가 비정상 종료된 것으로 보고 해제합니다.
    if (this.working && Date.now() - this.lastEventAtMs > WATCHER_CONFIG.staleWorkingMs) {
      this.workingFiles.clear();
      this.emit("working-changed", false, { reason: "stale", message: null });
    }
  }

  readAppended(filePath, tail, currentSize) {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return;
    }

    try {
      const chunkSize = currentSize - tail.offset;
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, tail.offset);
      tail.offset += bytesRead;

      tail.buffer += buffer.toString("utf8", 0, bytesRead);
      const lines = tail.buffer.split("\n");
      tail.buffer = lines.pop(); // 마지막 조각은 아직 안 끝난 줄일 수 있으므로 버퍼에 남깁니다.

      for (const line of lines) {
        this.handleLine(filePath, line);
      }
    } catch (error) {
      console.warn("[desktop-pet] Codex session read failed.", error.message);
    } finally {
      fs.closeSync(fd);
    }
  }

  // 파일 하나가 작업을 시작/종료했을 때 전체 작업 상태(working)의 전환 시점에만 이벤트를 발행합니다.
  setWorking(filePath) {
    const wasWorking = this.working;
    this.workingFiles.add(filePath);
    if (!wasWorking) {
      this.emit("working-changed", true, null);
    }
  }

  clearWorking(filePath, result) {
    if (!this.workingFiles.delete(filePath)) return;
    if (!this.working) {
      this.emit("working-changed", false, result);
    }
  }

  handleLine(filePath, line) {
    if (!line.trim()) return;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    if (entry?.type !== "event_msg") return;
    const payload = entry.payload;
    if (!payload?.type) return;

    this.lastEventAtMs = Date.now();

    switch (payload.type) {
      case "task_started":
        this.setWorking(filePath);
        break;

      case "task_complete":
        this.clearWorking(filePath, {
          reason: "complete",
          message: payload.last_agent_message || null,
        });
        break;

      case "turn_aborted":
        this.clearWorking(filePath, { reason: "aborted", message: null });
        break;

      case "agent_message":
        this.setWorking(filePath);
        if (payload.message) {
          this.emit("agent-message", payload.message);
        }
        break;

      case "user_message":
        this.setWorking(filePath);
        if (payload.message) {
          this.emit("user-message", payload.message);
        }
        break;

      case "patch_apply_end": {
        this.setWorking(filePath);
        // changes의 key가 수정된 파일의 절대 경로입니다. 파일명만 추려서 보냅니다.
        const files = Object.keys(payload.changes || {}).map((p) => path.basename(p));
        if (files.length > 0) {
          this.emit("tool-activity", { kind: "patch", files, success: payload.success !== false });
        }
        break;
      }

      case "web_search_end":
        this.setWorking(filePath);
        this.emit("tool-activity", { kind: "search", query: payload.query || null });
        break;

      case "image_generation_end":
        this.setWorking(filePath);
        this.emit("tool-activity", { kind: "image" });
        break;

      case "token_count":
        this.setWorking(filePath);
        if (payload.rate_limits) {
          this.cachedUsage = normalizeUsage(
            payload.rate_limits,
            entry.timestamp || null,
            "sessions-tail"
          );
          this.emit("usage-updated", this.cachedUsage);
        }
        break;

      default:
        break;
    }
  }
}

module.exports = { CodexWatcher };
