const fs = require("node:fs");
const path = require("node:path");
const { build, Platform } = require("electron-builder");

const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "artifacts");
const privateBuildMetadata = [
  "builder-debug.yml",
  "builder-effective-config.yaml",
];

function cleanPrivateBuildMetadata() {
  for (const fileName of privateBuildMetadata) {
    fs.rmSync(path.join(outputDir, fileName), { force: true });
  }

  if (!fs.existsSync(outputDir)) return;
  for (const fileName of fs.readdirSync(outputDir)) {
    if (/\.nsis\.7z$/i.test(fileName)) {
      fs.rmSync(path.join(outputDir, fileName), { force: true });
    }
  }
}

async function main() {
  try {
    await build({
      projectDir,
      targets: Platform.WINDOWS.createTarget(),
    });
  } finally {
    cleanPrivateBuildMetadata();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
