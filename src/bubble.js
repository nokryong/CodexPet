// 말풍선 renderer입니다. main이 보내주는 데이터 형태는 두 가지입니다.
//  - { kind: "usage", title, gauges: [{label, usedPercent, resetText}], footer }
//  - { kind: "activity", title, busy, text }
// XSS를 피하려고 innerHTML 대신 DOM API + textContent만 사용합니다.
const bubbleElement = document.querySelector("#bubble");

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
}

function renderActivity(data) {
  bubbleElement.replaceChildren(createTitle(data.title, Boolean(data.busy)));

  const body = document.createElement("div");
  body.className = "body-text";
  body.textContent = data.text || "";
  bubbleElement.appendChild(body);
}

window.bubbleApi.onUpdate((data) => {
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
  window.bubbleApi.dismiss();
});
