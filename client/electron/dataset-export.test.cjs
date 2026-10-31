const {test}=require('node:test');const assert=require('node:assert/strict');const {datasetCsv}=require('./dataset-export.cjs');
test('CSV 生成包含明确的输入及期望输出列并正确转义',()=>{const csv=datasetCsv([{input:'客户说："需要样品"\n请回复',expected:'确认样品'}]);assert.equal(csv,'\ufeffinput,expected_output\r\n"客户说：""需要样品""\n请回复","确认样品"\r\n');});
test('禁止将表格公式和非预期字段导出',()=>{assert.throws(()=>datasetCsv([{input:'=1+1',expected:'示例'}]));assert.throws(()=>datasetCsv([{input:'正常',expected:'示例',token:'secret'}]));});
