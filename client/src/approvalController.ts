// The desktop bridge validates the request fields before returning an approval.
export type ApprovalItem = {id:string;type:string;status:string;digest:string;runId?:string;message?:string;request:{path:string;body:any}};
export type ApprovalAction = 'confirm'|'reject';

type Dependencies = {
  list:()=>Promise<ApprovalItem[]>;
  decide:(action:ApprovalAction,id:string,digest:string)=>Promise<{status:string;message?:string}>;
  invalidate:()=>Promise<unknown>;
  onItems:(items:ApprovalItem[])=>void;
  onNotice:(message:string)=>void;
  onError:(message:string)=>void;
  onBusy:(busy:boolean)=>void;
};

// A stopped controller cannot publish results from its previous page or session.
export function createApprovalController(deps:Dependencies) {
  let active=false,lifecycle=0,latestRefresh=0;
  const isCurrent=(version:number)=>active&&version===lifecycle;

  async function refresh() {
    if(!active)return;
    const version=lifecycle,request=++latestRefresh;
    try {
      const items=await deps.list();
      if(isCurrent(version)&&request===latestRefresh)deps.onItems(items);
    } catch {
      if(isCurrent(version)&&request===latestRefresh)deps.onError('无法读取待确认操作。');
    }
  }

  async function decide(id:string,action:ApprovalAction,digest:string) {
    if(!active)return;
    const version=lifecycle;
    deps.onBusy(true);deps.onError('');deps.onNotice('');
    try {
      const result=await deps.decide(action,id,digest);
      if(!isCurrent(version))return;
      if(result.status==='failed'||result.status==='retry')deps.onError(result.message||'操作未完成');
      else deps.onNotice(result.status==='succeeded'?'操作已完成。':'已拒绝，未执行写入。');
      await refresh();
      if(isCurrent(version))await deps.invalidate();
    } catch {
      if(isCurrent(version))deps.onError('操作未完成，请检查网络或权限后重试。');
    } finally {
      if(isCurrent(version))deps.onBusy(false);
    }
  }

  return {
    start(){if(!active){active=true;lifecycle++;void refresh();}},
    stop(){active=false;lifecycle++;latestRefresh++;},
    refresh,
    decide,
  };
}
