const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { URL } = require("node:url");
const { atomicWrite, atomicWriteText } = require("./provider-profile-store");

// Codex 재시작 없는 계정 전환용 로컬 프록시입니다. (opencodex의 Design B 방식)
//
// 원리:
//  1. ~/.codex/config.toml 루트에 `openai_base_url = "http://127.0.0.1:<port>/v1"`을 넣으면
//     Codex CLI/데스크톱 앱의 내장 openai provider가 이 프록시로 요청을 보냅니다.
//  2. Codex는 자기 메모리에 있는(=옛 계정일 수 있는) OAuth 헤더를 붙여 보내고,
//     프록시는 authorization / chatgpt-account-id 두 헤더만 현재 선택된 계정으로 갈아끼운 뒤
//     https://chatgpt.com/backend-api/codex 로 그대로 스트리밍 중계합니다.
//  3. 계정 전환 = 프록시가 읽는 선택 계정만 바뀌면 끝. 앱 재시작이 필요 없습니다.
//
// 프록시 모드를 켜고 끌 때만 config.toml을 수정하며, 마커 주석이 붙은 줄만 건드립니다.

const UPSTREAM_BASE = "https://chatgpt.com/backend-api/codex";
const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI의 공개 OAuth client id입니다. (opencodex와 동일한 값)
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CONFIG_MARKER = "# codepet-codex-proxy";
const DEFAULT_PORT = 10161;
// hop-by-hop 헤더는 중계하면 안 됩니다.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return {};
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = part.padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function accessTokenExpiresAtMs(accessToken) {
  const exp = Number(decodeJwtPayload(accessToken).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

// --- config.toml 주입/제거 -------------------------------------------------

function buildBaseUrlLine(port) {
  return `openai_base_url = "http://127.0.0.1:${port}/v1"`;
}

function stripCodePetProxyLines(content) {
  const lines = String(content ?? "").split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === CONFIG_MARKER) {
      // 마커 바로 다음의 openai_base_url 한 줄까지 함께 제거합니다.
      if (/^\s*openai_base_url\s*=/.test(lines[index + 1] || "")) index += 1;
      continue;
    }
    kept.push(lines[index]);
  }
  return kept.join("\n");
}

// 루트 키는 첫 [table] 헤더보다 앞에 있어야 합니다. 사용자가 직접 넣은
// openai_base_url이 이미 있으면 존중하고 아무것도 쓰지 않습니다.
function injectBaseUrl(content, port) {
  const cleaned = stripCodePetProxyLines(content);
  const lines = cleaned.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const userLine = lines
    .slice(0, rootEnd)
    .some((line) => /^\s*openai_base_url\s*=/.test(line));
  if (userLine) return { content: cleaned, keptUserBaseUrl: true };

  const block = [CONFIG_MARKER, buildBaseUrlLine(port)];
  const next = [...lines.slice(0, rootEnd), ...block, ...lines.slice(rootEnd)];
  return { content: next.join("\n"), keptUserBaseUrl: false };
}

function defaultConfigPath(codexHome = path.join(os.homedir(), ".codex")) {
  return path.join(codexHome, "config.toml");
}

function enableProxyInConfig(port, configPath = defaultConfigPath()) {
  let content = "";
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    // config.toml이 없으면 새로 만듭니다.
  }
  const result = injectBaseUrl(content, port);
  if (result.keptUserBaseUrl) {
    throw new Error(
      "config.toml에 사용자가 설정한 openai_base_url이 이미 있습니다. 프록시 모드를 켜려면 그 줄을 먼저 정리해 주세요."
    );
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // atomicWriteText: 임시 파일 + rename. 중간에 죽어도 사용자 config.toml이 잘리지 않습니다.
  atomicWriteText(configPath, result.content);
}

// 마커 줄이 실제로 있을 때만 config.toml을 다시 씁니다. (없으면 파일을 건드리지 않습니다)
function disableProxyInConfig(configPath = defaultConfigPath()) {
  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return;
  }
  const stripped = stripCodePetProxyLines(content);
  if (stripped === content) return;
  atomicWriteText(configPath, stripped);
}

// --- 프록시 서버 -----------------------------------------------------------

