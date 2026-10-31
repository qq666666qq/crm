const fs=require('node:fs/promises');
async function inspectLegacy(file){
 const files=[];for(const suffix of ['', '-wal','-shm']){const name=file+suffix;try{const info=await fs.lstat(name);if(info.isSymbolicLink()||!info.isFile())throw Error('旧会话路径不是普通文件');files.push({path:name,size:info.size});}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {path:file,files,migrationAvailable:false};
}
module.exports={inspectLegacy};
