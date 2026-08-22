export function createDamageController({ selection } = {}) {
  return {
    register(api) {
      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];
      api.damage = {
        applyToTokenIds(tokenIds, damage) {
          return api.health?.applyDamageToTokenIds?.(tokenIds, damage) || [];
        },
        applyToSelected(damage) {
          return api.health?.applyDamageToTokenIds?.(selectedIds(), damage) || [];
        },
      };
    },
  };
}
