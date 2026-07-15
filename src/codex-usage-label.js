function rateWindowLabel(rateWindow) {
  const windowMinutes = Number(
    typeof rateWindow === "object" ? rateWindow?.window_minutes : rateWindow
  );
  let label;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) label = "사용 한도";
  else if (Math.abs(windowMinutes - 300) < 0.01) label = "5시간 한도";
  else if (Math.abs(windowMinutes - 10080) < 0.01) label = "주간 한도";
  else if (windowMinutes >= 28 * 1440 && windowMinutes <= 31 * 1440) label = "월간 한도";
  else if (windowMinutes % 1440 === 0) label = `${windowMinutes / 1440}일 한도`;
  else if (windowMinutes % 60 === 0) label = `${windowMinutes / 60}시간 한도`;
  else label = `${Math.round(windowMinutes)}분 한도`;
  return rateWindow?.scope ? `${rateWindow.scope} · ${label}` : label;
}

module.exports = { rateWindowLabel };
