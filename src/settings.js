const api = window.settingsApi;
const rootElement = document.documentElement;
const toastElement = document.querySelector("#toast");
const fontSelect = document.querySelector("#font");
const fontSearch = document.querySelector("#font-search");

let state = null;
let installedFonts = [];
let selectedFont = "";
let toastTimer = null;

function $(selector) {
  return document.querySelector(selector);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function quoteFontFamily(fontFamily) {
  if (!fontFamily) return null;
  const escaped = String(fontFamily)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function resolveLocalTheme(themeSource) {
  if (themeSource !== "system") return themeSource === "dark" ? "dark" : "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppearance(appearance, fontFamily = appearance?.fontFamily || "") {
  const themeSource = appearance?.themeSource || "light";
  const resolvedTheme = appearance?.resolvedTheme || resolveLocalTheme(themeSource);
  rootElement.dataset.theme = resolvedTheme === "dark" ? "dark" : "light";

  const quotedFont = quoteFontFamily(fontFamily);
  if (quotedFont) {
    rootElement.style.setProperty("--user-font", quotedFont);
    rootElement.style.setProperty("--font-display", quotedFont);
  } else {
    rootElement.style.removeProperty("--user-font");
    rootElement.style.removeProperty("--font-display");
  }

  if (appearance?.bubbleBgColor) {
    rootElement.style.setProperty("--bubble-bg", appearance.bubbleBgColor);
  } else {
    rootElement.style.removeProperty("--bubble-bg");
  }
  if (appearance?.bubbleTextColor) {
    rootElement.style.setProperty("--bubble-ink", appearance.bubbleTextColor);
    const textHex = String(appearance.bubbleTextColor).trim();
    if (textHex.startsWith("#") && textHex.length === 7) {
      rootElement.style.setProperty("--bubble-muted", textHex + "a6");
    } else {
      rootElement.style.setProperty("--bubble-muted", textHex);
    }
  } else {
    rootElement.style.removeProperty("--bubble-ink");
    rootElement.style.removeProperty("--bubble-muted");
  }
}

function showError(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = String(message || "오류가 발생했습니다.");
  toastElement.hidden = false;
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
    toastElement.textContent = "";
  }, 4500);
}

function responseError(response, fallback) {
  return response?.error || fallback;
}

function setButtonBusy(button, busy, busyLabel = "처리 중…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.wasDisabled = String(button.disabled);
    button.textContent = busyLabel;
    button.disabled = true;
    return;
  }
  if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = button.dataset.wasDisabled === "true";
  delete button.dataset.wasDisabled;
}

function replaceOptions(select, options, selectedValue) {
  select.replaceChildren(...options);
  select.value = selectedValue || "";
}

function setActiveThemeControl(themeSource) {
  const target = [...document.querySelectorAll('input[name="theme"]')]
    .find((input) => input.value === themeSource);
  if (target) target.checked = true;
}

function currentThemeSource() {
  return document.querySelector('input[name="theme"]:checked')?.value || "light";
}

function updateFontPreview() {
  $("#font-preview-name").textContent = selectedFont || "시스템 기본";
  applyAppearance(
    {
      themeSource: currentThemeSource(),
      resolvedTheme: resolveLocalTheme(currentThemeSource()),
    },
    selectedFont
  );
}

function renderFonts() {
  const query = fontSearch.value.trim().toLocaleLowerCase("ko");
  const filteredFonts = query
    ? installedFonts.filter((font) => font.toLocaleLowerCase("ko").includes(query))
    : installedFonts;
  const options = [new Option("시스템 기본", "")];

  if (selectedFont && !filteredFonts.includes(selectedFont)) {
    options.push(new Option(`${selectedFont} · 현재`, selectedFont));
  }
  options.push(...filteredFonts.map((font) => new Option(font, font)));
  if (query && filteredFonts.length === 0) {
    const empty = new Option("검색 결과 없음", "__empty__");
    empty.disabled = true;
    options.push(empty);
  }

  replaceOptions(fontSelect, options, selectedFont);
  $("#font-count").textContent = query
    ? `${filteredFonts.length} / ${installedFonts.length}개`
    : `${installedFonts.length}개`;
  updateFontPreview();
}

