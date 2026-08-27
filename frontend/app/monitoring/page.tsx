"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { Activity, RefreshCw, Cpu, MemoryStick, HardDrive, Play, Square } from 'lucide-react';

interface MetricPoint {
  time: string;
  timestamp: string;
  cpu: number;
  ram: number;
  ramPercent?: number;
}

export default function MonitoringPage() {
  const [data, setData] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchMetrics = async () => {
    try {
      const res = await fetch('/api/metrics/history');
      if (res.ok) {
        const history = await res.json();
        if (Array.isArray(history) && history.length > 0) {
          setData(history);
        }
      }
    } catch (err) {
      console.error('Failed to fetch metric history', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const latestPoint = data[data.length - 1] || { cpu: 0, ram: 0, time: '' };
  const maxCpu = data.length > 0 ? Math.max(...data.map(d => d.cpu)) : 0;
  const maxRam = data.length > 0 ? Math.max(...data.map(d => d.ram)) : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Resource Monitoring</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Live historical time-series analytics for VPS CPU and Memory utilization.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${autoRefresh ? 'bg-green-500/10 border-green-500/30 text-green-500' : 'bg-card border-input text-muted-foreground hover:text-foreground'}`}
          >
            {autoRefresh ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {autoRefresh ? 'Live Polling (5s)' : 'Polling Paused'}
          </button>

          <button
            onClick={() => {
              setLoading(true);
              fetchMetrics();
            }}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-3.5 bg-card/60">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Current CPU</span>
            <Cpu className="w-4 h-4 text-primary" />
          </div>
          <p className="text-xl font-bold mt-1 text-foreground">{latestPoint.cpu}%</p>
        </Card>

        <Card className="p-3.5 bg-card/60">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Peak CPU (Window)</span>
            <Cpu className="w-4 h-4 text-yellow-500" />
          </div>
          <p className="text-xl font-bold mt-1 text-yellow-500">{maxCpu}%</p>
        </Card>

        <Card className="p-3.5 bg-card/60">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Current RAM</span>
            <MemoryStick className="w-4 h-4 text-green-500" />
          </div>
          <p className="text-xl font-bold mt-1 text-foreground">{latestPoint.ram} GB</p>
        </Card>

        <Card className="p-3.5 bg-card/60">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Total Capacity</span>
            <MemoryStick className="w-4 h-4 text-primary" />
          </div>
          <p className="text-xl font-bold mt-1 text-primary">23.4 GB</p>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        
        {/* CPU Chart */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary" /> CPU Load Utilization
              </CardTitle>
              <span className="text-xs text-muted-foreground">4 ARM Cores</span>
            </div>
            <CardDescription className="text-xs">Continuous usage percentage over time</CardDescription>
          </CardHeader>
          <CardContent className="h-72 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#2d3748" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#161b22', borderColor: '#30363d', borderRadius: '8px', fontSize: '12px' }}
                  itemStyle={{ color: '#58a6ff' }}
                  formatter={(val: any) => [`${val}%`, 'CPU Usage']}
                />
                <Area type="monotone" dataKey="cpu" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorCpu)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* RAM Chart */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <MemoryStick className="w-4 h-4 text-green-500" /> RAM Memory Allocation
              </CardTitle>
              <span className="text-xs text-muted-foreground">Total: 23.4 GB</span>
            </div>
            <CardDescription className="text-xs">Physical memory consumed in gigabytes</CardDescription>
          </CardHeader>
          <CardContent className="h-72 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorRam" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} domain={[0, 24]} tickFormatter={(v) => `${v}GB`} />
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#2d3748" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#161b22', borderColor: '#30363d', borderRadius: '8px', fontSize: '12px' }}
                  itemStyle={{ color: '#10b981' }}
                  formatter={(val: any) => [`${val} GB`, 'Memory Used']}
                />
                <Area type="monotone" dataKey="ram" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorRam)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}