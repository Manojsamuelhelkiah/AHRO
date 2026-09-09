import { customFetch } from '@workspace/api-client-react';

export function portalAdminRequest<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  return customFetch<T>(url, {
    credentials: 'include',
    ...init,
  });
}