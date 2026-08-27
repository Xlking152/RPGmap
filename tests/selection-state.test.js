import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenSelectionState, tokenIdsInBounds } from '../src/selection/state.js';

test('marquee bounds select only visible map Tokens', () => {
  const tokens = [
    { id:'a', placement:'map', x:10, y:10, hidden:false },
    { id:'b', placement:'map', x:30, y:30, hidden:false },
    { id:'c', placement:'map', x:20, y:20, hidden:true },
    { id:'d', placement:'feature', featureId:'house', hidden:false },
  ];
  assert.deepEqual(tokenIdsInBounds(tokens, {x:0,y:0}, {x:20,y:20}), ['a']);
});

test('selection supports replace add remove and primary token', () => {
  const selection = new TokenSelectionState();
  selection.replace(['a','b'], 'b');
  assert.deepEqual(selection.snapshot(), { ids:['a','b'], primaryId:'b' });
  selection.add(['c'], 'c');
  assert.equal(selection.primaryId, 'c');
  selection.remove(['c','a']);
  assert.deepEqual(selection.snapshot(), { ids:['b'], primaryId:'b' });
  selection.clear();
  assert.deepEqual(selection.snapshot(), { ids:[], primaryId:null });
});
