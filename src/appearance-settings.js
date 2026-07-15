const THEME_SOURCES = new Set(["light", "dark", "system"]);

function normalizeThemeSource(value) {
  return THEME_SOURCES.has(value) ? value : "light";
}

function normalizeFontFamily(value, installedFonts = []) {
  if (typeof value !== "string") return null;
  const font = value.trim();
  if (!font || font.length > 120 || /[{};<>\n\r]/.test(font)) return null;
  return installedFonts.includes(font) ? font : null;
}

function quoteFontFamily(font) {
  return font ? `"${font.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : null;
}

module.exports = { normalizeThemeSource, normalizeFontFamily, quoteFontFamily };
