import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTokenInstanceName } from '../src/token/naming.js';

test('instance names use the smallest available positive suffix per Actor template', () => {
  const actor = { id: 'wolf', name: '狼' };
  const tokens = [
    { actorId: 'wolf', name: '狼1' },
    { actorId: 'wolf', name: '狼3' },
    { actorId: 'other', name: '狼2' },
    { actorId: 'wolf', name: '自定义名称' },
  ];
  assert.equal(nextTokenInstanceName(tokens, actor), '狼2');
  assert.equal(nextTokenInstanceName([...tokens, { actorId: 'wolf', name: '狼2' }], actor), '狼4');
});

test('instance name matching safely handles template punctuation', () => {
  assert.equal(nextTokenInstanceName([{ actorId: 'a', name: 'A+B1' }], { id: 'a', name: 'A+B' }), 'A+B2');
});
