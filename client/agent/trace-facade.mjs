// Presents saved and reconstructed traces through one interface.
export function createTraceFacade({traceStore,traceHistory,sessions}){
 traceStore.setHistoricalLookup(id=>traceHistory.get(id));
 return {
  async traceSave(detail){await traceStore.save(detail);},
  async tracePage(value){const page=await traceStore.page(value);return {items:page.items.map(item=>({id:item.detail.id,state:item.state,error:item.error})),next:page.next};},
  async traceHistoryPage(value){const page=await traceHistory.page(value),items=[];for(const detail of page.items)items.push({id:detail.id,...await traceStore.delivery(detail.id,value.target),reconstructed:true});return {items,next:page.next};},
  async traceConversations(){return [...sessions.known().keys()];},
  async traceGet(value){const existing=await traceStore.get(value.id,value.target);if(existing)return existing;const detail=await traceHistory.get(value.id);return detail?{detail,...await traceStore.delivery(detail.id,value.target)}:null;},
  async traceMark(value){return traceStore.mark(value.id,value.target,value.state,value.error||null);}
 };
}
