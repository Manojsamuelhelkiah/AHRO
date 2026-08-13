import React from 'react';
import { Link, useLocation } from 'wouter';
import { useClerk, useUser } from '@clerk/react';
import { cn } from './ui-shared';
import { LayoutDashboard, Users, CheckSquare, Server, BarChart3, LogOut } from 'lucide-react';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/cases', label: 'Cases', icon: Users },
  { path: '/approvals', label: 'Approvals', icon: CheckSquare },
  { path: '/systems', label: 'Systems', icon: Server },
  { path: '/analytics', label: 'Analytics', icon: BarChart3 },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="w-64 border-r bg-card flex flex-col hidden md:flex shrink-0">
        <div className="h-14 flex items-center px-6 border-b border-border">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight text-primary">
            <Server className="h-5 w-5" />
            <span>Onboard OS</span>
          </div>
        </div>
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
            return (
              <Link key={item.path} href={item.path} className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                isActive 
                  ? "bg-primary/10 text-primary" 
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <UserFooter />
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 p-6 lg:p-8 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
function UserFooter() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  const name = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Signed in';
  const initials = (user?.fullName || user?.primaryEmailAddress?.emailAddress || 'U')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  return (
    <div className="p-4 border-t border-border">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs shrink-0">
          {initials || 'U'}
        </div>
        <div className="text-sm overflow-hidden flex-1">
          <p className="font-medium truncate">{name}</p>
          <p className="text-xs text-muted-foreground truncate">Reviewer</p>
        </div>
        <button
          type="button"
          title="Sign out"
          onClick={() => signOut({ redirectUrl: basePath || '/' })}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
