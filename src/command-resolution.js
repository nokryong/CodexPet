const path = require("node:path");

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function commandCandidates(whereOutput) {
  return String(whereOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function selectCommandPath(whereOutput, platform = process.platform) {
  const candidates = commandCandidates(whereOutput);
  if (platform !== "win32") return candidates[0] || null;

  const executable = candidates.find((candidate) =>
    WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(candidate).toLocaleLowerCase("en"))
  );
  if (executable) return executable;

  const shellWrapper = candidates.find((candidate) =>
    WINDOWS_SHELL_EXTENSIONS.has(path.extname(candidate).toLocaleLowerCase("en"))
  );
  return shellWrapper || null;
}

function commandNeedsShell(command, platform = process.platform) {
  if (platform !== "win32") return false;
  return WINDOWS_SHELL_EXTENSIONS.has(path.extname(String(command || "")).toLocaleLowerCase("en"));
}

module.exports = { commandNeedsShell, selectCommandPath };
