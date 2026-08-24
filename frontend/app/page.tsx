"use client";

import React, { useState, useEffect } from 'react';
import { HostStats } from '../components/dashboard/HostStats';
import { UtilityCard } from '../components/utilities/UtilityCard';
import {
  LineChart,
  Bot,
  Rocket,
  FileText
} from 'lucide-react';

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ cpu: 0, ram: { used: 0, total: 0 }, disk: 0 });

  // Simulate API fetch for /api/stats
  useEffect(() => {
    const fetchStats = async () => {
      // Mock delay
      await new Promise(resolve => setTimeout(resolve, 800));
      setStats({
        cpu: 12,
        ram: { used: 4.2, total: 24 },
        disk: 65
      });
      setLoading(false);
    };
    fetchStats();
  }, []);

  return (
    <div className="space-y-8">
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
            description="Scan your domains for performance and SEO improvements."
            icon={<LineChart className="w-6 h-6" />}
            actionText="Analyze Domain"
            status="healthy"
            onAction={() => console.log('Analyze domain clicked')}
          />

          <UtilityCard
            title="Log Explorer"
            description="View real-time access and error logs for your applications."
            icon={<FileText className="w-6 h-6" />}
            actionText="View Logs"
            status="inactive"
            onAction={() => console.log('View logs clicked')}
          />

          <UtilityCard
            title="AI Assistant"
            description="Get help with configuration, debugging, or optimization."
            icon={<Bot className="w-6 h-6" />}
            actionText="Ask AI"
            status="healthy"
            onAction={() => console.log('AI Assistant clicked')}
          />

          <UtilityCard
            title="1-Click Deploy"
            description="Deploy popular stacks (WordPress, Node, Laravel) instantly."
            icon={<Rocket className="w-6 h-6" />}
            actionText="Deploy App"
            status="healthy"
            onAction={() => console.log('Deploy app clicked')}
          />

        </div>
      </section>
    </div>
  );
}