// 429 응답 본문에서 초기화까지 남은 시간을 찾아봅니다. 없으면 기본 쿨다운을 씁니다.
function parseRetryDelayMs(bodyText, headers = {}) {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  try {
    const body = JSON.parse(bodyText);
    const seconds = Number(
      body?.resets_in_seconds ??
      body?.reset_after_seconds ??
      body?.error?.resets_in_seconds ??
      body?.error?.reset_after_seconds
    );
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch {
    // JSON이 아니면 기본값 사용.
  }
  return null;
}

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const AUTH_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
// responses 요청 본문 버퍼 상한입니다. 자동 재시도(계정 로테이션)에 필요합니다.
const MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024;

class CodexProxy {
  // resolveAccounts(): Promise<Array<{key, label, authPath}>> — 선호 순서(활성 계정 먼저).
  // readAuth(authPath): {accessToken, accountId} | null
  // notifySwitch(account, reason): 자동 전환이 일어났을 때 호출됩니다.
  constructor({
    resolveAccounts,
    readAuth,
    notifySwitch = () => {},
    upstreamBase = UPSTREAM_BASE,
    port = DEFAULT_PORT,
    log = () => {},
  } = {}) {
    this.resolveAccounts = resolveAccounts || (async () => []);
    this.readAuth = readAuth || (() => null);
    this.notifySwitch = notifySwitch;
    this.upstreamBase = upstreamBase;
    this.preferredPort = port;
    this.log = log;
    this.server = null;
    this.port = null;
    // key -> 쿨다운 해제 시각(ms). 429/401을 맞은 계정은 잠시 후보에서 제외합니다.
    this.cooldowns = new Map();
  }

  isCoolingDown(key) {
    const until = this.cooldowns.get(key);
    if (!until) return false;
    if (until <= Date.now()) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  setCooldown(key, durationMs) {
    this.cooldowns.set(key, Date.now() + durationMs);
  }

  get running() {
    return Boolean(this.server && this.server.listening);
  }

  async start() {
    if (this.running) return this.port;

    const server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.log(`proxy request failed: ${error.message || error}`);
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: { message: `codepet proxy error: ${error.message || error}` } }));
      });
    });
    // Codex 데스크톱 앱은 responses를 WebSocket으로 보냅니다. 업그레이드 요청은 원시 터널로 중계합니다.
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head).catch((error) => {
        this.log(`proxy websocket failed: ${error.message || error}`);
        socket.destroy();
      });
    });
    server.keepAliveTimeout = 75000;

    // 선호 포트가 사용 중이면 이어지는 포트를 몇 개 더 시도합니다.
    for (let candidate = this.preferredPort; candidate < this.preferredPort + 10; candidate += 1) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => reject(error);
          server.once("error", onError);
          server.listen(candidate, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve();
          });
        });
        this.server = server;
        this.port = candidate;
        this.log(`codex proxy listening on 127.0.0.1:${candidate}`);
        return candidate;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error("Codex 프록시 포트를 확보하지 못했습니다.");
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    this.port = null;
  }

  // 요청 본문을 메모리에 모읍니다. 계정 로테이션 재시도에 같은 본문이 필요하기 때문입니다.
  bufferBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      request.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_BUFFERED_BODY_BYTES) {
          reject(new Error("요청 본문이 프록시 버퍼 한도를 넘었습니다."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.once("end", () => resolve(Buffer.concat(chunks)));
      request.once("error", reject);
    });
  }

  forwardOnce(target, method, headers, body) {
    const transport = target.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
      const upstream = transport.request(target, { method, headers }, (upstreamResponse) => {
        resolve(upstreamResponse);
      });
      upstream.once("error", reject);
      upstream.end(body);
    });
  }

  // 재시도가 필요 없는 요청은 본문을 버퍼링하지 않고 클라이언트 스트림을 그대로 흘려보냅니다.
  forwardStream(target, method, headers, requestStream) {
    const transport = target.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
      const upstream = transport.request(target, { method, headers }, (upstreamResponse) => {
        resolve(upstreamResponse);
      });
      upstream.once("error", reject);
      requestStream.once("aborted", () => upstream.destroy());
      requestStream.pipe(upstream);
    });
  }

  // 프록시가 중계할 헤더를 고릅니다. stripAuth면 클라이언트가 붙인(옛 계정의) 인증 헤더를 제거해
  // 주입할 계정과 섞이지 않게 합니다.
  filteredHeaders(request, { stripAuth }) {
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(lower)) continue;
      if (stripAuth && (lower === "authorization" || lower === "chatgpt-account-id")) continue;
      headers[name] = value;
    }
    return headers;
  }

  streamToClient(upstreamResponse, response) {
    return new Promise((resolve, reject) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", resolve);
      upstreamResponse.once("error", reject);
    });
  }

  readWholeResponse(upstreamResponse) {
    return new Promise((resolve) => {
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      upstreamResponse.once("error", () => resolve(""));
    });
  }

  async candidateAccounts() {
    let accounts = [];
    try {
      accounts = await this.resolveAccounts();
    } catch (error) {
      this.log(`resolveAccounts failed: ${error.message || error}`);
    }
    return accounts.filter((account) => account?.authPath);
  }

  async authFor(account) {
    try {
      await refreshAuthFileIfStale(account.authPath);
    } catch {
      // 갱신 실패해도 기존 토큰으로 시도합니다.
    }
    try {
      return this.readAuth(account.authPath);
    } catch {
      return null;
    }
  }

  // --- WebSocket 터널 ------------------------------------------------------
  // 101이 성립되면 이후는 불투명한 바이트 스트림이므로 양방향 파이프만 하면 됩니다.
  // 핸드셰이크 단계에서 인증 헤더를 갈아끼우고, 429/401이면 다음 계정으로 재시도합니다.

  buildUpgradeHeaderLines(request, target, auth) {
    const lines = [];
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "authorization" || lower === "chatgpt-account-id") continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${item}`);
      }
    }
    lines.push(`Host: ${target.host}`);
    if (auth?.accessToken) {
      lines.push(`Authorization: Bearer ${auth.accessToken}`);
      if (auth.accountId) lines.push(`chatgpt-account-id: ${auth.accountId}`);
    } else if (request.headers.authorization) {
      lines.push(`Authorization: ${request.headers.authorization}`);
      if (request.headers["chatgpt-account-id"]) {
        lines.push(`chatgpt-account-id: ${request.headers["chatgpt-account-id"]}`);
      }
    }
    return lines;
  }

  connectUpstreamSocket(target) {
    return new Promise((resolve, reject) => {
      const secure = target.protocol === "https:" || target.protocol === "wss:";
      const port = Number(target.port) || (secure ? 443 : 80);
      const socket = secure
        ? tls.connect({ host: target.hostname, port, servername: target.hostname }, () => resolve(socket))
        : net.connect(port, target.hostname, () => resolve(socket));
      socket.once("error", reject);
      socket.setTimeout(20000, () => {
        socket.destroy();
        reject(new Error("upstream websocket connect timeout"));
      });
    });
  }

  // 핸드셰이크를 보내고 응답 헤더 블록까지 읽어 상태 코드를 돌려줍니다.
  performUpgradeHandshake(upstreamSocket, request, target, auth) {
    return new Promise((resolve, reject) => {
      const headerLines = this.buildUpgradeHeaderLines(request, target, auth);
      const upstreamPath = (request.url || "/").startsWith("/v1/")
        ? (request.url || "/").slice(3)
        : request.url || "/";
      const basePath = new URL(this.upstreamBase).pathname.replace(/\/$/, "");
      upstreamSocket.write(
        `GET ${basePath}${upstreamPath} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`
      );

      let buffer = Buffer.alloc(0);
      let settled = false;
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (buffer.length > 64 * 1024) {
            cleanup();
            reject(new Error("websocket handshake response too large"));
          }
          return;
        }
        cleanup();
        const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("utf8");
        const status = Number(statusLine.split(" ")[1]) || 0;
        resolve({ status, raw: buffer });
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      // upstream이 헤더 블록을 다 보내기 전에 연결을 닫으면(FIN) data/error가 아니라 close/end가 옵니다.
      // 이 경우를 잡지 않으면 promise가 영원히 pending 상태로 남아 클라이언트가 무한 대기합니다.
      const onClose = () => {
        cleanup();
        reject(new Error("upstream closed during websocket handshake"));
      };
      const cleanup = () => {
        if (settled) return;
        settled = true;
        upstreamSocket.removeListener("data", onData);
        upstreamSocket.removeListener("error", onError);
        upstreamSocket.removeListener("close", onClose);
        upstreamSocket.removeListener("end", onClose);
      };
      upstreamSocket.on("data", onData);
      upstreamSocket.once("error", onError);
      upstreamSocket.once("close", onClose);
      upstreamSocket.once("end", onClose);
    });
  }

  async handleUpgrade(request, socket, head) {
    // 핸드셰이크가 완료되기 전(수 초 걸릴 수 있음)에 클라이언트가 연결을 끊으면
    // 리스너 없는 'error' 이벤트가 메인 프로세스를 죽입니다. 터널 연결 전까지 임시 가드를 답니다.
    let clientAlive = true;
    const earlyGuard = () => {
      clientAlive = false;
    };
    socket.once("error", earlyGuard);
    socket.once("close", earlyGuard);

    const accounts = await this.candidateAccounts();
    const available = accounts.filter((account) => !this.isCoolingDown(account.key));
    const ordered = available.length > 0 ? available : accounts;
    // 저장 계정이 없으면 원래 헤더 그대로 통과합니다.
    const candidates = ordered.length > 0 ? ordered : [null];
    const target = new URL(this.upstreamBase);
    // 선호 계정은 쿨다운 필터 이전의 원래 1순위입니다. HTTP 경로와 같은 기준을 써야
    // 쿨다운으로 다른 계정이 실제 사용됐을 때 WebSocket에서도 자동 전환 알림이 발생합니다.
    const preferredKey = accounts[0]?.key;

    for (let index = 0; index < candidates.length; index += 1) {
      if (!clientAlive) return;
      const account = candidates[index];
      const auth = account ? await this.authFor(account) : null;
      if (account && !auth?.accessToken) continue;

      let upstreamSocket;
      try {
        upstreamSocket = await this.connectUpstreamSocket(target);
      } catch (error) {
        this.log(`websocket upstream connect failed: ${error.message || error}`);
        continue;
      }

      let status;
      let raw;
      try {
        ({ status, raw } = await this.performUpgradeHandshake(upstreamSocket, request, target, auth));
      } catch (error) {
        upstreamSocket.destroy();
        this.log(`websocket handshake failed: ${error.message || error}`);
        continue;
      }

      if (!clientAlive) {
        upstreamSocket.destroy();
        return;
      }

      if (status === 101) {
        socket.removeListener("error", earlyGuard);
        socket.removeListener("close", earlyGuard);
        upstreamSocket.setTimeout(0);
        socket.write(raw);
        if (head?.length) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        // upgrade 소켓은 상대가 끊겨도 close 없이 end만 오는 경우가 있어 end도 종료 신호로 취급합니다.
        const teardown = () => {
          socket.destroy();
          upstreamSocket.destroy();
        };
        for (const eventName of ["error", "close", "end"]) {
          socket.once(eventName, teardown);
          upstreamSocket.once(eventName, teardown);
        }
        if (account && account.key !== preferredKey) {
          try {
            this.notifySwitch(account, "quota");
          } catch {
            // 알림 실패가 터널을 막으면 안 됩니다.
          }
        }
        return;
      }

      upstreamSocket.destroy();
      if (account && (status === 429 || status === 401)) {
        this.setCooldown(account.key, status === 429 ? DEFAULT_COOLDOWN_MS : AUTH_FAIL_COOLDOWN_MS);
        this.log(`websocket account ${account.key} got ${status}; rotating`);
        if (index < candidates.length - 1) continue;
      }
      // 로테이션 불가한 실패는 upstream 응답을 그대로 클라이언트에 보냅니다.
      socket.removeListener("error", earlyGuard);
      socket.removeListener("close", earlyGuard);
      if (clientAlive) socket.end(raw);
      return;
    }

    socket.removeListener("error", earlyGuard);
    socket.removeListener("close", earlyGuard);
    if (clientAlive) socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  }

  async handleRequest(request, response) {
    // base_url이 http://127.0.0.1:port/v1 이므로 /v1 접두사를 벗겨 upstream 경로로 바꿉니다.
    const incomingPath = request.url || "/";
    const upstreamPath = incomingPath.startsWith("/v1/") ? incomingPath.slice(3) : incomingPath;
    const target = new URL(`${this.upstreamBase}${upstreamPath}`);

    const accounts = await this.candidateAccounts();

    // 계정이 하나도 저장돼 있지 않으면 들어온 헤더 그대로 스트리밍 통과시킵니다. (본문 버퍼링 없음)
    if (accounts.length === 0) {
      const passthrough = await this.forwardStream(
        target,
        request.method,
        this.filteredHeaders(request, { stripAuth: false }),
        request
      );
      await this.streamToClient(passthrough, response);
      return;
    }

    // 쿨다운이 아닌 계정을 선호 순서대로 시도합니다. 전부 쿨다운이면 어쩔 수 없이 전체를 후보로 씁니다.
    const available = accounts.filter((account) => !this.isCoolingDown(account.key));
    const ordered = available.length > 0 ? available : accounts;
    const isRotatable = request.method === "POST" && /\/responses$/.test(target.pathname);
    // 재시도(계정 로테이션)가 실제로 가능한 경우에만 본문을 버퍼링합니다.
    const canRotate = isRotatable && ordered.length > 1;
    const preferredKey = accounts[0].key;
    const baseHeaders = this.filteredHeaders(request, { stripAuth: true });
    const body = canRotate ? await this.bufferBody(request) : null;

    for (let index = 0; index < ordered.length; index += 1) {
      const account = ordered[index];
      const auth = await this.authFor(account);
      if (!auth?.accessToken) continue;

      const headers = { ...baseHeaders, authorization: `Bearer ${auth.accessToken}` };
      if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;

      let upstreamResponse;
      if (body !== null) {
        headers["content-length"] = Buffer.byteLength(body);
        upstreamResponse = await this.forwardOnce(target, request.method, headers, body);
      } else {
        upstreamResponse = await this.forwardStream(target, request.method, headers, request);
      }
      const status = upstreamResponse.statusCode || 0;
      const retryable = canRotate && (status === 429 || status === 401) && index < ordered.length - 1;

      if (status === 429 || status === 401) {
        const bodyText = retryable ? await this.readWholeResponse(upstreamResponse) : "";
        const cooldownMs = status === 429
          ? parseRetryDelayMs(bodyText, upstreamResponse.headers) || DEFAULT_COOLDOWN_MS
          : AUTH_FAIL_COOLDOWN_MS;
        this.setCooldown(account.key, cooldownMs);
        this.log(`account ${account.key} got ${status}; cooldown ${Math.round(cooldownMs / 60000)}m`);

        if (retryable) continue;
        // 더 시도할 계정이 없으면 읽지 않은 원본 응답을 그대로 넘깁니다.
        await this.streamToClient(upstreamResponse, response);
        return;
      }

      // 성공: 선호 계정이 아니면 자동 전환 사실을 알립니다.
      if (isRotatable && account.key !== preferredKey) {
        try {
          this.notifySwitch(account, "quota");
        } catch {
          // 알림 실패가 응답 중계를 막으면 안 됩니다.
        }
      }
      await this.streamToClient(upstreamResponse, response);
      return;
    }

    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { message: "codepet proxy: 사용할 수 있는 Codex 계정이 없습니다. (전부 한도 초과 또는 로그인 만료)" },
    }));
  }
}

// --- 토큰 갱신 -------------------------------------------------------------

// auth.json의 access_token이 만료 임박이면 refresh_token으로 갱신하고 파일에 다시 저장합니다.
// 실패해도 기존 토큰을 그대로 돌려줍니다. (서버가 최종 판정)
async function refreshAuthFileIfStale(authPath, { marginMs = 120000, fetchImpl = fetch } = {}) {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
  const tokens = auth?.tokens || {};
  if (!tokens.access_token) return auth;

  const expiresAt = accessTokenExpiresAtMs(tokens.access_token);
  if (!tokens.refresh_token || !expiresAt || expiresAt > Date.now() + marginMs) return auth;

  try {
    const response = await fetchImpl(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CHATGPT_CLIENT_ID,
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!response.ok) throw new Error(`token refresh HTTP ${response.status}`);
    const data = await response.json();
    auth.tokens = {
      ...tokens,
      access_token: data.access_token || tokens.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      id_token: data.id_token || tokens.id_token,
    };
    auth.last_refresh = new Date().toISOString();
    // atomicWrite: 0o600 권한 + 충돌 방지 임시 파일 + 실패 시 정리. auth.json은 토큰을 담으므로 중요.
    atomicWrite(authPath, auth);
  } catch {
    // 갱신 실패 시 기존 토큰으로 시도합니다.
  }
  return auth;
}

module.exports = {
  CHATGPT_CLIENT_ID,
  CONFIG_MARKER,
  CodexProxy,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PORT,
  parseRetryDelayMs,
  accessTokenExpiresAtMs,
  buildBaseUrlLine,
  defaultConfigPath,
  disableProxyInConfig,
  enableProxyInConfig,
  injectBaseUrl,
  refreshAuthFileIfStale,
  stripCodePetProxyLines,
};
