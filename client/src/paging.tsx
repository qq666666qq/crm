import React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, queryKey } from './api';
import { Entity, routes } from './definitions';

export const PAGE_SIZE = 20;
export function distinctItems(pages: {items:any[]}[] = []) {
  const seen = new Set<string>();
  return pages.flatMap(page => page.items).filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id); return true;
  });
}
export function nextPageOffset(last:{items:any[]}, pageCount:number) {
  return last.items.length === PAGE_SIZE ? pageCount * PAGE_SIZE : undefined;
}
export function usePagedRecords(tenant:string, entity:Entity, kind:string, params:string, enabled=true, endpoint?:string) {
  return useInfiniteQuery({
    queryKey:queryKey(tenant,entity,kind,`${endpoint || routes[entity]}?${params}`), enabled,
    initialPageParam:0,
    queryFn:({pageParam})=>api(`${endpoint || routes[entity]}?${params}${params?'&':''}limit=${PAGE_SIZE}&offset=${pageParam}`),
    getNextPageParam:(last, pages)=>nextPageOffset(last, pages.length)
  });
}
export function nearBottom(element:Pick<HTMLElement,'scrollHeight'|'scrollTop'|'clientHeight'>) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 100;
}
export function PageFooter({query}:{query:ReturnType<typeof usePagedRecords>}) {
  if (query.isError && !query.data) return <button type="button" className="text-button" onClick={()=>void query.refetch()}>加载失败，重试</button>;
  if (query.isFetchingNextPage) return <p className="muted small">正在加载…</p>;
  if (query.isFetchNextPageError) return <button type="button" className="text-button" onClick={()=>void query.fetchNextPage({cancelRefetch:false})}>加载失败，重试</button>;
  if (query.hasNextPage) return <button type="button" className="text-button" onClick={()=>void query.fetchNextPage({cancelRefetch:false})}>加载更多</button>;
  return query.data?.pages?.length ? <p className="muted small">已显示全部</p> : null;
}
export function loadOnScroll(event:React.UIEvent<HTMLElement>, query:ReturnType<typeof usePagedRecords>) {
  if (nearBottom(event.currentTarget) && query.hasNextPage && !query.isFetching && !query.isFetchNextPageError) void query.fetchNextPage({cancelRefetch:false});
}
