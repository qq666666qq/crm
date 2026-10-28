import { describe, expect, it, vi } from 'vitest';
import { distinctItems, nearBottom, nextPageOffset, loadOnScroll } from './paging';

describe('paged columns', () => {
  it('deduplicates records across pages and stops after a short page', () => {
    expect(distinctItems([{items:[{id:'1'},{id:'2'}]},{items:[{id:'2'},{id:'3'}]}]).map(x=>x.id)).toEqual(['1','2','3']);
    expect(nextPageOffset({items:Array.from({length:20},(_,i)=>({id:i}))}, 2)).toBe(40);
    expect(nextPageOffset({items:[{id:1}]}, 2)).toBeUndefined();
  });
  it('loads only near the bottom when no request or error is pending', () => {
    const fetchNextPage=vi.fn();
    const query={hasNextPage:true,isFetching:false,isFetchNextPageError:false,fetchNextPage};
    const event={currentTarget:{scrollHeight:1000,scrollTop:0,clientHeight:300}};
    expect(nearBottom(event.currentTarget)).toBe(false);
    loadOnScroll(event as any,query as any); expect(fetchNextPage).not.toHaveBeenCalled();
    event.currentTarget.scrollTop=650;
    loadOnScroll(event as any,query as any); expect(fetchNextPage).toHaveBeenCalledTimes(1);
    loadOnScroll(event as any,{...query,isFetching:true} as any);
    loadOnScroll(event as any,{...query,isFetchNextPageError:true} as any);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
