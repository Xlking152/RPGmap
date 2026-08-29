export function createHealingController({ selection } = {}) {
  return {
    register(api) {
      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];
      api.healing = {
        async applyToTokenIds(tokenIds, healing) {
          return api.health?.applyHealingToTokenIds
            ? api.health.applyHealingToTokenIds(tokenIds, healing)
            : [];
        },
        async applyToSelected(healing) {
          return api.health?.applyHealingToTokenIds
            ? api.health.applyHealingToTokenIds(selectedIds(), healing)
            : [];
        },
      };
    },
  };
}
