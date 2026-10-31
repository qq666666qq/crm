const MODEL='text-embedding-3-small';
function valid(vector){return Array.isArray(vector)&&vector.length>0&&vector.length<=8192&&vector.every(value=>typeof value==='number'&&Number.isFinite(value));}
function cosine(left,right){if(left.length!==right.length)return -1;let dot=0,a=0,b=0;for(let i=0;i<left.length;i++){dot+=left[i]*right[i];a+=left[i]*left[i];b+=right[i]*right[i];}return a&&b?dot/Math.sqrt(a*b):-1;}

export function createMemorySearch({repo,enabled,embed,model=MODEL}){
 return async function search(query,{limit=20,signal}={}){
  const keyword=await repo.search(query,{limit});
  if(!await enabled())return {...keyword,reason:'disabled'};
  try{
   const modelId=typeof model==='function'?await model():model;const rows=[],missing=[];let after=0,end=false;while(!end){const page=await repo.embeddingPage(modelId,{after,limit:100});rows.push(...page.items);after=page.next;end=page.end;}
   for(const row of rows){if(row.vector==null&&missing.length<20&&await repo.get(row.id))missing.push(row);}
   const vectors=await embed([query,...missing.map(row=>row.content.slice(0,2000))],modelId,signal);
   if(signal?.aborted||!await enabled()||(typeof model==='function'&&await model()!==modelId))throw Error('EMBEDDING_CANCELLED');
   if(!Array.isArray(vectors)||vectors.length!==missing.length+1||vectors.some(vector=>!valid(vector)||vector.length!==vectors[0].length))throw Error('INVALID_EMBEDDING');
   for(let i=0;i<missing.length;i++){await repo.saveEmbedding(missing[i],modelId,vectors[i+1]);missing[i].vector=JSON.stringify(vectors[i+1]);missing[i].dimensions=vectors[i+1].length;}
   const ranked=[];for(const row of rows){let vector;try{vector=JSON.parse(row.vector);}catch{continue;}if(!valid(vector)||row.dimensions!==vector.length)continue;const score=cosine(vectors[0],vector);if(score>0.2)ranked.push({id:row.id,score});}
   ranked.sort((a,b)=>b.score-a.score);
   const scores=new Map();keyword.items.forEach((item,index)=>scores.set(item.id,(scores.get(item.id)||0)+1/(60+index+1)));ranked.forEach((item,index)=>scores.set(item.id,(scores.get(item.id)||0)+1/(60+index+1)));
   const keywordMatches=new Map(keyword.items.map(item=>[item.id,item.match_type]));const items=[];for(const [id] of [...scores].sort((a,b)=>b[1]-a[1])){const item=await repo.get(id);if(item?.status==='active')items.push({...item,match_type:keywordMatches.get(id)||'semantic'});if(items.length>=limit)break;}
   return {items,mode:'hybrid',partial:rows.some(row=>row.vector==null)};
  }catch(error){return {...keyword,reason:error?.message==='MODEL_NOT_CONFIGURED'?'not_configured':'unavailable'};}
 };
}

export function createOpenAIEmbedder(getKey,fetchImpl=globalThis.fetch){
 return async(texts,model=MODEL,signal)=>{
  const key=getKey();if(!key)throw Error('MODEL_NOT_CONFIGURED');
  if(!Array.isArray(texts)||!texts.length||texts.length>21||texts.some(text=>typeof text!=='string'||!text.trim()||text.length>2000))throw Error('INVALID_EMBEDDING_INPUT');
  const timeout=AbortSignal.timeout(30000);const response=await fetchImpl('https://api.openai.com/v1/embeddings',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,input:texts,encoding_format:'float'}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response.ok)throw Error('EMBEDDING_UNAVAILABLE');const data=await response.json();
  if(!Array.isArray(data.data)||data.data.length!==texts.length)throw Error('INVALID_EMBEDDING');
  const ordered=[...data.data].sort((a,b)=>a.index-b.index);if(ordered.some((item,index)=>item.index!==index||!valid(item.embedding)))throw Error('INVALID_EMBEDDING');return ordered.map(item=>item.embedding);
 };
}
