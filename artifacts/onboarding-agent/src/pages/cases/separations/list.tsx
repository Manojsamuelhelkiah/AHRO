import { Redirect, useSearch } from 'wouter';
import { legacySeparationsDestination } from '../list-navigation';

/** Compatibility entry only. Browsing must never provision or activate cases. */
export function SeparationsListPage() {
  const search = useSearch();
  return <Redirect replace to={legacySeparationsDestination(search, window.location.hash)} />;
}
