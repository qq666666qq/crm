export {};
declare global {
  interface Window {
    crm: {
      authAction(action: string, body: unknown): Promise<Result>;
      tenants(): Promise<Result>;
      login(email: string, password: string): Promise<Result>;
      selectTenant(id: string): Promise<Result>;
      request(path: string, method?: string, body?: unknown): Promise<Result>;
      logout(): Promise<boolean>;
      refresh(): Promise<Result>;
      notify(title: string, body: string): Promise<void>;
      on(channel: 'sync' | 'revoked' | 'connection' | 'permission', handler: (data: any) => void): () => void;
    };
  }
  type Result = { ok: true; data: any } | { ok: false; status: number; error: { code: string; message: string } };
}
