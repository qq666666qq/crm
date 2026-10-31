import {test} from 'node:test';import assert from 'node:assert/strict';
import {createEvolutionLock} from './evolution-lock.mjs';

test('自进化回放串行执行，取消排队任务不会阻塞后续任务',async()=>{
 const lock=createEvolutionLock(),firstSignal=new AbortController(),secondSignal=new AbortController(),order=[];let releaseFirst,started;
 const firstStarted=new Promise(resolve=>{started=resolve;}),first=lock.run(firstSignal.signal,async()=>{order.push('first');started();await new Promise(resolve=>{releaseFirst=resolve;});});
 await firstStarted;const second=lock.run(secondSignal.signal,async()=>{order.push('second');});const third=lock.run(new AbortController().signal,async()=>{order.push('third');});
 secondSignal.abort();await assert.rejects(second,/EVOLUTION_ABORTED/);assert.deepEqual(order,['first']);releaseFirst();await Promise.all([first,third]);assert.deepEqual(order,['first','third']);
});
