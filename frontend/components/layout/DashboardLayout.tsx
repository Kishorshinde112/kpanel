"use client";

import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { TopNav } from './TopNav';
import { AiAssistantDrawer } from '../tools/AiAssistantDrawer';

export const DashboardLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);

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