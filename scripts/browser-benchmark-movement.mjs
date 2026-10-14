// Keep this calculation self-contained so it can run inside the browser's CDP
// evaluation and be exercised by the deterministic scheduler test.
export function browserBenchmarkMovementTarget(token, tokenIndex) {
  const x = 2900 + (tokenIndex % 25) * 2;
  const baseY = 2500 + Math.floor(tokenIndex / 25) * 2;
  const currentX = Number(token?.x);
  const currentY = Number(token?.y);
  if (token?.placement !== 'map' || !Number.isFinite(currentX) || !Number.isFinite(currentY)
    || Math.abs(currentX - x) > 1e-6) {
    throw new Error(`Benchmark Token ${tokenIndex} is missing or outside its expected route`);
  }
  const atBase = Math.abs(currentY - baseY) <= 1e-6;
  const atOffset = Math.abs(currentY - (baseY + 0.5)) <= 1e-6;
  if (!atBase && !atOffset) throw new Error(`Benchmark Token ${tokenIndex} is outside its expected route`);
  return { x, y: atBase ? baseY + 0.5 : baseY };
}

// Use the same conditional route command as drag/WASD. Absolute token.move
// deliberately retains a World revision precondition and is not interchangeable
// with a route whose Token origin is checked by the authoritative server.
export async function browserBenchmarkMoveToken(api, tokenIndex,
  targetForToken = browserBenchmarkMovementTarget, now = () => performance.now()) {
  const started = now();
  const tokenId = `browser-token-${tokenIndex}`;
  try {
    const before = api.tokens.get(tokenId);
    const target = targetForToken(before, tokenIndex);
    if (Number(before.x) === target.x && Number(before.y) === target.y) {
      throw new Error('Benchmark target must differ from the current Token position');
    }
    const result = await api.movementFast.moveTokenPath([tokenId], tokenId, [target],
      { method: 'keyboard', movementMode: 'walk' });
    if (result?.valid !== true || result.committed !== true) {
      throw Object.assign(new Error(result?.reason || 'Movement was not committed'),
        { code: result?.code || 'benchmark_movement_not_committed' });
    }
    const after = api.tokens.get(tokenId);
    if (!after || Number(after.x) !== target.x || Number(after.y) !== target.y) {
      throw Object.assign(new Error('Benchmark Token did not reach the committed target'),
        { code: 'benchmark_movement_target_mismatch' });
    }
    return { tokenId, from: { x: Number(before.x), y: Number(before.y) }, to: target,
      sourceTokenId: api.vision.getSource(), elapsedMs: now() - started };
  } catch (cause) {
    const elapsedMs = now() - started;
    const code = cause?.code || 'benchmark_movement_failed';
    throw Object.assign(new Error(`Benchmark movement failed [${code}] after ${elapsedMs.toFixed(3)} ms: ${cause?.message || cause}`),
      { code, elapsedMs });
  }
}

export function browserBenchmarkPhaseOperations(scene, tokenCount, lighting) {
  if (!scene || !['normal', 'dark'].includes(lighting)) throw new Error('Invalid browser benchmark phase');
  const sceneId = String(scene.id);
  const operations = [{ type: 'scene.content.replace', payload: {
    sceneId, settings: { ...scene.settings, lineOfSightEnabled: true, lighting },
  } }];
  if (lighting === 'dark') {
    for (let index = Math.max(0, tokenCount - 3); index < tokenCount; index += 1) {
      const id = `browser-token-${index}`;
      const token = scene.tokens.find(item => item.id === id);
      if (!token) throw new Error(`Missing benchmark light Token ${id}`);
      operations.push({ type: 'token.upsert', payload: { sceneId, token: {
        ...token, light: { enabled: true, rangeMeters: 120, intensity: 1.2,
          color: '#fff3c4', elevationOffsetMeters: 3, occlusion: 'scene' },
      } } });
    }
  }
  return operations;
}
