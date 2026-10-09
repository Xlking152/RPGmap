import { serialize, deserialize } from 'node:v8';

// This representation exists only in this process's private resume history.
// Preserve native numbers and shared data references without retaining the
// canonical Fog's large JavaScript object graph between commits.
export function encodeResumePatch(patch) {
  return serialize(patch);
}

export function decodeResumePatch(encoded) {
  if (!Buffer.isBuffer(encoded)) throw new TypeError('Resume patch requires an encoded Buffer');
  return deserialize(encoded);
}
