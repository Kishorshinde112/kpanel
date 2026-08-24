import React from 'react';
import { Menu, Bell, Search, User, Server } from 'lucide-react';
import { cn } from '../../lib/utils';

export const TopNav: React.FC<{ onMenuClick: () => void }> = ({ onMenuClick }) => {
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
           {/* Replace with actual logo if needed */}
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
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pl-9 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-3 sm:gap-4">

          {/* Server Status Indicator */}
          <div className="hidden sm:flex items-center gap-2 rounded-full border px-3 py-1 text-sm bg-muted/50">
             <div className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
             </div>
             <span className="text-muted-foreground font-medium">VPS: Healthy</span>
          </div>

          <button className="relative inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Bell className="h-5 w-5" />
            <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive"></span>
            </span>
            <span className="sr-only">Notifications</span>
          </button>

          <button className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <User className="h-4 w-4" />
            <span className="sr-only">User Menu</span>
          </button>
        </div>
      </div>
    </header>
  );
};