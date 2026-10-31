import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {defineDoc} from '@earendil-works/pi-durable';

const ChatIndex=defineDoc({kind:'crm.chat-index',version:1,scope:'session',initial:()=>({items:[]}),checkpointWhen:()=>true});

export async function openConversations({harness,model,initialExtensions,isBusy}) {
  let current=await harness.root(BACKGROUND_CONTEXT,{agent:{extensions:initialExtensions}});
  await current.configure({extensions:initialExtensions},BACKGROUND_CONTEXT);
  const conversations=new Map();
  const savedChats=await harness.snapshot(ChatIndex,BACKGROUND_CONTEXT);
  for(const item of savedChats?.items||[]){
    const conversation=await harness.conversation(item.id,BACKGROUND_CONTEXT);
    if(conversation)conversations.set(String(conversation.id),{conversation,title:item.title});
  }
  if(!conversations.has(String(current.id)))conversations.set(String(current.id),{conversation:current,title:'新对话'});

  async function persist(){
    const items=[...conversations.values()].map(item=>({id:item.conversation.id,title:item.title}));
    await harness.commit(async tx=>{const doc=await tx.doc(ChatIndex);doc.items=items;},BACKGROUND_CONTEXT);
  }
  return {
    get current(){return current;},
    get(id){return conversations.get(String(id))?.conversation;},
    known(){return new Map([...conversations].map(([id,item])=>[id,item.conversation.id]));},
    list(){return [...conversations.entries()].map(([id,item])=>({id,title:item.title}));},
    persist,
    async create(extensions){
      if(isBusy())throw Error('BUSY');
      current=await harness.createConversation({ownership:{kind:'ownerless'},agent:{model,extensions}},BACKGROUND_CONTEXT);
      conversations.set(String(current.id),{conversation:current,title:'新对话'});
      await persist();
      return {id:String(current.id)};
    },
    async select(id,extensions){
      if(isBusy())throw Error('BUSY');
      const item=conversations.get(String(id));
      if(!item)throw Error('NOT_FOUND');
      current=item.conversation;
      await current.configure({extensions},BACKGROUND_CONTEXT);
      return {id:String(current.id)};
    },
    async titleFromMessage(message){
      const item=conversations.get(String(current.id));
      if(item&&item.title==='新对话'){item.title=message.slice(0,30);await persist();}
    },
  };
}
