import React from 'react';
import Link from 'next/link';
import {
  LayoutDashboard,
  Box,
  Container,
  Globe,
  ShieldCheck,
  Database,
  TerminalSquare,
  Activity,
  Settings,
  FolderOpen,
  Terminal,
  Clock,
  ArchiveRestore
} from 'lucide-react';
import { NavItem } from '../../types';
import { cn } from '../../lib/utils';
import { usePathname } from 'next/navigation';

const navItems: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: <LayoutDashboard className="w-5 h-5" /> },
  { name: 'File Manager', href: '/file-manager', icon: <FolderOpen className="w-5 h-5" /> },
  { name: 'Applications', href: '/applications', icon: <Box className="w-5 h-5" /> },
  { name: 'Containers', href: '/containers', icon: <Container className="w-5 h-5" /> },
  { name: 'Domains', href: '/domains', icon: <Globe className="w-5 h-5" /> },
  { name: 'Databases', href: '/databases', icon: <Database className="w-5 h-5" /> },
  { name: 'SSL Certificates', href: '/ssl', icon: <ShieldCheck className="w-5 h-5" /> },
  { name: 'Cron Jobs', href: '/cron', icon: <Clock className="w-5 h-5" /> },
  { name: 'Backups', href: '/backups', icon: <ArchiveRestore className="w-5 h-5" /> },
  { name: 'Terminal', href: '/terminal', icon: <Terminal className="w-5 h-5" /> },
  { name: 'Env Variables', href: '/env', icon: <TerminalSquare className="w-5 h-5" /> },
  { name: 'Monitoring', href: '/monitoring', icon: <Activity className="w-5 h-5" /> },
  { name: 'Settings', href: '/settings', icon: <Settings className="w-5 h-5" /> },
];

export const Sidebar: React.FC<{ isOpen: boolean; setIsOpen: (val: boolean) => void }> = ({ isOpen, setIsOpen }) => {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed top-0 left-0 z-50 h-screen w-64 border-r bg-card transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:h-[calc(100vh-4rem)]", // adjusted height for top nav in layout
        isOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full overflow-y-auto">
          {/* Logo (visible on mobile, hidden on desktop if TopNav handles it) */}
          <div className="flex items-center h-16 px-6 border-b lg:hidden">
            <span className="text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">K-Panel</span>
          </div>

          <nav className="flex-1 px-4 py-6 space-y-1">
            <div className="mb-4 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Main Menu
            </div>
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center px-3 py-2.5 text-sm font-medium rounded-md transition-colors group",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  onClick={() => setIsOpen(false)}
                >
                  <span className={cn(
                    "mr-3 transition-colors",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                  )}>
                    {item.icon}
                  </span>
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* Bottom Area (e.g., version) */}
          <div className="p-4 border-t border-border/50">
            <div className="px-2 text-xs text-muted-foreground text-center">
              v1.0.0-beta
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};