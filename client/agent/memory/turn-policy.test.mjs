import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTurn} from './turn-policy.mjs';

test('轮末三条检查分别应用各自的阈值和开关', () => {
  assert.deepEqual(evaluateTurn({completedRuns:10,contentLength:100,messageCount:6,toolCallCount:15}),{writer:true,reflection:true,harvest:true});
  assert.deepEqual(evaluateTurn({completedRuns:9,contentLength:99,messageCount:4,toolCallCount:14}),{writer:false,reflection:true,harvest:false});
  assert.equal(evaluateTurn({completedRuns:10,contentLength:100,messageCount:5,toolCallCount:15,harvestEnabled:false}).harvest,false);
  assert.throws(()=>evaluateTurn({completedRuns:-1,contentLength:0,messageCount:0,toolCallCount:0}),/INVALID_TURN_COUNTS/);
});
