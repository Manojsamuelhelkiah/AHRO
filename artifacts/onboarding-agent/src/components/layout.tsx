import React, { useMemo } from 'react';
import { Link, useLocation } from 'wouter';
import { useClerk, useUser } from '@clerk/react';
import { useGetOnboardingChannels, getGetOnboardingChannelsQueryKey } from '@workspace/api-client-react';
import { cn } from './ui-shared';
import { LayoutDashboard, Users, CheckSquare, Server, BarChart3, LogOut, AlertTriangle, Settings, Shield, Bell, Search, Hexagon } from 'lucide-react';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/cases', label: 'Cases', icon: Users },
  { path: '/approvals', label: 'Approvals', icon: CheckSquare },
  { path: '/systems', label: 'Systems', icon: Server },
  { path: '/guardrails', label: 'Guardrails', icon: Shield },
  { path: '/analytics', label: 'Analytics', icon: BarChart3 },
  { path: '/settings', label: 'Settings', icon: Settings },
];

function getPageName(path: string) {
  if (path === '/') return 'Dashboard';
  const item = NAV_ITEMS.find(n => path.startsWith(n.path) && n.path !== '/');
  if (item) return item.label;
  if (path.startsWith('/cases/')) return 'Case Details';
  return 'Page';
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const pageName = getPageName(location);
  const isDashboard = location === '/';
  
  const { user } = useUser();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  
  const initials = (user?.fullName || user?.primaryEmailAddress?.emailAddress || 'U')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const role = typeof window !== 'undefined' ? localStorage.getItem('hro_role') || 'Reviewer' : 'Reviewer';

  return (
    <div className={cn("flex min-h-screen w-full transition-colors duration-300", isDashboard ? "dark" : "")} style={{ backgroundColor: 'var(--surface-alt)', color: 'var(--text-primary)' }}>
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
        
        <nav className="flex-1 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
            return (
              <Link key={item.path} href={item.path} 
                className="flex items-center group transition-colors block"
                style={{
                  height: '36px',
                  padding: '0 var(--space-lg)',
                  marginBottom: '2px',
                  outline: 'none'
                }}
              >
                <div className={cn("flex items-center w-full h-full transition-colors", isActive && "rounded-r-[var(--radius-sm)]")}
                  style={{
                    backgroundColor: isActive ? 'var(--primary-light)' : 'transparent',
                    borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                    color: isActive ? 'var(--primary)' : 'var(--text-secondary)'
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'var(--surface-soft)';
                      e.currentTarget.style.color = 'var(--primary)';
                      const icon = e.currentTarget.querySelector('svg');
                      if (icon) icon.style.color = 'var(--primary)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                      e.currentTarget.style.color = 'var(--text-secondary)';
                      const icon = e.currentTarget.querySelector('svg');
                      if (icon) icon.style.color = 'var(--text-muted)';
                    }
                  }}
                >
                  <item.icon 
                    className="h-4 w-4 shrink-0 transition-colors" 
                    style={{ 
                      color: isActive ? 'var(--primary)' : 'var(--text-muted)',
                      marginLeft: isActive ? '13px' : '16px',
                      marginRight: '10px'
                    }} 
                  />
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: isActive ? 600 : 500 }}>{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        <div style={{ padding: 'var(--space-md) var(--space-lg)', borderTop: '1px solid var(--border)' }} className="flex items-center gap-3">
          <div className="w-[32px] h-[32px] rounded-full flex items-center justify-center font-bold shrink-0" style={{ backgroundColor: 'var(--primary)', color: '#ffffff', fontSize: 'var(--text-sm)' }}>
            {initials || 'U'}
          </div>
          <div className="overflow-hidden flex-1 flex flex-col items-start">
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }} className="truncate max-w-full">
              {user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Signed in'}
            </span>
            <span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', backgroundColor: 'var(--primary-light)', color: 'var(--primary)', borderRadius: '999px', marginTop: '2px', lineHeight: 1 }} className="font-semibold truncate max-w-full">
              {role}
            </span>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 transition-colors duration-300">
        <MonitorAlertBanner />
        
        <header className="sticky top-0 z-30 flex items-center justify-between px-6 shrink-0 transition-colors duration-300" style={{ height: '48px', backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <span>Agentic HRO Suite</span>
            <span>/</span>
            <span style={{ color: 'var(--text-primary)' }}>{pageName}</span>
          </div>
          
          <div className="hidden md:flex flex-1 justify-center">
            <div className="relative" style={{ width: '280px' }}>
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
            <div className="relative cursor-pointer">
              <Bell className="h-4 w-4" style={{ color: 'var(--text-secondary)' }} />
              <div className="absolute top-0 right-0 w-2 h-2 rounded-full border-2" style={{ backgroundColor: 'var(--status-amber)', borderColor: 'var(--surface)' }} />
            </div>
            <div className="flex items-center gap-2">
              <div className="w-[24px] h-[24px] rounded-full flex items-center justify-center font-bold shrink-0" style={{ backgroundColor: 'var(--primary)', color: '#ffffff', fontSize: 'var(--text-xs)' }}>
                {initials || 'U'}
              </div>
              <span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', backgroundColor: 'var(--primary-light)', color: 'var(--primary)', borderRadius: '999px', lineHeight: 1 }} className="font-semibold hidden md:block">
                {role}
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
