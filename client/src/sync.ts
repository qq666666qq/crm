export type SyncEvent = { action: string; entity?: string; entity_id?: string; base_version?: number; version?: number | null; changes?: Record<string, unknown> };
const safe: Record<string, string[]> = {
  companies: ['industry', 'country', 'company_type', 'company_size', 'relationship_status'],
  opportunities: ['product_summary', 'requirement_notes', 'stage'],
  leads: ['title', 'intent_level', 'product_interest'],
  follow_up_tasks: ['title', 'priority', 'status', 'due_at']
};
export function mergeEvent(current: Record<string, any> | undefined, event: SyncEvent): { status: 'merged' | 'stale' | 'refetch'; value?: Record<string, any> } {
  if (!current || current.id !== event.entity_id || event.action !== 'updated' || !Number.isInteger(event.version) || !Number.isInteger(event.base_version) || !event.changes || typeof event.changes !== 'object' || Array.isArray(event.changes)) return { status: 'refetch' };
  if (!Number.isInteger(current.version)) return { status: 'refetch' };
  if (current.version >= Number(event.version)) return { status: 'stale' };
  if (event.base_version !== current.version || event.version !== current.version + 1) return { status: 'refetch' };
  if (!Object.keys(event.changes).every(k => safe[event.entity || '']?.includes(k) && (event.changes![k] === null || typeof event.changes![k] === 'string'))) return { status: 'refetch' };
  return { status: 'merged', value: { ...current, ...event.changes, version: event.version } };
}
const independent = new Set(['name', 'industry', 'country', 'company_type', 'company_size', 'relationship_status', 'source']);
export function threeWay(base: Record<string, any>, local: Record<string, any>, remote: Record<string, any>) {
  const merged = { ...remote }; const conflicts: string[] = [];
  for (const key of Object.keys(local)) {
    const localChanged = JSON.stringify(local[key]) !== JSON.stringify(base[key]);
    const remoteChanged = JSON.stringify(remote[key]) !== JSON.stringify(base[key]);
    if (localChanged && remoteChanged && JSON.stringify(local[key]) !== JSON.stringify(remote[key])) { conflicts.push(key); merged[key] = local[key]; }
    else if (localChanged && remoteChanged && JSON.stringify(local[key]) === JSON.stringify(remote[key])) merged[key] = local[key];
    else if (localChanged && remoteChanged === false) { merged[key] = local[key]; if (!independent.has(key)) conflicts.push(key); }
  }
  return { merged, conflicts };
}
