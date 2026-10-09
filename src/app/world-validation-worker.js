import { exportPreparedRuntimeState } from '../engine/runtime-state.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { currentWorldValidationRecipe } from './world-validation-context.js';

const recipe = currentWorldValidationRecipe();

self.onmessage = ({ data }) => {
  if (data?.protocol !== 1 || data.kind !== 'runtime-world-export') return;
  const response = { protocol: 1, kind: 'runtime-world-export-result', id: data.id, generation: data.generation };
  if (!recipe || data.recipe !== recipe || !data.prepared?.hasCanonicalWorld) {
    self.postMessage({ ...response, infrastructureError: 'World validation context is not the built-in recipe' });
    return;
  }
  try {
    const json = JSON.stringify(exportPreparedRuntimeState(data.prepared, {
      mapPackage: data.mapPackage, ruleset: infiniteHorrorRuleset,
    }));
    self.postMessage({ ...response, json });
  } catch (error) {
    self.postMessage({ ...response, error: {
      name: error?.name || 'Error', message: error?.message || String(error),
      ...(error?.code === undefined ? {} : { code: error.code }),
    } });
  }
};
