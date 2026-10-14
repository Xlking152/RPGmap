import { createContentSystemBase } from "./runtime-base.js";
import { createIndexedContentStorage } from "./indexed-storage.js";

export function createContentSystem(options = {}) {
  return createContentSystemBase({ ...options, createLocalStorage: createIndexedContentStorage });
}
