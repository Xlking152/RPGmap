export const INFINITE_HORROR_HEALTH = Object.freeze({
  supportedModes: Object.freeze(['simple', 'wound-track']),

  defaultModeForSource(sourceType) {
    return sourceType === 'xlsx' ? 'wound-track' : 'simple';
  },
});
