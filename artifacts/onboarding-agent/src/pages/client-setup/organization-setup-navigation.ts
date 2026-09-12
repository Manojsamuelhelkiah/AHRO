export type OrganizationSetupAction = 'create' | 'join' | null;

export function organizationActionFromSearch(search: string): OrganizationSetupAction {
  const requested = new URLSearchParams(search).get('organizationAction');
  return requested === 'create' || requested === 'join' ? requested : null;
}

export function organizationSetupNavigation(
  pathname: string,
  search: string,
  hash: string,
): string {
  const nextSearch = new URLSearchParams(search);
  nextSearch.delete('organizationAction');
  const query = nextSearch.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

export function organizationSetupNavigationNeedsReload(
  currentUrl: string,
  nextUrl: string,
): boolean {
  return currentUrl === nextUrl;
}