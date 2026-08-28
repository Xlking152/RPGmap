from pathlib import Path


def replace(path, old, new, label):
    p = Path(path)
    source = p.read_text()
    if old not in source:
        raise RuntimeError(f"Pattern not found: {label}")
    p.write_text(source.replace(old, new, 1))


sheet = "src/health/sheet-extension.js"
replace(
    sheet,
    "      documentNode.addEventListener('change', event => {",
    "      documentNode.addEventListener('change', async event => {",
    "health sheet async change handler",
)
replace(
    sheet,
    """        if (select) {
          api.health?.setMode?.(select.dataset.healthMode, select.value);
          queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
          return;
        }""",
    """        if (select) {
          try {
            await api.health?.setMode?.(select.dataset.healthMode, select.value);
          } catch (error) {
            console.error('[RPGmap Health UI] mode update failed', error);
          } finally {
            // Re-render from the canonical projection after confirmation or
            // rejection so the select never keeps an uncommitted draft value.
            queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
          }
          return;
        }""",
    "health mode confirmation",
)
replace(
    sheet,
    """        api.health?.performActorOperation?.(input.dataset.healthActorId, field.operation(value));
        queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });""",
    """        try {
          await api.health?.performActorOperation?.(input.dataset.healthActorId, field.operation(value));
        } catch (error) {
          console.error('[RPGmap Health UI] runtime update failed', error);
        } finally {
          // A failed World operation leaves canonical state unchanged; redraw
          // from that state to roll the edited input back immediately.
          queueMicrotask(() => { enhanceSheet(); enhanceInspector(); });
        }""",
    "health runtime confirmation",
)

chat = "src/chat/controller.js"
replace(
    chat,
    "      panel.addEventListener('submit', event => {",
    "      panel.addEventListener('submit', async event => {",
    "chat async submit handler",
)
replace(
    chat,
    "          const results = api.damage?.applyToSelected?.({ amount, type }) || api.health?.applyDamageToTokenIds?.(ids, { amount, type }) || [];",
    """          let results;
          try {
            results = api.damage?.applyToSelected
              ? await api.damage.applyToSelected({ amount, type })
              : api.health?.applyDamageToTokenIds
                ? await api.health.applyDamageToTokenIds(ids, { amount, type })
                : [];
          } catch (error) {
            console.error('[RPGmap Chat] damage operation failed', error);
            status(`应用伤害失败：${error?.message || error}`);
            return;
          }""",
    "chat damage confirmation",
)
replace(
    chat,
    "          const results = api.healing?.applyToSelected?.({ amount, type }) || api.health?.applyHealingToTokenIds?.(ids, { amount, type }) || [];",
    """          let results;
          try {
            results = api.healing?.applyToSelected
              ? await api.healing.applyToSelected({ amount, type })
              : api.health?.applyHealingToTokenIds
                ? await api.health.applyHealingToTokenIds(ids, { amount, type })
                : [];
          } catch (error) {
            console.error('[RPGmap Chat] healing operation failed', error);
            status(`恢复生命失败：${error?.message || error}`);
            return;
          }""",
    "chat healing confirmation",
)

token_test = Path("tests/token-health.test.js")
source = token_test.read_text()
if "rejected Health World batch leaves canonical Actor and Token state untouched" not in source:
    source += """

test('rejected Health World batch leaves canonical Actor and Token state untouched', async () => {
  const { api } = fixture();
  await api.tokens.create({ actorId: 'actor-template', id: 'pc-a', actorLink: true });
  await api.tokens.create({ actorId: 'actor-template', id: 'npc-a', actorLink: false });

  const emitted = [];
  api.emit = (type, detail) => emitted.push({ type, detail });
  api.world.performOperations = async () => {
    throw Object.assign(new Error('conflict'), { code: 'world_state_stale' });
  };

  await assert.rejects(
    api.health.applyDamageToTokenIds(['pc-a', 'npc-a'], { amount: 3 }),
    error => error?.code === 'world_state_stale',
  );
  assert.equal(api.health.resolveActor('actor-template').current, 10);
  assert.equal(api.health.resolveToken('pc-a').current, 10);
  assert.equal(api.health.resolveToken('npc-a').current, 10);
  assert.equal(emitted.some(event => event.type === 'health:change'), false);
});
"""
token_test.write_text(source)

authority = Path("tests/health-world-operation-authority.test.js")
authority.write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function source(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

test('Health controller has no projection-first persistence path', () => {
  const controller = source('src/health/controller.js');
  assert.doesNotMatch(controller, /store\\.persist\\s*\\(/);
  assert.doesNotMatch(controller, /persistNow\\s*\\(/);
  assert.match(controller, /api\\.world\\?\\.performOperations/);
  assert.match(controller, /type:\\s*'actor\\.upsert'/);
  assert.match(controller, /type:\\s*'token\\.actorDelta\\.replace'/);
  assert.match(controller, /kind:\\s*'health'/);
});

test('Health UI and chat wait for canonical Health confirmation', () => {
  const sheet = source('src/health/sheet-extension.js');
  const chat = source('src/chat/controller.js');
  assert.match(sheet, /addEventListener\\('change', async event/);
  assert.match(sheet, /await api\\.health\\?\\.setMode/);
  assert.match(sheet, /await api\\.health\\?\\.performActorOperation/);
  assert.match(chat, /addEventListener\\('submit', async event/);
  assert.match(chat, /await api\\.damage\\.applyToSelected/);
  assert.match(chat, /await api\\.healing\\.applyToSelected/);
});

test('Damage and Healing facades expose confirmation-based async operations', () => {
  const damage = source('src/damage/controller.js');
  const healing = source('src/healing/controller.js');
  assert.match(damage, /async applyToTokenIds/);
  assert.match(damage, /async applyToSelected/);
  assert.match(healing, /async applyToTokenIds/);
  assert.match(healing, /async applyToSelected/);
});
""")
