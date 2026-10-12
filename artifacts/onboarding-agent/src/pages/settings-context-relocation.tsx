import { useSyncExternalStore } from 'react';
import { Redirect, useSearch } from 'wouter';
import { legacyContextHistoryDestination } from '@/lib/context-history-navigation';

function subscribeHash(callback: () => void) {
  // Wouter's History navigation emits pushState/replaceState, not hashchange.
  const events = ['hashchange', 'popstate', 'pushState', 'replaceState'];
  for (const event of events) window.addEventListener(event, callback);
  return () => {
    for (const event of events) window.removeEventListener(event, callback);
  };
}

export function SettingsContextRelocation({ children }: { children: React.ReactNode }) {
  const search = useSearch();
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const destination = legacyContextHistoryDestination(search, hash);
  return destination ? <Redirect to={destination} replace /> : <>{children}</>;
}
