export type ProgressSection = 'current-work' | 'history';

const LABELS: Record<string, string> = {
  overview: 'Overview', context: 'Transaction context', 'transaction-context': 'Transaction context', communications: 'Communications',
  documents: 'Documents', approvals: 'Overview', audit: 'Audit', frontline: 'Frontline',
  'early-tenure': 'Early tenure', 'ask-ai': 'Ask AI',
};
const TAB_SLUGS: Record<string, string> = {
  Overview: 'overview', 'Transaction context': 'context', Communications: 'communications',
  Documents: 'documents', Audit: 'audit', Frontline: 'frontline',
  'Early tenure': 'early-tenure', 'Ask AI': 'ask-ai', Progress: 'progress',
};

/** Legacy destinations remain meaningful, but never create a second Progress tab. */
export function caseDestination(tab: string, section?: string) {
  const name = tab.toLowerCase();
  if (['tasks', 'activity', 'progress'].includes(name)) {
    return { tab: 'Progress', section: (name === 'activity' || section === 'history'
      ? 'history' : 'current-work') as ProgressSection };
  }
  return { tab: LABELS[name] || Object.values(LABELS).find(label => label.toLowerCase() === name) || tab, section: undefined };
}

export function caseDestinationFromSearch(search: string) {
  const params = new URLSearchParams(search);
  const destination = caseDestination(params.get('tab') || 'overview', params.get('section') || undefined);
  return destination.tab === 'Progress' || Object.values(LABELS).includes(destination.tab)
    ? destination : caseDestination('overview');
}

export function caseSectionSearch(search: string, tab: string, section?: string) {
  const target = caseDestination(tab, section);
  const params = new URLSearchParams(search);
  const slug = TAB_SLUGS[target.tab] || target.tab.toLowerCase().replaceAll(' ', '-');
  params.set('tab', slug);
  if (target.section) params.set('section', target.section);
  else params.delete('section');
  return `?${params.toString()}`;
}
