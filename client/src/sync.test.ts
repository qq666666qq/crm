import { describe, expect, it } from 'vitest';
import { mergeEvent, threeWay } from './sync';
import { stageRequest, canEdit, editorRequest } from './actions';
import { QueryClient } from '@tanstack/react-query';
import { clearWorkspaceCache } from './workspace';

describe('incremental synchronization', () => {
  it('merges only consecutive, allowlisted updates', () => {
    const current = { id: '1', version: 5, industry: 'old' };
    expect(mergeEvent(current, { action: 'updated', entity: 'companies', entity_id: '1', base_version: 5, version: 6, changes: { industry: 'new' } })).toEqual({ status: 'merged', value: { ...current, version: 6, industry: 'new' } });
    expect(mergeEvent(current, { action: 'updated', entity: 'companies', entity_id: '1', base_version: 4, version: 5, changes: { industry: 'old' } }).status).toBe('stale');
    expect(mergeEvent(current, { action: 'updated', entity: 'companies', entity_id: '1', base_version: 6, version: 7, changes: { industry: 'later' } }).status).toBe('refetch');
    expect(mergeEvent(current, { action: 'updated', entity: 'companies', entity_id: '1', base_version: 5, version: 6, changes: { tenant_id: 'forged' } }).status).toBe('refetch');
  });
  it('preserves draft and reports same-field conflicts', () => {
    const base = { industry: 'A', country: 'UK' };
    const local = { industry: 'B', country: 'UK' };
    const remote = { industry: 'C', country: 'France' };
    const result = threeWay(base, local, remote);
    expect(result.conflicts).toEqual(['industry']);
    expect(result.merged).toEqual({ industry: 'B', country: 'France' });
    expect(local).toEqual({ industry: 'B', country: 'UK' });
  });
});


it('uses the latest remote state as the base for a second conflict', () => {
  const base = {industry:'A', country:'UK'};
  const local = {industry:'B', country:'UK'};
  const firstRemote = {industry:'C', country:'UK'};
  const first = threeWay(base, local, firstRemote);
  expect(first.conflicts).toEqual(['industry']);
  const secondRemote = {industry:'C', country:'France'};
  const second = threeWay(firstRemote, first.merged, secondRemote);
  expect(second.conflicts).toEqual([]);
  expect(second.merged).toEqual({industry:'B', country:'France'});
});

it('selects the server stage operation and keeps the version', () => {
  const record = {id:'123', version:4};
  expect(stageRequest(record,'quoting','')).toEqual({path:'/opportunities/123/stage',body:{expected_version:4,stage:'quoting'}});
  expect(stageRequest(record,'won','')).toEqual({path:'/opportunities/123/close-won',body:{expected_version:4,note:null}});
  expect(stageRequest(record,'lost','price')).toEqual({path:'/opportunities/123/close-lost',body:{expected_version:4,reason:'price'}});
  expect(()=>stageRequest(record,'lost',' ')).toThrow();
  expect(()=>stageRequest(record,'other','')).toThrow();
});


it('cancels an in-flight query and removes tenant data from the query cache', async () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  client.setQueryData(['tenant-A','companies','detail','1'], {name:'private'});
  let aborted = false;
  const promise = client.fetchQuery({queryKey:['tenant-A','companies','pending'], queryFn:({signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>{aborted=true; reject(new Error('aborted'));},{once:true});})}).catch(()=>undefined);
  await clearWorkspaceCache(client);
  await promise;
  expect(aborted).toBe(true);
  expect(client.getQueryData(['tenant-A','companies','detail','1'])).toBeUndefined();
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});


it('allows version-protected activity editing and creation', () => {
  expect(canEdit('activities',{id:'a',version:1})).toBe(true);
  expect(editorRequest('activities')).toEqual({path:'/activities',method:'POST'});
  expect(editorRequest('activities',{id:'a',version:1})).toEqual({path:'/activities/a',method:'PATCH'});
  expect(editorRequest('companies',{id:'b'})).toEqual({path:'/companies/b',method:'PATCH'});
});
