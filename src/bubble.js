// 말풍선 renderer입니다. main이 보내주는 데이터 형태는 두 가지입니다.
//  - { kind: "usage", title, gauges: [{label, usedPercent, resetText}], footer, actions }
//  - { kind: "activity", title, busy, text, actions }
// XSS를 피하려고 innerHTML 대신 DOM API + textContent만 사용합니다.
const bubbleElement = document.querySelector("#bubble");
let currentBubbleData = null;
window.bubbleApi.onAppearance((appearance) => {
  const root = document.documentElement;
  root.dataset.theme = appearance?.resolvedTheme === "dark" ? "dark" : "light";

  if (appearance?.fontFamily) {
    const fontFamily = String(appearance.fontFamily)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    root.style.setProperty("--user-font", `"${fontFamily}"`);
  } else {
    root.style.removeProperty("--user-font");
  }

  if (appearance?.bubbleBgColor) {
    root.style.setProperty("--bubble-bg", appearance.bubbleBgColor);
  } else {
    root.style.removeProperty("--bubble-bg");
  }
  if (appearance?.bubbleTextColor) {
    root.style.setProperty("--bubble-ink", appearance.bubbleTextColor);
    const textHex = String(appearance.bubbleTextColor).trim();
    if (textHex.startsWith("#") && textHex.length === 7) {
      root.style.setProperty("--bubble-muted", textHex + "a6");
    } else {
      root.style.setProperty("--bubble-muted", textHex);
    }
  } else {
    root.style.removeProperty("--bubble-ink");
    root.style.removeProperty("--bubble-muted");
  }
});

function createTitle(titleText, busy) {
  const title = document.createElement("div");
  title.className = "title";

  const dot = document.createElement("span");
  dot.className = busy ? "dot busy" : "dot";
  title.appendChild(dot);
  title.appendChild(document.createTextNode(titleText));

  return title;
}

// 사용률에 따라 게이지 색을 바꿉니다. 70% 이상 주의, 90% 이상 경고입니다.
function fillClassFor(usedPercent) {
  if (usedPercent >= 90) return "fill danger";
  if (usedPercent >= 70) return "fill warn";
  return "fill";
}

// 말풍선 하단의 액션 버튼입니다.
// 버튼 클릭은 말풍선 닫기 클릭으로 전파되지 않게 막고 main process로 actionId만 보냅니다.
function renderActions(container, actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;

  const actionRow = document.createElement("div");
  actionRow.className = "actions";

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button";
    button.textContent = action.label || "실행";
    button.disabled = Boolean(action.disabled);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!action.disabled && action.id) {
        window.bubbleApi.sendAction(action.id, action.payload || null);
      }
    });

    actionRow.appendChild(button);
  }

  container.appendChild(actionRow);
}

function renderUsage(data) {
  bubbleElement.replaceChildren(createTitle(data.title, false));

  for (const gaugeData of data.gauges || []) {
    const gauge = document.createElement("div");
    gauge.className = "gauge";

    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("span");
    label.textContent = gaugeData.label;
    const pct = document.createElement("span");
    pct.className = "pct";
    pct.textContent = `${Math.round(100 - gaugeData.usedPercent)}% 남음`;
    row.append(label, pct);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = fillClassFor(gaugeData.usedPercent);
    fill.style.width = `${Math.min(100, Math.max(0, gaugeData.usedPercent))}%`;
    bar.appendChild(fill);

    const reset = document.createElement("div");
    reset.className = "reset";
    reset.textContent = gaugeData.resetText;

    gauge.append(row, bar, reset);
    bubbleElement.appendChild(gauge);
  }

  if (data.footer) {
    const footer = document.createElement("div");
    footer.className = "footer";
    footer.textContent = data.footer;
    bubbleElement.appendChild(footer);
  }

  renderActions(bubbleElement, data.actions);
}

function appendActivityContent(container, data) {
  container.appendChild(createTitle(data.title, Boolean(data.busy)));

  const body = document.createElement("div");
  body.className = "body-text";
  body.textContent = data.text || "";
  container.appendChild(body);

  if (data.clickHint) {
    const hint = document.createElement("div");
    hint.className = "footer";
    hint.textContent = data.clickHint;
    container.appendChild(hint);
  }

  renderActions(container, data.actions);
}

function renderActivity(data) {
  if (!Array.isArray(data.sections)) {
    bubbleElement.replaceChildren();
    appendActivityContent(bubbleElement, data);
    return;
  }

  bubbleElement.replaceChildren();
  bubbleElement.appendChild(createTitle(data.title, true));
  for (const sectionData of data.sections) {
    const section = document.createElement("div");
    section.className = "activity-section";
    if (sectionData.primaryAction?.id) section.classList.add("clickable");
    section.addEventListener("click", (event) => {
      event.stopPropagation();
      if (sectionData.primaryAction?.id) {
        window.bubbleApi.sendAction(sectionData.primaryAction.id, sectionData.primaryAction.payload || null);
      } else {
        window.bubbleApi.dismiss();
      }
    });
    const row = document.createElement("div");
    row.className = "activity-row";
    const label = document.createElement("div");
    label.className = "activity-row-label";
    label.textContent = sectionData.title;
    row.appendChild(label);
    const body = document.createElement("div");
    body.className = "body-text activity-section-body";
    body.textContent = sectionData.text || "";
    section.append(row, body);
    if (sectionData.clickHint) {
      const hint = document.createElement("div");
      hint.className = "footer";
      hint.textContent = sectionData.clickHint;
      section.appendChild(hint);
    }
    bubbleElement.appendChild(section);
  }
}

window.bubbleApi.onUpdate((data) => {
  currentBubbleData = data;
  // 다중 항목은 각 section이 자신의 클릭 가능 상태를 표시합니다.
  bubbleElement.classList.toggle("clickable", Boolean(data.primaryAction?.id));

  if (data.kind === "usage") {
    renderUsage(data);
  } else {
    renderActivity(data);
  }

  // offsetHeight를 읽으면 그 자리에서 동기 layout이 일어나므로 바로 측정해서 보냅니다.
  // 주의: requestAnimationFrame을 쓰면 안 됩니다. 숨겨진 창에서는 rAF 콜백이 실행되지 않아서
  // 높이 보고가 누락되고, main은 보고를 받아야 창을 표시하므로 말풍선이 다시 열리지 않습니다.
  window.bubbleApi.reportHeight(document.querySelector("#root").offsetHeight);
});

bubbleElement.addEventListener("click", () => {
  if (currentBubbleData?.primaryAction?.id) {
    window.bubbleApi.sendAction(
      currentBubbleData.primaryAction.id,
      currentBubbleData.primaryAction.payload || null
    );
    return;
  }

  window.bubbleApi.dismiss();
});
