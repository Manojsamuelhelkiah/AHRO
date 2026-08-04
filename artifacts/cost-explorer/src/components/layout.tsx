import { useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Library, 
  Workflow, 
  Calculator, 
  Settings2,
  ChevronRight,
  Menu,
  X,
  GitCompareArrows,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigation = [
    { name: "Dashboard", href: "/", icon: LayoutDashboard },
    { name: "Intent Corpus", href: "/intents", icon: Library },
    { name: "Flow Classes", href: "/flows", icon: Workflow },
    { name: "Scenario Builder", href: "/scenario", icon: Calculator },
    { name: "Compare Scenarios", href: "/compare", icon: GitCompareArrows },
    { name: "Global Assumptions", href: "/assumptions", icon: Settings2 },
  ];

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      {/* Mobile header */}
      <div className="md:hidden absolute top-0 left-0 right-0 h-14 bg-sidebar text-sidebar-foreground flex items-center justify-between px-4 z-50 border-b border-sidebar-border">
        <div className="font-bold text-lg tracking-tight flex items-center gap-2">
          <div className="w-6 h-6 bg-primary rounded-sm flex items-center justify-center">
            <Workflow className="w-4 h-4 text-primary-foreground" />
          </div>
          HRO Explorer
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="text-sidebar-foreground hover:bg-sidebar-accent">
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </div>

      {/* Sidebar */}
      <div className={`
        fixed inset-y-0 left-0 z-40 w-64 bg-sidebar text-sidebar-foreground flex flex-col transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0
        ${mobileMenuOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        <div className="h-14 md:h-16 flex items-center px-6 border-b border-sidebar-border">
          <div className="font-bold text-lg tracking-tight flex items-center gap-2">
            <div className="w-6 h-6 bg-primary rounded-sm flex items-center justify-center">
              <Workflow className="w-4 h-4 text-primary-foreground" />
            </div>
            HRO Explorer
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto py-4 px-3">
          <div className="space-y-1">
            <div className="px-3 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider mb-2">
              Cost-Benefit Model
            </div>
            {navigation.map((item) => {
              const isActive = location === item.href || 
                              (item.href !== "/" && location.startsWith(item.href));
              
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center justify-between px-3 py-2 text-sm rounded-md transition-colors ${
                    isActive 
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" 
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <item.icon className={`w-4 h-4 ${isActive ? "text-primary" : ""}`} />
                    {item.name}
                  </div>
                  {isActive && <ChevronRight className="w-4 h-4 opacity-50" />}
                </Link>
              );
            })}
          </div>
        </div>
        
        <div className="p-4 border-t border-sidebar-border">
          <div className="text-xs text-sidebar-foreground/40 font-mono">
            v2.4.0 — Architecture Ref
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden pt-14 md:pt-0">
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </main>
      </div>
      
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </div>
  );
}
