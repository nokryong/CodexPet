const test = require("node:test");
const assert = require("node:assert/strict");

const { loadAccountUsageCards } = require("../src/account-usage");

test("연결된 모든 계정의 사용량을 카드로 만들고 계정별 조회 실패를 격리한다", async () => {
  const profiles = [
    { key: "active", label: "active@example.com", active: true },
    { key: "stale", label: "stale@example.com", active: false },
  ];

  const cards = await loadAccountUsageCards({
    providerId: "codex",
    providerLabel: "Codex",
    profiles,
    loadUsage: async (profile) => {
      if (profile.key === "stale") throw new Error("expired");
      return { gauges: [{ label: "5시간", usedPercent: 20 }] };
    },
  });

  assert.deepEqual(cards, [
    {
      id: "codex:active",
      providerId: "codex",
      providerLabel: "Codex",
      accountLabel: "active@example.com",
      active: true,
      gauges: [{ label: "5시간", usedPercent: 20 }],
    },
    {
      id: "codex:stale",
      providerId: "codex",
      providerLabel: "Codex",
      accountLabel: "stale@example.com",
      active: false,
      error: "조회 불가",
      gauges: [],
    },
  ]);
});

test("연결된 계정이 없는 provider는 로그인 안내 카드 하나를 만든다", async () => {
  const cards = await loadAccountUsageCards({
    providerId: "agy",
    providerLabel: "AGY",
    profiles: [],
    loadUsage: async () => ({ gauges: [] }),
  });

  assert.deepEqual(cards, [{
    id: "agy:empty",
    providerId: "agy",
    providerLabel: "AGY",
    accountLabel: "연결된 계정 없음",
    active: false,
    error: "로그인 필요",
    gauges: [],
  }]);
});
