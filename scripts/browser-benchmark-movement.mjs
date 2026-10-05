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