function renderGeneral({ resetAppearance = false } = {}) {
  if (!state) return;
  if (resetAppearance) selectedFont = state.appearance.fontFamily || "";
  setActiveThemeControl(state.appearance.themeSource);
  replaceOptions(
    $("#pet"),
    state.pets.map((pet) => new Option(pet.label, pet.key)),
    state.petKey
  );
  $("#bubble-mode").value = state.activityBubbleMode;
  $("#follow").checked = state.followMouse;
  $("#autostart").checked = state.autoStart;

  const bgVal = state.appearance.bubbleBgColor || "";
  $("#bubble-bg-color").value = bgVal;
  if (/^#[0-9a-fA-F]{6}$/.test(bgVal) || /^#[0-9a-fA-F]{3}$/.test(bgVal) || /^#[0-9a-fA-F]{8}$/.test(bgVal)) {
    $("#bubble-bg-picker").value = bgVal.slice(0, 7);
  } else {
    $("#bubble-bg-picker").value = rootElement.dataset.theme === "dark" ? "#0f172a" : "#ffffff";
  }

  const textVal = state.appearance.bubbleTextColor || "";
  $("#bubble-text-color").value = textVal;
  if (/^#[0-9a-fA-F]{6}$/.test(textVal) || /^#[0-9a-fA-F]{3}$/.test(textVal)) {
    $("#bubble-text-picker").value = textVal.slice(0, 7);
  } else {
    $("#bubble-text-picker").value = rootElement.dataset.theme === "dark" ? "#f8fafc" : "#09090b";
  }

  renderFonts();
}

function accountInitial(account, provider) {
  const source = account.email || account.label || provider.label || "C";
  return source.trim().slice(0, 1).toLocaleUpperCase("ko") || "C";
}

function createEmptyState(title) {
  const empty = createElement("div", "empty-state");
  empty.appendChild(createElement("strong", "", title));
  return empty;
}

function createProviderGroup(provider) {
  const group = createElement("section", "provider-group");
  const heading = createElement("header", "provider-heading");
  const title = createElement("div", "provider-title");
  title.append(
    createElement("span", "provider-mark", provider.label.slice(0, 1)),
    createElement("h2", "", provider.label)
  );

  const addButton = createElement("button", "button", "계정 추가");
  addButton.type = "button";
  addButton.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "login" }, addButton)
  );
  heading.append(title, addButton);
  group.appendChild(heading);

  const list = createElement("div", "stack-list");
  if (!provider.accounts?.length) {
    list.appendChild(createEmptyState("저장된 계정 없음"));
    group.appendChild(list);
    return group;
  }

  for (const account of provider.accounts) {
    const row = createElement("article", "list-row");
    const identity = createElement("div", "list-identity");
    identity.appendChild(
      createElement("span", "account-avatar", accountInitial(account, provider))
    );

    const copy = createElement("div", "list-copy");
    const titleRow = createElement("span");
    titleRow.appendChild(createElement("strong", "", account.email || account.label));
    if (account.active) titleRow.appendChild(createElement("span", "active-chip", "현재"));
    copy.appendChild(titleRow);
    if (account.plan) copy.appendChild(createElement("small", "", account.plan));
    identity.appendChild(copy);

    const actions = createElement("div", "list-actions");
    const switchButton = createElement(
      "button",
      "button",
      account.active ? "사용 중" : "전환"
    );
    switchButton.type = "button";
    switchButton.disabled = account.active;
    switchButton.addEventListener("click", () =>
      runAccountAction(
        { provider: provider.id, action: "switch", profileKey: account.key },
        switchButton
      )
    );
    actions.appendChild(switchButton);

    const deleteButton = createElement("button", "button danger-button", "삭제");
    deleteButton.type = "button";
    deleteButton.disabled = account.active;
    deleteButton.addEventListener("click", () => {
      const accountLabel = account.email || account.label || provider.label;
      if (!window.confirm(`"${accountLabel}" 저장 계정을 삭제할까요?`)) return;
      runAccountAction(
        { provider: provider.id, action: "delete", profileKey: account.key },
        deleteButton
      );
    });
    actions.appendChild(deleteButton);
    row.append(identity, actions);
    list.appendChild(row);
  }
  group.appendChild(list);
  return group;
}

