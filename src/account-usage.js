function usageCardBase(providerId, providerLabel, profile) {
  return {
    id: `${providerId}:${profile.key}`,
    providerId,
    providerLabel,
    accountLabel: profile.label,
    active: Boolean(profile.active),
  };
}

async function loadAccountUsageCards({ providerId, providerLabel, profiles, loadUsage }) {
  if (!profiles.length) {
    return [{
      id: `${providerId}:empty`,
      providerId,
      providerLabel,
      accountLabel: "연결된 계정 없음",
      active: false,
      error: "로그인 필요",
      gauges: [],
    }];
  }

  return Promise.all(profiles.map(async (profile) => {
    const base = usageCardBase(providerId, providerLabel, profile);
    try {
      const usage = await loadUsage(profile);
      return { ...base, gauges: usage?.gauges || [] };
    } catch {
      return { ...base, error: "조회 불가", gauges: [] };
    }
  }));
}

module.exports = { loadAccountUsageCards };
