import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';

// Always stop the watcher, including when its current value cannot be read.
export async function readConversationEntries(conversation){
  const watch=await conversation.watch(BACKGROUND_CONTEXT);
  try{return [...watch.value.entries];}
  finally{await watch.stop();}
}

export function conversationText(entry){
  return (entry?.model||[]).flatMap(message=>typeof message.content==='string'?[message.content]:Array.isArray(message.content)?message.content.filter(part=>part.type==='text').map(part=>part.text):[]).join('\n');
}
