/** Holds source text provided by a trusted host, never model-supplied evidence IDs. */
export class EvidenceRegistry {
 #records=new Map();
 add(source,quote){
  if(!source||typeof source.sourceId!=='string'||!source.sourceId.trim()||typeof source.text!=='string'||typeof quote!=='string'||!quote.trim())throw new Error('Invalid evidence');
  const index=source.text.indexOf(quote);if(index<0)throw new Error('Quote is not present in source');
  const matches=source.text.indexOf(quote,index+1);if(matches>=0)throw new Error('Quote position is ambiguous');
  const start=Array.from(source.text.slice(0,index)).length,end=start+Array.from(quote).length;
  const record={id:`E${String(this.#records.size+1).padStart(2,'0')}`,sourceId:source.sourceId,snapshot:source.text,quote,start,end};this.#records.set(record.id,record);return {...record};
 }
 validate({evidenceId,quantity,currency,date,claims}){
  const evidence=this.#records.get(evidenceId);if(!evidence)return {status:'rejected',reason:'证据编号不存在'};
  const quote=evidence.quote;
  if(quantity!=null&&!new RegExp(`(?<![\\d.])${String(quantity).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\d.])`).test(quote))return {status:'rejected',reason:'数量与原文不一致'};
  if(currency!=null&&!quote.includes(currency))return {status:'rejected',reason:'币种与原文不一致'};
  if(date!=null&&!quote.includes(date))return {status:'rejected',reason:'日期与原文不一致'};
  if(claims?.length)return {status:'needs_review',reason:'语义性内容需要人工确认'};
  return {status:'verified',evidence:{...evidence}};
 }
}
