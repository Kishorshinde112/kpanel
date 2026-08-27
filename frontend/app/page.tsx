"use client";

import React, { useState, useEffect } from 'react';
import { HostStats } from '../components/dashboard/HostStats';
import { UtilityCard } from '../components/utilities/UtilityCard';
import {
  Globe,
  Bot,
  Rocket,
  FileText
} from 'lucide-react';
import { WebsiteAnalyzerModal } from '../components/tools/WebsiteAnalyzerModal';
import { LogExplorerModal } from '../components/tools/LogExplorerModal';
import { AiAssistantDrawer } from '../components/tools/AiAssistantDrawer';
import { DeployBlueprintModal } from '../components/tools/DeployBlueprintModal';

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    cpu: 0,
    ram: { used: 0, total: 0 },
    disk: 0
  });

  // Modal visibility states
  const [showAnalyzer, setShowAnalyzer] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);

  // Live polling for server stats
  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();
        setStats({
          cpu: data.cpu?.percent ?? 10,
          ram: {
            used: data.memory?.usedGB ?? parseFloat((data.memory?.used / (1024 ** 3)).toFixed(1)),
            total: data.memory?.totalGB ?? parseFloat((data.memory?.total / (1024 ** 3)).toFixed(1))
          },
          disk: data.disk?.percent ?? 60
        });
      }
    } catch (err) {
      console.error('Failed to fetch /api/stats', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground mt-2">
          Monitor your server and manage your applications.
        </p>
      </div>

      {/* Stats Section */}
      <section>
        <HostStats
          cpuUsage={stats.cpu}
          ramUsage={stats.ram}
          diskUsage={stats.disk}
          loading={loading}
        />
      </section>

      {/* Utilities Section */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold tracking-tight">Quick Tools</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

          <UtilityCard
            title="Website Analyzer"
            description="Scan your domains for performance, SSL, and security health."
            icon={<Globe className="w-6 h-6" />}
            actionText="Analyze Domain"
            status="healthy"
            onAction={() => setShowAnalyzer(true)}
          />

          <UtilityCard
            title="Log Explorer"
            description="View real-time access and error logs for your active containers."
            icon={<FileText className="w-6 h-6" />}
            actionText="View Logs"
            status="healthy"
            onAction={() => setShowLogs(true)}
          />

          <UtilityCard
            title="AI Assistant"
            description="Get help with configuration, debugging, or optimization."
            icon={<Bot className="w-6 h-6" />}
            actionText="Ask AI"
            status="healthy"
            onAction={() => setShowAi(true)}
          />

          <UtilityCard
            title="1-Click Deploy"
            description="Deploy popular stacks (WordPress, Node, Laravel, FastAPI) instantly."
            icon={<Rocket className="w-6 h-6" />}
            actionText="Deploy App"
            status="healthy"
            onAction={() => setShowDeploy(true)}
          />

        </div>
      </section>

      {/* Interactive Tool Modals & Drawers */}
      <WebsiteAnalyzerModal
        isOpen={showAnalyzer}
        onClose={() => setShowAnalyzer(false)}
      />

      <LogExplorerModal
        isOpen={showLogs}
        onClose={() => setShowLogs(false)}
      />

      <AiAssistantDrawer
        isOpen={showAi}
        onClose={() => setShowAi(false)}
      />

      <DeployBlueprintModal
        isOpen={showDeploy}
        onClose={() => setShowDeploy(false)}
      />

    </div>
  );
}