"use client";

import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { TopNav } from './TopNav';

export const DashboardLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <TopNav onMenuClick={() => setSidebarOpen(!sidebarOpen)} />
      <div className="flex flex-1">
        <Sidebar isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />
        <main className="flex-1 overflow-y-auto">
          <div className="container mx-auto p-4 md:p-6 lg:p-8 max-w-7xl">
             {children}
          </div>
        </main>
      </div>
    </div>
  );
};