import { parentPort } from 'node:worker_threads';
import { computeExplorationChunk } from './ruleset-authority.mjs';
import { createExplorationFogReceiver } from './exploration-fog-transfer.mjs';
let context = null;
let contextId = null;
const fogReceiver = createExplorationFogReceiver();

parentPort.on('message', message => {
  try {
    if (message.context) { context = message.context; contextId = message.contextId; }
    if (contextId !== message.contextId) throw new Error('Exploration Worker context is missing');
    const exploredRows = fogReceiver.receive(message);
    parentPort.postMessage({ requestId: message.requestId, result: computeExplorationChunk({ ...message, context, exploredRows }) });
  }
  catch (error) { parentPort.postMessage({ requestId: message.requestId, error: String(error.message) }); }
});
