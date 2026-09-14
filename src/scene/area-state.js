// Document projections can share arrays with their canonical Scene, even after
// structuredClone. Replace the projection array without editing that snapshot.
export function stateWithAreaDraft(state, areaId, draft) {
  const areas = state.attackAreas || [];
  if (!areas.some(area => String(area.id) === String(areaId))) return null;
  return {
    ...state,
    attackAreas: areas.map(area => String(area.id) === String(areaId) ? structuredClone(draft) : area),
  };
}
