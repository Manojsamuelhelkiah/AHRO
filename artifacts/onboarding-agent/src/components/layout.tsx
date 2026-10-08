import React, { useMemo } from 'react';
import { Link, useLocation } from 'wouter';
import { useClerk, useUser } from '@clerk/react';
import { useGetOnboardingChannels, getGetOnboardingChannelsQueryKey } from '@workspace/api-client-react';
import { useOrganizationRole } from '../hooks/use-organization-role';
import { cn } from './ui-shared';
import { OrganizationSwitcher } from './organization-switcher';
import { DriftNotificationBanner } from './drift-notifications';
import { TowerControl, Users, CheckSquare, Server, BarChart3, LogOut, AlertTriangle, Settings, Shield, Bell, Search, Hexagon, Compass, Presentation, Bot, FlaskConical, BookOpen, Waypoints, ClipboardCheck } from 'lucide-react';

const NAV_GROUPS: { label: string; items: { path: string; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] }[] = [
  {
    label: 'Operations',
    items: [
      { path: '/', label: 'Control Tower', icon: TowerControl },
      { path: '/cases', label: 'Cases', icon: Users },
      { path: '/workforce-transfers', label: 'Workforce Transfers', icon: Waypoints },
      { path: '/approvals', label: 'Action Center', icon: CheckSquare },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { path: '/guardrails', label: 'Guardrails', icon: Shield },
      { path: '/policy-assistant', label: 'HR Policy Assistant', icon: Search },
      { path: '/agents', label: 'AI Agents', icon: Bot },
      { path: '/analytics', label: 'Analytics', icon: BarChart3 },
      { path: '/recommendations', label: 'Recommendations', icon: FlaskConical },
    ],
  },
  {
    label: 'Platform',
    items: [
      { path: '/systems', label: 'Systems', icon: Server },
      { path: '/demo-controller', label: 'Demo Center', icon: Presentation },
      { path: '/uat-test-center', label: 'UAT Test Center', icon: ClipboardCheck },
      { path: '/learning-guide', label: 'Learning Guide', icon: BookOpen },
      { path: '/audit', label: 'Audit Trail', icon: Shield },
      { path: '/hr-policy-library', label: 'HR Policy Library', icon: BookOpen },
      { path: '/settings', label: 'Settings', icon: Settings },
      { path: '/policy-review', label: 'Policy Review', icon: Shield },
      { path: '/client-setup', label: 'Client Setup', icon: Compass },
    ],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

function getPageName(path: string) {
  if (path === '/') return 'Control Tower';
  const item = NAV_ITEMS.find(n => path.startsWith(n.path) && n.path !== '/');
  if (item) return item.label;
  if (path.startsWith('/cases/')) return 'Case Details';
  if (path.startsWith('/workforce-transfers/')) return 'Workforce Transfers';
  return 'Page';
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const pageName = getPageName(location);
  
  const { user } = useUser();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  
  const initials = (user?.fullName || user?.primaryEmailAddress?.emailAddress || 'U')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const { role } = useOrganizationRole();

  return (
    <div className="flex min-h-screen w-full transition-colors duration-300" style={{ backgroundColor: 'var(--surface-alt)', color: 'var(--text-primary)' }}>
      <aside style={{ width: '240px', backgroundColor: 'var(--surface)', borderRight: '1px solid var(--border)' }} className="flex flex-col hidden md:flex shrink-0 transition-colors duration-300">
        <div style={{ padding: 'var(--space-lg) var(--space-lg) var(--space-md)', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 text-[var(--text-lg)] font-bold" style={{ color: 'var(--primary)' }}>
            <Hexagon className="h-5 w-5 fill-current" />
            <span>Agentic HRO</span>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '2px', fontWeight: 600 }}>
            Suite
          </div>
        </div>
        
        <nav className="flex-1 overflow-y-auto" style={{ padding: 'var(--space-lg) var(--space-md)' }}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 'var(--space-lg)' }}>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  padding: '0 var(--space-sm)',
                  marginBottom: '6px',
                }}
              >
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
                  return (
                    <Link
                      key={item.path}
                      href={item.path}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-[var(--radius-sm)] transition-colors outline-none',
                        'focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-1',
                        !isActive && 'hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)]'
                      )}
                      style={{
                        height: '34px',
                        padding: '0 var(--space-sm)',
                        backgroundColor: isActive ? 'var(--surface-selected)' : 'transparent',
                        color: isActive ? 'var(--primary)' : 'var(--text-secondary)',
                        fontSize: 'var(--text-sm)',
                        fontWeight: isActive ? 600 : 500,
                      }}
                    >
                      <item.icon
                        className="h-4 w-4 shrink-0 transition-colors"
                        style={{ color: isActive ? 'var(--primary)' : 'var(--text-muted)' }}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

      </aside>

      <main className="flex-1 flex flex-col min-w-0 transition-colors duration-300">
        <MonitorAlertBanner />
        <DriftNotificationBanner />
        
        <header className="sticky top-0 z-30 flex items-center justify-between px-6 shrink-0 transition-colors duration-300" style={{ height: '48px', backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <span>Agentic HRO Suite</span>
            <span>/</span>
            <span style={{ color: 'var(--text-primary)' }}>{pageName}</span>
          </div>
          
          <div className="hidden md:flex flex-1 min-w-0 justify-center px-3">
            <div className="relative w-full max-w-[280px] min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
              <input 
                type="text" 
                placeholder="Search cases, workers, events..." 
                className="w-full pl-9 outline-none transition-all"
                style={{ 
                  height: '32px', 
                  border: '1px solid var(--border)', 
                  borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--text-sm)',
                  backgroundColor: 'var(--surface-alt)',
                  color: 'var(--text-primary)'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--primary)';
                  e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <OrganizationSwitcher />
            <div className="relative cursor-pointer">
              <Bell className="h-4 w-4" style={{ color: 'var(--text-secondary)' }} />
              <div className="absolute top-0 right-0 w-2 h-2 rounded-full border-2" style={{ backgroundColor: 'var(--status-amber)', borderColor: 'var(--surface)' }} />
            </div>
            <div className="flex items-center gap-2">
              <div className="w-[24px] h-[24px] rounded-full flex items-center justify-center font-bold shrink-0" style={{ backgroundColor: 'var(--primary)', color: '#ffffff', fontSize: 'var(--text-xs)' }}>
                {initials || 'U'}
              </div>
              <span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', backgroundColor: 'var(--primary-light)', color: 'var(--primary)', borderRadius: '999px', lineHeight: 1 }} className="font-semibold hidden md:block capitalize">
                {role || 'Reviewer'}
              </span>
            </div>
            <button
              type="button"
              title="Sign out"
              onClick={() => signOut({ redirectUrl: basePath || '/' })}
              className="shrink-0 flex items-center gap-1.5 transition-colors"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', fontWeight: 500 }}
              onMouseEnter={(e) => e.currentTarget.style.color = 'var(--status-red)'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden lg:inline">Sign out</span>
            </button>
          </div>
        </header>

        <nav className="md:hidden flex w-full max-w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain touch-pan-x border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2" aria-label="Primary navigation" tabIndex={0}>
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
            return (
              <Link
                key={item.path}
                href={item.path}
                aria-current={isActive ? 'page' : undefined}
                className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-3 text-[var(--text-xs)] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                style={{
                  backgroundColor: isActive ? 'var(--surface-selected)' : 'transparent',
                  color: isActive ? 'var(--primary)' : 'var(--text-secondary)',
                }}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto" style={{ padding: '0 var(--space-xl) var(--space-xl)' }}>
          {children}
        </div>
      </main>
    </div>
  );
}

function MonitorAlertBanner() {
  const { data } = useGetOnboardingChannels({
    query: { queryKey: getGetOnboardingChannelsQueryKey(), refetchInterval: 30_000 },
  });
  const monitor = data?.inboundEmail;
  if (!monitor || monitor.state === 'healthy' || monitor.state === 'initializing') return null;

  const message =
    monitor.state === 'stopped'
      ? 'Inbox monitoring is not running — email replies from hires are not being picked up.'
      : 'Inbox monitoring is down — email replies from hires are not being picked up.';

  return (
    <div style={{ backgroundColor: 'var(--status-red)', color: 'white', padding: '8px 16px', fontSize: 'var(--text-sm)' }} className="flex items-center gap-3 shrink-0" role="alert">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <p className="font-medium flex-1 min-w-0 truncate">{message}</p>
      <Link
        href="/systems"
        className="shrink-0 rounded-md transition-colors font-semibold uppercase tracking-wider block"
        style={{ backgroundColor: 'rgba(255,255,255,0.15)', padding: '4px 12px', fontSize: 'var(--text-xs)', outline: 'none' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.25)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.15)'}
      >
        View details
      </Link>
    </div>
  );
}
