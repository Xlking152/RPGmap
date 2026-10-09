// Ordinary local play is measured separately from the multiplayer benchmark.
// Run in the persistent offline World of the exact installed package.
export async function runLocalBrowserPerformance(evaluate) {
  return evaluate(`(${measureLocalPlay.toString()})()`, 160_000);
}

async function measureLocalPlay() {
  const api = document.querySelector('#app').rpgMapApp;
  if (api.multiplayer?.getStatus?.().connected) throw new Error('Local performance requires an offline World');
  const tokenId = api.vision.getSource(), original = api.tokens.get(tokenId), scene = api.world.getActiveScene();
  if (!original) throw new Error('Local performance requires a vision source');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
  const idle = async () => {
    const deadline = performance.now() + 45_000;
    while (api.world.getExplorationStatus().queued || api.world.getExplorationStatus().running) {
      if (performance.now() > deadline) throw new Error('Local performance exploration did not drain');
      await wait(20);
    }
  };
  const initialDiagnostics = api.diagnostics.enabled;
  const phases = [];
  api.diagnostics.setEnabled(true);
  try {
    for (const [name, lighting, rangeMeters] of [['normal', 'normal', 120], ['dark', 'dark', 500]]) {
      await api.world.performOperations([{ type: 'scene.content.replace', payload: { sceneId: scene.id,
        settings: { ...scene.settings, lighting } } }],
        { source: 'local-performance:lighting' });
      await api.tokens.update(tokenId, { vision: { ...original.vision,
        preciseRangeOverrideMeters: rangeMeters, vagueRangeOverrideMeters: rangeMeters } });
      await api.vision.setSource(tokenId);
      await idle(); await wait(1000);
      const origin = api.tokens.get(tokenId);
      const destination = [1, -1].map(offset => ({ x: origin.x + offset, y: origin.y }))
        .find(point => api.movementFast.inspectTokenMove(tokenId, point, { from: origin }).valid);
      if (!destination) throw new Error('Local performance fixture has no ordinary movement route');
      api.diagnostics.reset();
      const frameSamplesMs = [], inputs = [], moves = [], longTasks = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry =>
        ({ startTime: entry.startTime, duration: entry.duration }))));
      observer.observe({ type: 'longtask', buffered: false });
      let frameId, previousFrame = null;
      const tick = time => {
        if (previousFrame !== null) frameSamplesMs.push(time - previousFrame);
        previousFrame = time; frameId = requestAnimationFrame(tick);
      };
      const startedAt = performance.now();
      frameId = requestAnimationFrame(tick);
      try {
        while (performance.now() - startedAt < 60_000) {
          const started = performance.now(), from = api.tokens.get(tokenId);
          const target = moves.length % 2 ? { x: origin.x, y: origin.y } : destination;
          const inputStarted = performance.now();
          document.querySelector('.leaflet-container').dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: 300 + moves.length % 20, clientY: 300, pointerId: 1, pointerType: 'mouse' }));
          const inputFrame = new Promise(resolve => requestAnimationFrame(() => {
            inputs.push(performance.now() - inputStarted); resolve();
          }));
          const result = await api.movementFast.moveTokenTo(tokenId, target);
          if (!result.valid) throw new Error('Local performance movement rejected: ' + result.reason);
          const commitMs = performance.now() - started, revision = api.getStateRevision();
          for (;;) {
            const feedback = api.vision.getFeedbackState(), visual = api.renderer.getVisualTokenPoint(tokenId);
            if (feedback?.rendered && feedback.stateRevision >= revision && feedback.requestedAt >= started
              && Math.abs(feedback.source.x - target.x) <= .001 && Math.abs(feedback.source.y - target.y) <= .001
              && visual && Math.abs(visual.x - target.x) <= .001 && Math.abs(visual.y - target.y) <= .001) break;
            if (performance.now() - started > 2000) throw new Error('Local performance mask failed to follow movement');
            await wait(1);
          }
          await inputFrame;
          moves.push({ from: { x: from.x, y: from.y }, target, revision, commitMs, feedbackMs: performance.now() - started });
          await wait(Math.max(0, 500 - (performance.now() - started)));
        }
      } finally {
        cancelAnimationFrame(frameId);
        longTasks.push(...observer.takeRecords().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
        observer.disconnect();
      }
      const endedAt = performance.now(), averageFPS = 1000 * frameSamplesMs.length / frameSamplesMs.reduce((sum, value) => sum + value, 0);
      const phase = { name, lighting, rangeMeters, startedAt, endedAt, durationMs: endedAt - startedAt,
        frameSamplesMs, averageFPS, frameP95Ms: percentile(frameSamplesMs), inputSamplesMs: inputs,
        inputP95Ms: percentile(inputs), moves, longTasks, maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.duration)) };
      phases.push(phase);
      if (averageFPS < 58 || phase.frameP95Ms > 20 || Math.round(phase.inputP95Ms * 1e6) > 16_700_000
        || phase.maxLongTaskMs > 100) throw new Error('Local performance gate failed: ' + JSON.stringify(phase));
      await idle();
    }
    return { storageMode: 'persistent-offline', connected: false, secondsPerPhase: 60,
      tokenId, tokenCount: scene.tokens.length, featureCount: api.mapPackage.features.length,
      phases, finalQueue: api.world.getExplorationStatus() };
  } finally {
    await api.tokens.update(tokenId, { vision: original.vision });
    await api.tokens.reposition(tokenId, { x: original.x, y: original.y });
    await api.world.performOperations([{ type: 'scene.content.replace', payload: { sceneId: scene.id,
      settings: scene.settings } }], { source: 'local-performance:cleanup' });
    api.diagnostics.setEnabled(initialDiagnostics);
  }
}
