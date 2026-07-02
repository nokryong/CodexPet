const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Codex CLI는 모든 세션 이벤트를 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl에 실시간으로 append합니다.
// 이 모듈은 최근 rollout 파일들을 tail해서 작업 상태/메시지/사용량(rate_limits)을 이벤트로 발행합니다.
// Codex 세션이 동시에 여러 개 돌아갈 수 있으므로 파일 하나가 아니라 최근 파일 여러 개를
// 각자의 오프셋으로 추적합니다.
const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

const WATCHER_CONFIG = Object.freeze({
  // 파일 크기 변화를 확인하는 주기입니다. 너무 짧으면 IO 낭비, 너무 길면 말풍선 반응이 늦어집니다.
  pollMs: 1500,
  // 사용량/초기 작업 상태를 찾을 때 파일 끝에서 읽을 최대 바이트입니다.
  usageScanBytes: 512 * 1024,
  // 최근 파일에 token_count가 없으면 이전 파일까지 몇 개를 거슬러 올라갈지 정합니다.
  usageScanFiles: 5,
  // 최근 며칠치 날짜 폴더에서 rollout 파일을 찾을지 정합니다.
  recentDayDirs: 3,
  // 동시에 tail할 최근 파일 수입니다. 동시 세션이 이보다 많으면 오래된 세션은 놓칠 수 있습니다.
  tailFiles: 5,
  // 작업 중 표시가 이 시간 동안 아무 이벤트 없이 유지되면 Codex가 죽었다고 보고 해제합니다.
  // 정상 작업 중에는 token_count가 주기적으로 기록되므로 이 시간을 넘길 일이 없습니다.
  staleWorkingMs: 5 * 60 * 1000,
});

// sessions/YYYY/MM/DD 구조에서 최신 날짜 폴더 몇 개를 내림차순으로 돌려줍니다.
function listRecentDayDirs(limit) {
  const dayDirs = [];

  let years;
  try {
    years = fs.readdirSync(SESSIONS_DIR).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  } catch {
    return dayDirs;
  }

  for (const year of years) {
    const yearPath = path.join(SESSIONS_DIR, year);
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

// 최근 날짜 폴더들에서 rollout 파일을 수정 시각 내림차순으로 모아 돌려줍니다.
function listRecentRolloutFiles(limit) {
  const files = [];

  for (const dayDir of listRecentDayDirs(WATCHER_CONFIG.recentDayDirs)) {
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
        return { rateLimits: payload.rate_limits, recordedAt: entry.timestamp || null };
      }
    } catch {
      // 잘린 줄이거나 다른 형식이면 다음 줄을 계속 확인합니다.
    }
  }
  return null;
}

// 파일 끝부분에서 마지막 작업 상태 이벤트를 찾아, 파일이 "작업 중" 상태로 끝나 있는지 판단합니다.
// 앱 시작 시점에 Codex가 이미 작업 중이면 이 함수로 초기 상태를 복원합니다.
function detectWorkingFromFile(filePath) {
  const lines = readTailLines(filePath);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const isStart = line.includes('"task_started"');
    const isEnd = line.includes('"task_complete"') || line.includes('"turn_aborted"');
    if (!isStart && !isEnd) continue;

    try {
      const entry = JSON.parse(line);
      const payloadType = entry?.payload?.type;
      if (payloadType === "task_started") return true;
      if (payloadType === "task_complete" || payloadType === "turn_aborted") return false;
    } catch {
      // 잘린 줄이면 다음 줄을 계속 확인합니다.
    }
  }
  return false;
}

// Codex 세션 로그를 감시하는 EventEmitter입니다.
// 발행 이벤트:
//  - "working-changed" (isWorking, result)  : 작업 시작/종료. result는 { reason, message } 또는 null
//  - "agent-message" (message)              : Codex가 사용자에게 보낸 메시지
//  - "user-message" (message)               : 사용자가 Codex에 보낸 요청
//  - "tool-activity" (activity)             : 파일 수정/웹 검색/이미지 생성 등 도구 사용
//  - "usage-updated" (usage)                : rate_limits 갱신
class CodexWatcher extends EventEmitter {
  constructor() {
    super();
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

  // 더블클릭 시 호출됩니다. tail 중 캐시된 값이 있으면 그대로 쓰고,
  // 없으면(앱 시작 직후 등) 최근 세션 파일들을 뒤에서부터 스캔합니다.
  getUsage() {
    if (this.cachedUsage) return this.cachedUsage;

    const recentFiles = listRecentRolloutFiles(WATCHER_CONFIG.usageScanFiles);
    for (const file of recentFiles) {
      const usage = extractUsageFromFile(file.filePath);
      if (usage) {
        this.cachedUsage = usage;
        return usage;
      }
    }
    return null;
  }

  poll() {
    const recentFiles = listRecentRolloutFiles(WATCHER_CONFIG.tailFiles);
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
        if (payload.message) {
          this.emit("agent-message", payload.message);
        }
        break;

      case "user_message":
        if (payload.message) {
          this.emit("user-message", payload.message);
        }
        break;

      case "patch_apply_end": {
        // changes의 key가 수정된 파일의 절대 경로입니다. 파일명만 추려서 보냅니다.
        const files = Object.keys(payload.changes || {}).map((p) => path.basename(p));
        if (files.length > 0) {
          this.emit("tool-activity", { kind: "patch", files, success: payload.success !== false });
        }
        break;
      }

      case "web_search_end":
        this.emit("tool-activity", { kind: "search", query: payload.query || null });
        break;

      case "image_generation_end":
        this.emit("tool-activity", { kind: "image" });
        break;

      case "token_count":
        if (payload.rate_limits) {
          this.cachedUsage = {
            rateLimits: payload.rate_limits,
            recordedAt: entry.timestamp || null,
          };
          this.emit("usage-updated", this.cachedUsage);
        }
        break;

      default:
        break;
    }
  }
}

module.exports = { CodexWatcher };
