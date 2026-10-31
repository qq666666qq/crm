// One replay adapter is shared by the runtime, so only one evolution attempt
// may use it at a time. Waiting attempts remain cancellable.
export function createEvolutionLock(){
 let tail=Promise.resolve();
 async function run(signal,work){
  const previous=tail;let release;const held=new Promise(resolve=>{release=resolve;});tail=previous.catch(()=>{}).then(()=>held);
  let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(Error('EVOLUTION_ABORTED'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
  try{await Promise.race([previous,stopped]);if(signal.aborted)throw Error('EVOLUTION_ABORTED');return await work();}
  finally{signal.removeEventListener('abort',abort);release();}
 }
 return {run};
}
