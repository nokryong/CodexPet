const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const MAX_RECENT_EVENTS = 1200;

function text(value, limit = 280) {
  if (value === null || value === undefined) return "";
  const source = typeof value === "string" ? value : String(value);
  return source.replace(/\s+/g, " ").trim().slice(0, limit);
}

function readBytes(file, offset, size) {
  const length = Math.max(0, size - offset);
  if (length === 0) return Buffer.alloc(0);

  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(file, "r");
  let total = 0;
  try {
    while (total < length) {
      const count = fs.readSync(descriptor, buffer, total, length - total, offset + total);
      if (count === 0) break;
      total += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return buffer.subarray(0, total);
}

function splitCompleteLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const end = index > start && buffer[index - 1] === 0x0d ? index - 1 : index;
    lines.push(buffer.subarray(start, end));
    start = index + 1;
  }
  return { lines, remainder: buffer.subarray(start) };
}

// EOF부터 읽는 공용 JSONL watcher입니다. 시작 전에 있던 대화는 재생하지 않고,
// watcher 시작 뒤 새로 만들어진 파일은 첫 줄부터 읽습니다.
class ExternalWatcher extends EventEmitter {
  constructor({ provider, roots, findFiles, parseRow, pollMs = 1800, quietMs = 12000 }) {
    super();
    this.provider = provider;
    this.roots = roots.filter(Boolean);
    this.findFiles = findFiles;
    this.parseRow = parseRow;
    this.pollMs = pollMs;
    this.quietMs = quietMs;
    this.offsets = new Map();
    this.buffers = new Map();
    this.sessions = new Map();
    this.recentEvents = new Set();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.seed();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.offsets.clear();
    this.buffers.clear();
    this.sessions.clear();
    this.recentEvents.clear();
  }

  seed() {
    for (const file of this.files()) {
      try {
        this.offsets.set(file, fs.statSync(file).size);
      } catch {
        // 다음 poll에서 다시 발견합니다.
      }
    }
  }

  files() {
    return [...new Set(this.roots.flatMap((root) => this.findFiles(root)))];
  }

  rememberEvent(key) {
    if (!key || this.recentEvents.has(key)) return false;
    this.recentEvents.add(key);
    if (this.recentEvents.size > MAX_RECENT_EVENTS) {
      const oldest = this.recentEvents.values().next().value;
      this.recentEvents.delete(oldest);
    }
    return true;
  }

  parseLine(line, file, now) {
    const source = line.toString("utf8").trim();
    if (!source) return;
    try {
      this.accept(this.parseRow(JSON.parse(source), file), now);
    } catch {
      // 다른 형식의 행이나 쓰는 중이던 불완전 행은 무시합니다.
    }
  }

  poll() {
    const now = Date.now();
    for (const file of this.files()) {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }

      // seed 이후 새로 생긴 파일은 첫 사용자 요청부터 읽어야 합니다.
      if (!this.offsets.has(file)) this.offsets.set(file, 0);
      const offset = this.offsets.get(file);

      if (size < offset) {
        this.offsets.set(file, size);
        this.buffers.delete(file);
        continue;
      }
      if (size === offset) continue;

      let chunk;
      try {
        chunk = readBytes(file, offset, size);
      } catch {
        continue;
      }
      this.offsets.set(file, offset + chunk.length);

      const previous = this.buffers.get(file) || Buffer.alloc(0);
      const combined = previous.length ? Buffer.concat([previous, chunk]) : chunk;
      const { lines, remainder } = splitCompleteLines(combined);
      this.buffers.set(file, remainder);
      for (const line of lines) this.parseLine(line, file, now);

      // 일부 JSONL 작성기는 마지막 줄에 개행을 늦게 붙입니다. 완성된 JSON이면 바로 처리합니다.
      if (remainder.length) {
        try {
          const source = remainder.toString("utf8").trim();
          const row = JSON.parse(source);
          this.buffers.set(file, Buffer.alloc(0));
          this.accept(this.parseRow(row, file), now);
        } catch {
          // 다음 poll의 나머지 바이트와 합칩니다.
        }
      }
    }

    for (const [id, session] of [...this.sessions]) {
      if (now - session.lastAt > this.quietMs) this.finish(id, "quiet");
    }
  }

  accept(event, now) {
    if (!event || !event.sessionId || !event.type) return;
    const id = `${this.provider}:${event.sessionId}`;
    const eventKey = event.eventId ? `${id}:${event.eventId}` : null;
    if (eventKey && !this.rememberEvent(eventKey)) return;

    let session = this.sessions.get(id);
    if (!session) {
      session = { id, lastAt: now, cwd: event.cwd || null, lastMessage: "" };
      this.sessions.set(id, session);
      this.emit("working-changed", true, null, {
        threadId: id,
        cwd: session.cwd,
        provider: this.provider,
      });
    }

    session.lastAt = now;
    session.cwd ||= event.cwd || null;
    const context = { threadId: id, cwd: session.cwd, provider: this.provider };
    if (event.type === "user") this.emit("user-message", text(event.text), context);
    if (event.type === "assistant") {
      session.lastMessage = text(event.text);
      this.emit("agent-message", session.lastMessage, context);
    }
    if (event.type === "tool") {
      this.emit(
        "tool-activity",
        { kind: event.kind || "command", command: text(event.text), ...context },
        context
      );
    }
    if (event.finished) this.finish(id, "done", event.text);
  }

  finish(id, reason, message = "") {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const result = {
      threadId: id,
      reason,
      message: text(message) || session.lastMessage,
      provider: this.provider,
      otherTasksWorking: this.sessions.size > 0,
    };
    this.emit("task-finished", result);
    this.emit("working-changed", this.sessions.size > 0, result, {
      threadId: id,
      activityChange: "removed",
      provider: this.provider,
    });
  }

  get working() {
    return this.sessions.size > 0;
  }
}

function recursiveJsonl(root) {
  if (!root) return [];
  const out = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) out.push(fullPath);
    }
  }
  return out;
}

module.exports = {
  ExternalWatcher,
  recursiveJsonl,
  readBytes,
  splitCompleteLines,
  text,
};
