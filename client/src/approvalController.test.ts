import {describe,expect,it,vi} from 'vitest';
import {createApprovalController,type ApprovalAction,type ApprovalItem} from './approvalController';

function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
function item(id:string):ApprovalItem {
  return {id,type:'create_company',status:'pending',digest:'digest',request:{path:'/api/v1/companies',body:{name:id}}};
}
function dependencies(list:()=>Promise<ApprovalItem[]>) {
  return {list,decide:vi.fn(async(_action:ApprovalAction,_id:string,_digest:string):Promise<{status:string;message?:string}>=>({status:'succeeded'})),invalidate:vi.fn(async()=>{}),onItems:vi.fn(),onNotice:vi.fn(),onError:vi.fn(),onBusy:vi.fn()};
}

describe('approval controller',()=>{
  it('only publishes the newest list and ignores results after the page closes',async()=>{
    const first=deferred<ApprovalItem[]>(),second=deferred<ApprovalItem[]>(),afterClose=deferred<ApprovalItem[]>();
    const list=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(afterClose.promise);
    const deps=dependencies(list),controller=createApprovalController(deps);
    controller.start();
    const secondLoad=controller.refresh();
    second.resolve([item('new')]);await secondLoad;
    first.resolve([item('old')]);await first.promise;await Promise.resolve();
    expect(deps.onItems.mock.calls).toEqual([[[item('new')]]]);
    const closingLoad=controller.refresh();controller.stop();
    afterClose.resolve([item('closed')]);await closingLoad;
    expect(deps.onItems).toHaveBeenCalledTimes(1);
  });
  it('passes the reviewed digest and refreshes after an uncertain result',async()=>{
    const deps=dependencies(vi.fn(async()=>[]));
    deps.decide.mockResolvedValue({status:'retry',message:'结果不确定'});
    const controller=createApprovalController(deps);
    controller.start();await Promise.resolve();
    await controller.decide('approval-1','confirm','reviewed-digest');
    expect(deps.decide).toHaveBeenCalledWith('confirm','approval-1','reviewed-digest');
    expect(deps.onError).toHaveBeenLastCalledWith('结果不确定');
    expect(deps.list).toHaveBeenCalledTimes(2);
    expect(deps.invalidate).toHaveBeenCalledOnce();
    expect(deps.onBusy.mock.calls).toEqual([[true],[false]]);
  });
  it('does not update a later session when an approval finishes after stop',async()=>{
    const pending=deferred<{status:string}>();
    const deps=dependencies(async()=>[]);
    deps.decide.mockReturnValue(pending.promise);
    const controller=createApprovalController(deps);
    controller.start();
    const submitting=controller.decide('approval-1','confirm','digest');
    controller.stop();controller.start();
    pending.resolve({status:'succeeded'});await submitting;
    expect(deps.onNotice.mock.calls).toEqual([['']]);
    expect(deps.invalidate).not.toHaveBeenCalled();
    expect(deps.onBusy.mock.calls).toEqual([[true]]);
  });
});
