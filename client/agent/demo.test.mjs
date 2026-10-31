import {test} from 'node:test';import assert from 'node:assert/strict';import {searchDemo} from './demo.mjs';
test('演示检索保留来源并明确标记演示数据',()=>{const rows=searchDemo('报价');assert.equal(rows.length,1);assert.equal(rows[0].demo,true);assert.equal(rows[0].source,'演示资料 02');assert.deepEqual(searchDemo('不存在的词'),[])});
