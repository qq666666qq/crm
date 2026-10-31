function datasetCsv(cases){
 if(!Array.isArray(cases)||cases.length<1||cases.length>100)throw Error('测试用例数量无效');
 const cell=value=>{if(typeof value!=='string'||value.length>4000||/^[\s]*[=+@\-\t\r]/.test(value))throw Error('测试内容无效或包含可能执行的表格公式');return '"'+value.replace(/"/g,'""')+'"';};
 const rows=cases.map(item=>{if(!item||Object.keys(item).some(k=>!['input','expected'].includes(k))||!item.input?.trim()||!item.expected?.trim())throw Error('测试用例无效');return `${cell(item.input)},${cell(item.expected)}`;});
 return '\ufeffinput,expected_output\r\n'+rows.join('\r\n')+'\r\n';
}
module.exports={datasetCsv};
