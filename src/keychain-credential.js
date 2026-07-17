const { spawn } = require("node:child_process");

// macOS Keychain에 JSON 자격 증명을 저장합니다. Windows의 windows-credential.js와 같은 인터페이스입니다.
// 값은 base64로 감싸서 저장합니다. security CLI는 비출력 문자가 섞이면 hex로 출력해 버려서
// 원문 JSON을 그대로 저장하면 읽기 결과 형식이 달라질 수 있기 때문입니다.
const KEYCHAIN_ACCOUNT = "codepet";

// 비밀 값이 프로세스 인수(ps 출력)에 노출되지 않도록 `security -i`의 stdin으로 명령을 전달합니다.
function runSecurity(stdinCommand, { timeoutMs = 10000 } = {}) {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("Keychain 자격 증명은 macOS에서만 사용할 수 있습니다."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Keychain 작업 시간이 초과됐습니다."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", () => finish(new Error("Keychain 작업을 시작하지 못했습니다.")));
    child.once("close", (code) => {
      finish(
        code === 0 ? null : new Error(stderr.trim() || "Keychain 작업에 실패했습니다."),
        stdout.trim()
      );
    });
    child.stdin.end(`${stdinCommand}\n`);
  });
}

function quoteSecurityArgument(value) {
  return `"${String(value).replace(/(["\\])/g, "\\$1")}"`;
}

async function readCredential(target) {
  const encoded = await runSecurity(
    `find-generic-password -a ${quoteSecurityArgument(KEYCHAIN_ACCOUNT)} -s ${quoteSecurityArgument(target)} -w`
  );
  if (!encoded) throw new Error("저장된 자격 증명이 없습니다.");
  return Buffer.from(encoded, "base64").toString("utf8");
}

function writeCredential(target, value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  // -U: 이미 있으면 갱신합니다.
  return runSecurity(
    `add-generic-password -U -a ${quoteSecurityArgument(KEYCHAIN_ACCOUNT)} -s ${quoteSecurityArgument(target)} -w ${quoteSecurityArgument(encoded)}`
  ).then(() => undefined);
}

function deleteCredential(target) {
  return runSecurity(
    `delete-generic-password -a ${quoteSecurityArgument(KEYCHAIN_ACCOUNT)} -s ${quoteSecurityArgument(target)}`
  ).then(
    () => undefined,
    (error) => {
      // 항목이 없어서 실패한 경우는 삭제 성공과 같게 취급합니다.
      if (/could not be found/i.test(error.message || "")) return undefined;
      throw error;
    }
  );
}

module.exports = { deleteCredential, readCredential, writeCredential };