function renderAccounts() {
  const root = $("#provider-groups");
  root.replaceChildren();
  for (const provider of state?.providers || []) {
    root.appendChild(createProviderGroup(provider));
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function resetLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(value))) {
    return String(value);
  }
  return `${new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} 초기화`;
}

function createUsageGauge(gauge) {
  const used = clampPercent(gauge.usedPercent);
  const remaining = Math.round(100 - used);
  const container = createElement("div", "usage-gauge");
  const row = createElement("div", "usage-row");
  row.append(
    createElement("span", "", gauge.label),
    createElement("strong", "", `${remaining}%`)
  );
  const track = createElement("div", "usage-track");
  const fill = createElement("i", used >= 90 ? "is-danger" : used >= 70 ? "is-warn" : "");
  fill.style.width = `${used}%`;
  track.appendChild(fill);
  container.append(row, track, createElement("small", "", resetLabel(gauge.resetText)));
  return container;
}

function renderUsage() {
  const root = $("#usage-cards");
  root.replaceChildren();
  for (const item of state?.usage || []) {
    const card = createElement("article", "usage-card");
    const heading = createElement("header", "usage-card-heading");
    heading.append(
      createElement("span", "provider-mark", item.label.slice(0, 1)),
      createElement("h2", "", item.label)
    );
    card.appendChild(heading);

    if (item.error) {
      card.appendChild(createElement("p", "usage-error", item.error));
    } else if (!item.gauges?.length) {
      card.appendChild(createElement("p", "usage-error", "한도 정보 없음"));
    } else {
      for (const gauge of item.gauges) card.appendChild(createUsageGauge(gauge));
    }
    root.appendChild(card);
  }
}

function renderAll(options = {}) {
  renderGeneral(options);
  renderAccounts();
  renderUsage();
}

async function runAccountAction(input, sourceButton) {
  const busyLabel = input.action === "switch"
    ? "전환 중…"
    : input.action === "delete"
      ? "삭제 중…"
      : "여는 중…";
  setButtonBusy(sourceButton, true, busyLabel);
  try {
    const response = await api.account(input);
    if (!response?.ok) throw new Error(responseError(response, "계정 작업에 실패했습니다."));
    state = response.data;
    renderAccounts();
    renderUsage();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setButtonBusy(sourceButton, false);
  }
}

function activateSection(button, { focus = false } = {}) {
  const sectionId = button.dataset.section;
  for (const navButton of document.querySelectorAll(".nav-item")) {
    const active = navButton === button;
    navButton.classList.toggle("is-active", active);
    navButton.setAttribute("aria-selected", String(active));
    navButton.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(".panel")) {
    const active = panel.id === sectionId;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  $("#section-label").textContent = button.dataset.label;
  if (focus) button.focus();
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
}

function registerNavigation() {
  const buttons = [...document.querySelectorAll(".nav-item")];
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activateSection(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let targetIndex = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        targetIndex = (index + 1) % buttons.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        targetIndex = (index - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = buttons.length - 1;
      }
      activateSection(buttons[targetIndex], { focus: true });
    });
  });
  api.onNavigate((section) => {
    const target = buttons.find((button) => button.dataset.section === section);
    if (target) activateSection(target);
  });
}

