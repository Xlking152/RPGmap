import { applyWorldOperationsAsync } from "../../world/operations.js";
import { createRuntimeSessionCore } from "./session-base.js";

// Compatibility entry for standalone callers. Hosted assembly imports the base.
export function createRuntimeSession(options = {}) {
  return createRuntimeSessionCore({ ...options, authority: options.authority || {
    apply({ state, operations, context }) { return applyWorldOperationsAsync(state, operations, context); },
  } });
}
