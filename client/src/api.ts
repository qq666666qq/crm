export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export async function api(path: string, method = 'GET', body?: unknown) {
  const result = await window.crm.request('/api/v1' + path, method, body);
  if (!result.ok) throw new ApiError(result.error.code, result.error.message, result.status);
  return result.data;
}
export const queryKey = (tenant: string, entity: string, kind: string, extra: unknown = '') => [tenant, entity, kind, extra] as const;
