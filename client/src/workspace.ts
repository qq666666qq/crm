import type { QueryClient } from '@tanstack/react-query';

export async function clearWorkspaceCache(client: QueryClient) {
  await client.cancelQueries();
  client.clear();
}
