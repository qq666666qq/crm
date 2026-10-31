export {};
declare global {
  interface Window {
    crm: {
      authAction(action: string, body: unknown): Promise<Result>;
      tenants(): Promise<Result>;
      login(email: string, password: string): Promise<Result>;
      restoreSession(): Promise<Result>;
      selectTenant(id: string): Promise<Result>;
      request(path: string, method?: string, body?: unknown): Promise<Result>;
      logout(): Promise<boolean>;
      refresh(): Promise<Result>;
      notify(title: string, body: string): Promise<void>;
      openEgoInstallGuide(): Promise<void>;
      agent(action: 'conversations'|'new-conversation'|'select-conversation'|'evolve'|'evolution-history'|'evolution-tasks'|'evolution-decide'|'presets'|'select-preset'|'demo-search'|'demo-lead'|'configure-model'|'chat'|'history'|'migration-status'|'traces'|'privacy-mode'|'privacy-status'|'legacy-location'|'memory-status'|'memory-page'|'memory-skills'|'memory-sources'|'memory-review'|'memory-update'|'memory-search'|'memory-semantic'|'memory-semantic-model'|'memory-harvest'|'memory-retry'|'memory-publish'|'memory-reject'|'memory-rollback'|'harness2-state'|'harness2-history'|'harness2-run'|'harness2-promote'|'harness2-rollback', value?: string | string[] | number | boolean | Record<string,unknown> | {input:string;expected:string}[]): Promise<any>;
      modules(action: 'list'|'preview'|'install', value?: unknown, revision?: string): Promise<any>;
      moduleRecords(action: 'list'|'create'|'update'|'delete', id: string, value?: Record<string,unknown>): Promise<any>;
      mockSync(action: 'list'|'run'|'config'|'enable'|'disable', destination?: string, key?: string): Promise<any>;
      mockBackground(action:'start'|'stop'|'status', target?:string): Promise<any>;
      exportDataset(cases: {input:string;expected:string}[]): Promise<{saved:boolean}>;
      exportTraces(): Promise<{saved:boolean}>;
      approvals(action: 'list'|'confirm'|'reject', id?: string, digest?: string): Promise<any>;
      langfuse(action: 'config'|'status'|'upload', value?: {baseUrl?:string;publicKey?:string;secretKey?:string;autoUpload?:boolean}): Promise<{configured?:boolean;baseUrl?:string;autoUpload?:boolean;pending?:number;uploaded?:number;failed?:number;total?:number;lastError?:string|null}>;
      on(channel: 'sync' | 'revoked' | 'connection' | 'permission' | 'approval' | 'evolution-progress' | 'memory-progress' | 'langfuse-status' | 'agent-status', handler: (data: any) => void): () => void;
    };
  }
  type Result = { ok: true; data: any } | { ok: false; status: number; error: { code: string; message: string } };
}
