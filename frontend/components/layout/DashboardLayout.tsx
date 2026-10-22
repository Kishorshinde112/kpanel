"use client";

import React, { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Server, RefreshCw, AlertTriangle } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopNav } from './TopNav';
import { AiAssistantDrawer } from '../tools/AiAssistantDrawer';
import { useAuth } from '../../context/AuthContext';

export const DashboardLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);

  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, error, checkAuth } = useAuth();

  const isLoginPage = pathname === '/login';

  // Auth Guard: Redirect unauthenticated visitors attempting to view protected pages
  useEffect(() => {
    if (!isLoginPage && isAuthenticated === false && !error) {
      const returnParam = pathname && pathname !== '/' ? `?returnTo=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${returnParam}`);
    }
  }, [isLoginPage, isAuthenticated, error, pathname, router]);

  // 1. Login Page: Render strictly without Sidebar, TopNav, polling, or AI Assistant
  if (isLoginPage) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  // 2. Initial Session Verification: Show neutral, dark loading screen
  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground p-4">
        <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
          <div className="p-3.5 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-inner">
            <Server className="w-8 h-8 animate-pulse" />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground tracking-tight">K-Panel Security Perimeter</h2>
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
              <span>Verifying active session...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 3. Backend Error / Unreachable State: Show clear connection failure without exposing dashboard
  if (isAuthenticated === false && error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="max-w-md w-full bg-card/90 border border-destructive/40 rounded-2xl p-6 sm:p-8 text-center space-y-4 shadow-2xl backdrop-blur-md">
          <div className="w-12 h-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto border border-destructive/20">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Backend Connection Failed</h2>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              {error}
            </p>
          </div>
          <div className="pt-2 flex flex-col sm:flex-row gap-2 justify-center">
            <button
              onClick={() => checkAuth()}
              className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all gap-1.5 shadow-sm"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Connection</span>
            </button>
            <button
              onClick={() => router.push('/login')}
              className="inline-flex items-center justify-center px-4 py-2 rounded-xl border border-input text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
            >
              Go to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 4. Unauthenticated (and redirecting): Keep neutral placeholder to prevent flash of content
  if (isAuthenticated === false) {
    return <div className="min-h-screen bg-background" />;
  }

  // 5. Authenticated Dashboard: Render complete management experience
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <TopNav
        onMenuClick={() => setSidebarOpen(!sidebarOpen)}
        onAiClick={() => setAiAssistantOpen(true)}
      />
      <div className="flex flex-1">
        <Sidebar isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />
        <main className="flex-1 overflow-y-auto">
          <div className="container mx-auto p-4 md:p-6 lg:p-8 max-w-7xl">
            {children}
          </div>
        </main>
      </div>

      {/* Global AI Assistant Drawer accessible across all pages */}
      <AiAssistantDrawer
        isOpen={aiAssistantOpen}
        onClose={() => setAiAssistantOpen(false)}
      />
    </div>
  );
};
