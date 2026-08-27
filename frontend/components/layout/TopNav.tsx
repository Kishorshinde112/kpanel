"use client";

import React, { useState, useEffect } from 'react';
import { Menu, Bell, Search, User, Server } from 'lucide-react';
import { cn } from '../../lib/utils';

export const TopNav: React.FC<{ onMenuClick: () => void }> = ({ onMenuClick }) => {
  const [status, setStatus] = useState<'healthy' | 'high_load'>('healthy');
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/stats');
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status === 'high_load' ? 'high_load' : 'healthy');
        }
      } catch {}
    };

    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b bg-card px-4 sm:px-6">

      <div className="flex items-center gap-4 lg:gap-0 lg:w-64 lg:border-r lg:pr-6">
        <button
          onClick={onMenuClick}
          className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle Menu</span>
        </button>
        <div className="flex items-center">
           <span className="hidden lg:block text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">K-Panel</span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-end gap-4 lg:ml-6 lg:justify-between">

        {/* Search - Hidden on small screens */}
        <div className="hidden flex-1 lg:flex items-center">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search apps, containers..."
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pl-9 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-3 sm:gap-4">

          {/* Dynamic Server Status Indicator */}
          <div className="hidden sm:flex items-center gap-2 rounded-full border px-3 py-1 text-sm bg-muted/50">
             <div className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status === 'healthy' ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${status === 'healthy' ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
             </div>
             <span className="text-muted-foreground font-medium text-xs">
               VPS: {status === 'healthy' ? 'Healthy' : 'High Load'}
             </span>
          </div>

          <div className="relative">
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="relative inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Bell className="h-5 w-5" />
              <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary"></span>
              </span>
            </button>

            {showNotifications && (
              <div className="absolute right-0 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-xl z-50 animate-in fade-in">
                <div className="text-xs font-semibold mb-2">Notifications</div>
                <div className="p-2 rounded-lg bg-muted/50 text-xs space-y-1">
                  <div className="font-medium text-foreground">Traefik SSL Active</div>
                  <div className="text-muted-foreground">Auto-renewal enabled for *.kishorlab.dev</div>
                </div>
              </div>
            )}
          </div>

          <button className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <User className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
};