function buildAccountSubmenu({ profiles = [], formatLabel, onSwitch, onLogin }) {
  const savedProfiles = Array.isArray(profiles) ? profiles : [];
  const labelFor = typeof formatLabel === "function" ? formatLabel : (profile) => profile.label;

  return [
    ...(savedProfiles.length
      ? savedProfiles.map((profile) => ({
          label: labelFor(profile),
          type: "radio",
          checked: Boolean(profile.active),
          enabled: profile.hasAuth !== false,
          click: () => onSwitch(profile.key),
        }))
      : [{ label: "저장된 계정 없음", enabled: false }]),
    { type: "separator" },
    { label: "로그인 / 계정 추가", click: onLogin },
  ];
}

module.exports = { buildAccountSubmenu };
