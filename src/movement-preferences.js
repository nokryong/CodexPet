function normalizeMovementPreferences(settings) {
  return {
    followMouse: settings?.followMouse === true,
    manualPaused: settings?.manualPaused === true,
  };
}

function movementPreferencesPatch(runtime) {
  return {
    followMouse: runtime?.followMouse === true,
    manualPaused: runtime?.manualPaused === true,
  };
}

module.exports = { movementPreferencesPatch, normalizeMovementPreferences };
