const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// macOS 폰트 폴더입니다. 파일명 기반이라 정확한 family명과 다를 수 있지만,
// CSS font-family 후보로 쓰기에 충분하고 PowerShell/WPF 없이 즉시 조회할 수 있습니다.
const MAC_FONT_DIRS = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  path.join(os.homedir(), "Library", "Fonts"),
];

const MAC_FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".dfont"]);

function getMacInstalledFonts() {
  const names = [];
  for (const dir of MAC_FONT_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const extension = path.extname(entry).toLowerCase();
      if (!MAC_FONT_EXTENSIONS.has(extension)) continue;
      names.push(path.basename(entry, path.extname(entry)));
    }
  }
  return normalizeFontNames(names);
}

const FONT_REGISTRY_PATHS = [
  "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
];

function normalizeFontNames(values) {
  const fonts = [];
  for (const value of values || []) {
    const name = String(value || "")
      .replace(/\s+\((?:TrueType|OpenType|PostScript|Type 1)\)$/i, "")
      .trim();
    if (name && !name.startsWith("@")) fonts.push(name);
  }
  return [...new Set(fonts)].sort((left, right) => left.localeCompare(right, "ko"));
}

function buildFontRegistryScript() {
  const paths = FONT_REGISTRY_PATHS
    .map((registryPath) => `  '${registryPath.replace(/'/g, "''")}'`)
    .join(",\n");
  return `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName PresentationCore -ErrorAction Stop
  foreach ($family in [Windows.Media.Fonts]::SystemFontFamilies) {
    [Console]::Out.WriteLine($family.Source)
  }
  exit 0
} catch {
  # WPF를 사용할 수 없는 Windows 환경에서는 아래 레지스트리 목록으로 대체합니다.
}
$paths = @(
${paths}
)
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $key = Get-Item -LiteralPath $path
  foreach ($name in $key.GetValueNames()) {
    [Console]::Out.WriteLine($name)
  }
}`;
}

let installedFontsPromise = null;

let macInstalledFontsPromise = null;

function getInstalledFonts({ run = execFile, platform = process.platform } = {}) {
  if (platform === "darwin") {
    // 폰트는 세션 중 사실상 바뀌지 않으므로 win32 경로처럼 결과를 캐시합니다.
    // (설정 창을 열거나 저장할 때마다 폰트 폴더 4곳을 재스캔하지 않도록)
    if (macInstalledFontsPromise) return macInstalledFontsPromise;
    macInstalledFontsPromise = Promise.resolve().then(() => {
      try {
        return getMacInstalledFonts();
      } catch {
        return [];
      }
    });
    return macInstalledFontsPromise;
  }
  if (platform !== "win32") return Promise.resolve([]);
  if (run === execFile && installedFontsPromise) return installedFontsPromise;

  const promise = new Promise((resolve) => {
    const encoded = Buffer.from(buildFontRegistryScript(), "utf16le").toString("base64");
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(normalizeFontNames(String(stdout || "").split(/\r?\n/)));
      }
    );
  });

  if (run === execFile) installedFontsPromise = promise;
  return promise;
}

module.exports = {
  FONT_REGISTRY_PATHS,
  buildFontRegistryScript,
  getInstalledFonts,
  normalizeFontNames,
};
