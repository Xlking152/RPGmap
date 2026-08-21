export function createHealingController({ selection } = {}) {
  return {
    register(api) {
      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];
      api.healing = {
        applyToTokenIds(tokenIds, healing) {
          return api.health?.applyHealingToTokenIds?.(tokenIds, healing) || [];
        },
        applyToSelected(healing) {
          return api.health?.applyHealingToTokenIds?.(selectedIds(), healing) || [];
        },
      };
    },
  };
}
