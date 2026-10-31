import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEvolutionReplay,boundComparisonTrace} from './evolution-replay.mjs';

test('回放只使用完全匹配且仍获授权的历史结果，相同参数结果不一致时不回放',async()=>{
 const replay=createEvolutionReplay(),tool=replay.tools.find(item=>item.name==='replay_crm_search'),args={resource:'companies',query:'示例'};let allowed=true;
 replay.set([{name:'crm_search',arguments:args,result:'结果',sources:[]}],async()=>allowed);
 assert.equal((await tool.execute(args)).output[0].text,'结果');assert.equal(replay.calls()[0].result,undefined);assert.equal(replay.comparisonCalls()[0].result,'结果');allowed=false;
 assert.match((await tool.execute(args)).output[0].text,/没有可用/);
 assert.equal(replay.comparisonCalls()[1].result,undefined);
 allowed=true;replay.set([{name:'crm_search',arguments:args,result:'结果一',sources:[]},{name:'crm_search',arguments:args,result:'结果二',sources:[]}],async()=>allowed);
 assert.match((await tool.execute(args)).output[0].text,/没有可用/);
 assert.equal(replay.calls()[0].status,'unavailable');replay.clear();
});

test('比较轨迹限制结果长度并标注没有提供的内容',()=>{const items=boundComparisonTrace([{name:'one',result:'1234'},{name:'two',result:'5678'},{name:'three',status:'unavailable'}],6);assert.equal(items[0].result,'1234');assert.equal(items[1].result,undefined);assert.equal(items[1].resultStatus,'omitted_for_length');assert.equal(items[2].status,'unavailable');});
