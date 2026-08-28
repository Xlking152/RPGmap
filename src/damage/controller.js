export function createDamageController({ selection } = {}) {
  return {
    register(api) {
      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];
      api.damage = {
        async applyToTokenIds(tokenIds, damage) {
          return api.health?.applyDamageToTokenIds
            ? api.health.applyDamageToTokenIds(tokenIds, damage)
            : [];
        },
        async applyToSelected(damage) {
          return api.health?.applyDamageToTokenIds
            ? api.health.applyDamageToTokenIds(selectedIds(), damage)
            : [];
        },
      };
    },
  };
}
