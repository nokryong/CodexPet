// OS별 보안 저장소를 같은 인터페이스로 노출합니다.
// - Windows: 자격 증명 관리자 (windows-credential.js)
// - macOS: Keychain (keychain-credential.js)
// 그 외 플랫폼은 호출 시점에 명확한 오류를 돌려줍니다.
const backend =
  process.platform === "win32"
    ? require("./windows-credential")
    : process.platform === "darwin"
      ? require("./keychain-credential")
      : {
          readCredential: () => Promise.reject(unsupported()),
          writeCredential: () => Promise.reject(unsupported()),
          deleteCredential: () => Promise.reject(unsupported()),
        };

function unsupported() {
  return new Error(`이 플랫폼(${process.platform})에서는 보안 자격 증명 저장을 지원하지 않습니다.`);
}

module.exports = {
  readCredential: (...args) => backend.readCredential(...args),
  writeCredential: (...args) => backend.writeCredential(...args),
  deleteCredential: (...args) => backend.deleteCredential(...args),
};
