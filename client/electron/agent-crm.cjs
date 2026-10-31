const lists=new Set(['companies','leads','opportunities','follow-up-tasks','activities']);
const details=new Set(['companies','contacts','leads','opportunities','follow-up-tasks','activities','company-contacts']);
function readPath(operation,args){
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('无效请求');
  if(operation==='search'){
    if(!lists.has(args.resource)||Object.keys(args).some(k=>!['resource','query'].includes(k)))throw Error('无效请求');
    if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))throw Error('无效查询');
    if(args.resource==='activities'&&args.query?.trim())throw Error('沟通记录暂不支持关键词搜索');
    const params=new URLSearchParams({limit:'20',offset:'0'});if(args.query?.trim())params.set('q',args.query.trim());
    return `/api/v1/${args.resource}?${params}`;
  }
  if(operation==='get'){
    if(!details.has(args.resource)||Object.keys(args).some(k=>!['resource','id'].includes(k))||typeof args.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.id))throw Error('无效请求');
    return args.resource==='company-contacts'?`/api/v1/companies/${args.id}/contacts?limit=20`:`/api/v1/${args.resource}/${args.id}`;
  }
  throw Error('无效操作');
}
module.exports={readPath};