function registerAppearanceControls() {
  fontSearch.addEventListener("input", renderFonts);
  fontSelect.addEventListener("change", () => {
    if (fontSelect.value === "__empty__") return;
    selectedFont = fontSelect.value;
    updateFontPreview();
  });
  for (const input of document.querySelectorAll('input[name="theme"]')) {
    input.addEventListener("change", updateFontPreview);
  }

  $("#save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "적용 중…");
    try {
      const response = await api.save({
        themeSource: currentThemeSource(),
        fontFamily: selectedFont || null,
        petKey: $("#pet").value,
        activityBubbleMode: $("#bubble-mode").value,
        followMouse: $("#follow").checked,
        autoStart: $("#autostart").checked,
        bubbleBgColor: $("#bubble-bg-color").value.trim() || null,
        bubbleTextColor: $("#bubble-text-color").value.trim() || null,
      });
      if (!response?.ok) throw new Error(responseError(response, "설정을 적용하지 못했습니다."));
      state = response.data;
      renderAll({ resetAppearance: true });
      applyAppearance(state.appearance, selectedFont);
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerProviderControls() {
  $("#refresh-accounts").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "확인 중…");
    try {
      const response = await api.get();
      if (!response?.ok) throw new Error(responseError(response, "계정을 확인하지 못했습니다."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });

  $("#refresh-usage").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "확인 중…");
    try {
      const response = await api.usage();
      if (!response?.ok) throw new Error(responseError(response, "사용량을 확인하지 못했습니다."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerAppearanceUpdates() {
  api.onAppearance((appearance) => {
    applyAppearance(appearance, appearance?.fontFamily || selectedFont);
    if (state) state.appearance = { ...state.appearance, ...appearance };
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentThemeSource() === "system") updateFontPreview();
  });
}

function registerTitlebarControls() {
  $("#btn-minimize").addEventListener("click", () => api.minimize());
  $("#btn-maximize").addEventListener("click", () => api.maximize());
  $("#btn-close").addEventListener("click", () => api.close());

  api.onMaximizedState((isMaximized) => {
    const btn = $("#btn-maximize");
    const maxIcon = btn.querySelector(".icon-maximize");
    const restoreIcon = btn.querySelector(".icon-restore");
    if (isMaximized) {
      if (maxIcon) maxIcon.style.display = "none";
      if (restoreIcon) restoreIcon.style.display = "block";
      btn.setAttribute("aria-label", "이전 크기로 복원");
    } else {
      if (maxIcon) maxIcon.style.display = "block";
      if (restoreIcon) restoreIcon.style.display = "none";
      btn.setAttribute("aria-label", "최대화");
    }
  });
}

function registerColorPickerControls() {
  const bgPicker = $("#bubble-bg-picker");
  const bgInput = $("#bubble-bg-color");
  const textPicker = $("#bubble-text-picker");
  const textInput = $("#bubble-text-color");

  function isValidColor(str) {
    const s = new Option().style;
    s.color = str;
    return s.color !== '';
  }

  bgPicker.addEventListener("input", () => {
    bgInput.value = bgPicker.value;
    updateLiveColors();
  });
  textPicker.addEventListener("input", () => {
    textInput.value = textPicker.value;
    updateLiveColors();
  });

  bgInput.addEventListener("input", () => {
    const val = bgInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val) || /^#[0-9a-fA-F]{8}$/.test(val)) {
      bgPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });
  textInput.addEventListener("input", () => {
    const val = textInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val)) {
      textPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });

  function updateLiveColors() {
    const bgVal = bgInput.value.trim();
    const textVal = textInput.value.trim();

    if (bgVal && isValidColor(bgVal)) {
      rootElement.style.setProperty("--bubble-bg", bgVal);
    } else {
      rootElement.style.removeProperty("--bubble-bg");
    }

    if (textVal && isValidColor(textVal)) {
      rootElement.style.setProperty("--bubble-ink", textVal);
    } else {
      rootElement.style.removeProperty("--bubble-ink");
    }
  }
}

async function initialize() {
  registerTitlebarControls();
  registerColorPickerControls();
  registerNavigation();
  registerAppearanceControls();
  registerProviderControls();
  registerAppearanceUpdates();

  try {
    const [fontResponse, settingsResponse] = await Promise.all([api.fonts(), api.get()]);
    installedFonts = fontResponse?.ok && Array.isArray(fontResponse.data)
      ? fontResponse.data
      : [];
    if (!settingsResponse?.ok) {
      throw new Error(responseError(settingsResponse, "설정을 불러오지 못했습니다."));
    }
    state = settingsResponse.data;
    selectedFont = state.appearance.fontFamily || "";
    renderAll({ resetAppearance: true });
    applyAppearance(state.appearance, selectedFont);
  } catch (error) {
    showError(error.message || String(error));
  }
}

initialize();
