import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EvidenceRegistry} from './evidence.mjs';
test('原文引用及数字必须来自程序登记的证据',()=>{
 const registry=new EvidenceRegistry(); const evidence=registry.add({sourceId:'MSG-2028',text:'We need 500 units at USD 20.'},'500 units');
 assert.equal(evidence.id,'E01');
 assert.equal(registry.validate({evidenceId:'E01',quantity:500}).status,'verified');
 assert.equal(registry.validate({evidenceId:'E01',quantity:600}).status,'rejected');
 assert.equal(registry.validate({evidenceId:'E99'}).status,'rejected');
 assert.throws(()=>registry.add({sourceId:'x',text:'hello'},'fake'));
});
test('引用位置按 Unicode 字符计算，并拒绝不明确的重复引用',()=>{
 const registry=new EvidenceRegistry();const item=registry.add({sourceId:'M1',text:'😀客户需要 20 件'},'20 件');
 assert.equal(item.start,6);assert.equal(item.end,10);
 assert.throws(()=>registry.add({sourceId:'M2',text:'yes yes'},'yes'));
 assert.equal(registry.validate({evidenceId:item.id,claims:['客户已经下单']}).status,'needs_review');
});
