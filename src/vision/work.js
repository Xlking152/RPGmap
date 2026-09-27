export function finishWorkSync(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

export async function finishWorkAsync(iterator, {
  signal,
  budgetMs = 8,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
} = {}) {
  let started = performance.now();
  while (true) {
    signal?.throwIfAborted();
    const step = iterator.next();
    if (step.done) return step.value;
    if (performance.now() - started >= budgetMs) {
      await yieldTask();
      started = performance.now();
    }
  }
}
