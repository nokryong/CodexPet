const { execFile } = require("node:child_process");

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

function getInstalledFonts({ run = execFile, platform = process.platform } = {}) {
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
