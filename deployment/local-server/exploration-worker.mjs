import { parentPort } from 'node:worker_threads';
import { computeExplorationChunk } from './ruleset-authority.mjs';
let context = null;
let contextId = null;

parentPort.on('message', message => {
  try {
    if (message.context) { context = message.context; contextId = message.contextId; }
    if (contextId !== message.contextId) throw new Error('Exploration Worker context is missing');
    parentPort.postMessage({ requestId: message.requestId, result: computeExplorationChunk({ ...message, context }) });
  }
  catch (error) { parentPort.postMessage({ requestId: message.requestId, error: String(error.message) }); }
});
