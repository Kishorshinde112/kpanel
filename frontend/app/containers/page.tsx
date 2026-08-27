"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  Container as ContainerIcon,
  Play,
  Square,
  RotateCw,
  Trash2,
  FileText,
  Search,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  X,
  Activity,
  Cpu,
  Layers,
  HardDrive,
  Filter,
  List,
  Grid,
  ShieldCheck,
  Info
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import { LogExplorerModal } from '../../components/tools/LogExplorerModal';

interface ContainerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

interface DockerContainer {
  id: string;
  name: string;
  status: string;
  state: string;
  image: string;
  created: number;
  ports: ContainerPort[];
  cpu: string;
  memory: string;
  memPerc: string;
  deploymentId: string | null;
}

interface ContainerStats {
  cpu: string;
  memory: string;
  memPerc: string;
  fetched: boolean;
  loading: boolean;
  timestamp?: string;
}

export default function ContainersPage() {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');

  // On-demand Container Resource Stats state (map containerId -> stats)
  const [containerStats, setContainerStats] = useState<{ [id: string]: ContainerStats }>({});
  const [checkingAll, setCheckingAll] = useState<boolean>(false);

  // Actions loading state (map containerId -> action)
  const [actionInProgress, setActionInProgress] = useState<{ [id: string]: string }>({});

  // Modals
  const [selectedLogContainerId, setSelectedLogContainerId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DockerContainer | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  const fetchContainers = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const res = await fetch('/api/apps');
      if (!res.ok) throw new Error('Failed to fetch containers');
      const data = await res.json();
      setContainers(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error('Error fetching containers:', err);
      if (!isSilent) showToast(err.message || 'Error loading containers', 'error');
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContainers();
  }, [fetchContainers]);

  // Auto-refresh interval (5s) for container status
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchContainers(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchContainers]);

  // On-demand Fetch Resource Stats for single container
  const fetchContainerStats = async (id: string) => {
    setContainerStats((prev) => ({
      ...prev,
      [id]: {
        cpu: prev[id]?.cpu || '0.00%',
        memory: prev[id]?.memory || '0 B',
        memPerc: prev[id]?.memPerc || '0.00%',
        fetched: prev[id]?.fetched || false,
        loading: true,
      },
    }));

    try {
      const res = await fetch(`/api/apps/${id}/stats`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to fetch resource usage');
      }

      setContainerStats((prev) => ({
        ...prev,
        [id]: {
          cpu: data.cpu || '0.00%',
          memory: data.memory || '0 B',
          memPerc: data.memPerc || '0.00%',
          fetched: true,
          loading: false,
          timestamp: data.timestamp,
        },
      }));
    } catch (err: any) {
      showToast(`Stats error (${id.substring(0, 8)}): ${err.message}`, 'error');
      setContainerStats((prev) => ({
        ...prev,
        [id]: {
          cpu: prev[id]?.cpu || '—',
          memory: prev[id]?.memory || '—',
          memPerc: prev[id]?.memPerc || '0%',
          fetched: true,
          loading: false,
        },
      }));
    }
  };

  // Check stats for all running containers on-demand
  const handleCheckAllStats = async () => {
    const runningContainers = containers.filter(
      (c) => c.status === 'running' || c.state === 'running'
    );
    if (runningContainers.length === 0) {
      showToast('No active running containers to inspect', 'error');
      return;
    }
    setCheckingAll(true);
    try {
      await Promise.allSettled(runningContainers.map((c) => fetchContainerStats(c.id)));
      showToast('Updated resource usage for all active containers');
    } finally {
      setCheckingAll(false);
    }
  };

  // Handle Container Actions (start / stop / restart)
  const handleAction = async (container: DockerContainer, action: 'start' | 'stop' | 'restart') => {
    setActionInProgress((prev) => ({ ...prev, [container.id]: action }));
    try {
      const res = await fetch(`/api/apps/${container.id}/${action}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Failed to ${action} container`);
      }
      showToast(`Container '${container.name}' ${action}ed successfully`);
      await fetchContainers(true);
      if (action === 'start' || action === 'restart') {
        fetchContainerStats(container.id);
      }
    } catch (err: any) {
      showToast(err.message || `Failed to ${action} container`, 'error');
    } finally {
      setActionInProgress((prev) => {
        const next = { ...prev };
        delete next[container.id];
        return next;
      });
    }
  };

  // Handle Delete Container
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/apps/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to remove container');
      }
      showToast(`Container '${deleteTarget.name}' removed`);
      setDeleteTarget(null);
      fetchContainers();
    } catch (err: any) {
      showToast(err.message || 'Failed to delete container', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    showToast('Container ID copied');
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Filtered Containers
  const filteredContainers = containers.filter((c) => {
    const isRunning = c.status === 'running' || c.state === 'running';
    if (statusFilter === 'running' && !isRunning) return false;
    if (statusFilter === 'stopped' && isRunning) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = c.name.toLowerCase().includes(q);
      const matchImage = c.image.toLowerCase().includes(q);
      const matchId = c.id.toLowerCase().includes(q);
      const matchPort = c.ports?.some((p) => String(p.PublicPort).includes(q) || String(p.PrivatePort).includes(q));
      return matchName || matchImage || matchId || matchPort;
    }
    return true;
  });

  const totalCount = containers.length;
  const runningCount = containers.filter((c) => c.status === 'running' || c.state === 'running').length;
  const stoppedCount = totalCount - runningCount;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border shadow-xl text-sm transition-all duration-300 ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
              : 'bg-red-950/90 border-red-500/50 text-red-200'
          }`}
        >
          {toastMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Docker Containers</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Monitor real-time container health, live CPU & RAM usage, ports, and logs.
          </p>
        </div>

        {/* Global Action Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleCheckAllStats}
            disabled={checkingAll || containers.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted hover:text-primary transition-colors shadow-sm disabled:opacity-50"
            title="Inspect CPU & RAM for all active containers"
          >
            <Activity className={`w-3.5 h-3.5 text-primary ${checkingAll ? 'animate-spin' : ''}`} />
            {checkingAll ? 'Checking All...' : 'Check All Usage'}
          </button>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors shadow-sm ${
              autoRefresh
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-card border-input text-muted-foreground hover:text-foreground'
            }`}
          >
            <Activity className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-pulse' : ''}`} />
            {autoRefresh ? 'Live Polling On' : 'Polling Paused'}
          </button>

          <button
            onClick={() => fetchContainers()}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
            title="Refresh list"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/60 hover:border-primary/40 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Total Containers</CardDescription>
            <CardTitle className="text-2xl font-bold text-foreground flex items-center gap-2">
              <ContainerIcon className="w-5 h-5 text-primary" />
              {totalCount}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60 hover:border-emerald-500/40 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Running & Healthy</CardDescription>
            <CardTitle className="text-2xl font-bold text-emerald-400 flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              {runningCount} Active
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60 hover:border-muted/60 transition-colors">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Stopped / Inactive</CardDescription>
            <CardTitle className="text-2xl font-bold text-muted-foreground flex items-center gap-2">
              <Square className="w-4 h-4 text-muted-foreground" />
              {stoppedCount} Stopped
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filters, Search & View Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Search Bar */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by container name, image, or port..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-card pl-9 pr-8 text-xs shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filter Pills & View Toggle */}
        <div className="flex items-center gap-2 justify-between sm:justify-end">
          <div className="flex items-center rounded-lg border border-input bg-card p-1 text-xs">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1 rounded-md transition-colors font-medium ${
                statusFilter === 'all'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              All ({totalCount})
            </button>
            <button
              onClick={() => setStatusFilter('running')}
              className={`px-3 py-1 rounded-md transition-colors font-medium ${
                statusFilter === 'running'
                  ? 'bg-emerald-600 text-white'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Running ({runningCount})
            </button>
            <button
              onClick={() => setStatusFilter('stopped')}
              className={`px-3 py-1 rounded-md transition-colors font-medium ${
                statusFilter === 'stopped'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Stopped ({stoppedCount})
            </button>
          </div>

          <div className="flex items-center rounded-lg border border-input bg-card p-0.5">
            <button
              onClick={() => setViewMode('cards')}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'cards' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Card Grid View"
            >
              <Grid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'table' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Table View"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Containers List */}
      {loading && containers.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border rounded-xl bg-card/40 text-muted-foreground gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          <span className="text-sm">Connecting to Docker engine...</span>
        </div>
      ) : filteredContainers.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-dashed rounded-xl bg-card/20 text-muted-foreground gap-3">
          <ContainerIcon className="w-10 h-10 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">
              {searchQuery ? 'No matching containers found' : 'No containers found'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {searchQuery ? 'Try clearing your search query' : 'Deploy an application stack from the Blueprints page'}
            </p>
          </div>
        </div>
      ) : viewMode === 'cards' ? (
        /* CARDS GRID VIEW */
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredContainers.map((container) => {
            const isRunning = container.status === 'running' || container.state === 'running';
            const actionLoading = actionInProgress[container.id];
            const stats = containerStats[container.id];
            const parsedCpu = parseFloat(stats?.cpu?.replace('%', '') || container.cpu?.replace('%', '') || '0');
            const parsedMemPerc = parseFloat(stats?.memPerc?.replace('%', '') || container.memPerc?.replace('%', '') || '0');

            return (
              <Card
                key={container.id}
                className={`flex flex-col justify-between transition-all duration-200 hover:border-primary/40 bg-card/70 ${
                  isRunning ? 'border-border' : 'border-border/60 opacity-85'
                }`}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className="p-2.5 rounded-lg bg-primary/10 text-primary shrink-0">
                        <ContainerIcon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base font-semibold truncate text-foreground" title={container.name}>
                          {container.name}
                        </CardTitle>
                        <CardDescription className="text-xs truncate font-mono text-muted-foreground" title={container.image}>
                          {container.image}
                        </CardDescription>
                      </div>
                    </div>

                    {/* Live Status Badge */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="relative flex h-2.5 w-2.5">
                        {isRunning && (
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        )}
                        <span
                          className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                            isRunning ? 'bg-emerald-500' : 'bg-gray-500'
                          }`}
                        ></span>
                      </span>
                      <span className={`text-[11px] font-medium uppercase tracking-wider ${isRunning ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                        {container.status || container.state}
                      </span>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="pb-4 space-y-3 text-xs">
                  {/* Container ID & Quick Copy */}
                  <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 font-mono text-[11px]">
                    <span className="text-muted-foreground">ID:</span>
                    <button
                      onClick={() => handleCopy(container.id, container.id)}
                      className="flex items-center gap-1 text-foreground hover:text-primary transition-colors"
                      title="Click to copy ID"
                    >
                      <span>{container.id}</span>
                      {copiedId === container.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                    </button>
                  </div>

                  {/* Resource Badges (CPU & Memory) */}
                  <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 space-y-2">
                    {!isRunning ? (
                      <div className="flex items-center justify-between text-xs text-muted-foreground py-0.5">
                        <span className="flex items-center gap-1.5">
                          <Cpu className="w-3.5 h-3.5 opacity-40" /> Resource Usage:
                        </span>
                        <span className="italic text-[11px] text-muted-foreground/70">Container stopped</span>
                      </div>
                    ) : !stats?.fetched ? (
                      <div className="flex items-center justify-between py-0.5">
                        <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
                          <Cpu className="w-3.5 h-3.5 text-primary" />
                          <span>Resource Usage:</span>
                        </div>
                        <button
                          onClick={() => fetchContainerStats(container.id)}
                          disabled={stats?.loading}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-colors shadow-none disabled:opacity-50"
                        >
                          <Activity className={`w-3.5 h-3.5 ${stats?.loading ? 'animate-spin' : ''}`} />
                          {stats?.loading ? 'Checking...' : 'Check Resource Usage'}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {/* CPU Row */}
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-muted-foreground flex items-center gap-1">
                              <Cpu className="w-3 h-3 text-primary" /> CPU Usage:
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-medium text-foreground">{stats.cpu}</span>
                              <button
                                onClick={() => fetchContainerStats(container.id)}
                                disabled={stats?.loading}
                                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                title="Refresh CPU & Memory"
                              >
                                <RotateCw className={`w-3 h-3 ${stats?.loading ? 'animate-spin text-primary' : ''}`} />
                              </button>
                            </div>
                          </div>
                          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                parsedCpu > 80 ? 'bg-red-500' : parsedCpu > 40 ? 'bg-amber-500' : 'bg-primary'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(2, parsedCpu))}%` }}
                            />
                          </div>
                        </div>

                        {/* Memory Row */}
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-muted-foreground flex items-center gap-1">
                              <Activity className="w-3 h-3 text-emerald-400" /> Memory ({stats.memPerc}):
                            </span>
                            <span className="font-mono font-medium text-foreground">{stats.memory}</span>
                          </div>
                          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                parsedMemPerc > 80 ? 'bg-red-500' : parsedMemPerc > 50 ? 'bg-amber-500' : 'bg-emerald-500'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(2, parsedMemPerc))}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Ports list */}
                  {container.ports && container.ports.length > 0 && (
                    <div className="flex items-center flex-wrap gap-1.5 pt-1">
                      <span className="text-muted-foreground text-[11px]">Ports:</span>
                      {container.ports.map((p, idx) => {
                        const portStr = p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}/${p.Type}`;
                        return (
                          <span
                            key={idx}
                            className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-muted text-muted-foreground border border-border/50"
                          >
                            {portStr}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </CardContent>

                {/* Footer Actions */}
                <CardFooter className="pt-0 border-t border-border/40 bg-muted/20 px-4 py-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    {isRunning ? (
                      <button
                        onClick={() => handleAction(container, 'stop')}
                        disabled={!!actionLoading}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-xs font-medium transition-colors disabled:opacity-50"
                        title="Stop Container"
                      >
                        {actionLoading === 'stop' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handleAction(container, 'start')}
                        disabled={!!actionLoading}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium transition-colors disabled:opacity-50"
                        title="Start Container"
                      >
                        {actionLoading === 'start' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        Start
                      </button>
                    )}

                    <button
                      onClick={() => handleAction(container, 'restart')}
                      disabled={!!actionLoading}
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      title="Restart Container"
                    >
                      <RotateCw className={`w-3.5 h-3.5 ${actionLoading === 'restart' ? 'animate-spin text-primary' : ''}`} />
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSelectedLogContainerId(container.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
                      title="View Logs"
                    >
                      <FileText className="w-3.5 h-3.5 text-primary" />
                      Logs
                    </button>

                    <button
                      onClick={() => setDeleteTarget(container)}
                      className="p-1.5 rounded-md hover:bg-red-950/30 text-muted-foreground hover:text-red-400 transition-colors"
                      title="Remove Container"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        /* TABLE VIEW */
        <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40 border-b border-border text-muted-foreground font-medium uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Container</th>
                  <th className="py-3 px-4 w-32">Status</th>
                  <th className="py-3 px-4 w-28">CPU</th>
                  <th className="py-3 px-4 w-36">Memory</th>
                  <th className="py-3 px-4">Ports</th>
                  <th className="py-3 px-4 w-40 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-sans text-xs">
                {filteredContainers.map((container) => {
                  const isRunning = container.status === 'running' || container.state === 'running';
                  const actionLoading = actionInProgress[container.id];
                  const stats = containerStats[container.id];

                  return (
                    <tr key={container.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                            <ContainerIcon className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-foreground truncate max-w-xs">{container.name}</div>
                            <div className="text-[11px] font-mono text-muted-foreground truncate max-w-xs">{container.image}</div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-flex rounded-full h-2 w-2 ${
                              isRunning ? 'bg-emerald-500' : 'bg-gray-500'
                            }`}
                          />
                          <span className={`capitalize text-xs ${isRunning ? 'text-emerald-400 font-medium' : 'text-muted-foreground'}`}>
                            {container.status || container.state}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono text-muted-foreground">
                        {!isRunning ? (
                          '—'
                        ) : !stats?.fetched ? (
                          <button
                            onClick={() => fetchContainerStats(container.id)}
                            disabled={stats?.loading}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-sans font-medium transition-colors disabled:opacity-50"
                            title="Check CPU & RAM usage"
                          >
                            <Activity className={`w-3 h-3 ${stats?.loading ? 'animate-spin' : ''}`} />
                            {stats?.loading ? '...' : 'Check'}
                          </button>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span className="text-foreground">{stats.cpu}</span>
                            <button
                              onClick={() => fetchContainerStats(container.id)}
                              disabled={stats?.loading}
                              className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                              title="Refresh CPU"
                            >
                              <RotateCw className={`w-2.5 h-2.5 ${stats?.loading ? 'animate-spin text-primary' : ''}`} />
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 font-mono text-muted-foreground">
                        {!isRunning ? (
                          '—'
                        ) : !stats?.fetched ? (
                          '—'
                        ) : (
                          <div className="flex flex-col">
                            <span className="text-foreground">{stats.memory}</span>
                            <span className="text-[10px] text-muted-foreground">{stats.memPerc}</span>
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {container.ports?.map((p, idx) => (
                            <span key={idx} className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted text-muted-foreground">
                              {p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {isRunning ? (
                            <button
                              onClick={() => handleAction(container, 'stop')}
                              disabled={!!actionLoading}
                              className="p-1 rounded text-amber-400 hover:bg-amber-500/10 transition-colors"
                              title="Stop"
                            >
                              <Square className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleAction(container, 'start')}
                              disabled={!!actionLoading}
                              className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                              title="Start"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            onClick={() => handleAction(container, 'restart')}
                            disabled={!!actionLoading}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="Restart"
                          >
                            <RotateCw className={`w-3.5 h-3.5 ${actionLoading === 'restart' ? 'animate-spin' : ''}`} />
                          </button>

                          <button
                            onClick={() => setSelectedLogContainerId(container.id)}
                            className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
                            title="Logs"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => setDeleteTarget(container)}
                            className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-950/30 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Log Explorer Modal */}
      {selectedLogContainerId && (
        <LogExplorerModal
          isOpen={true}
          onClose={() => setSelectedLogContainerId(null)}
          initialContainerId={selectedLogContainerId}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-xl border border-destructive/30 bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-start space-x-3">
              <div className="p-2 rounded-lg bg-destructive/10 text-destructive">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-foreground">
                  Force Remove Container
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Are you sure you want to stop and delete container{' '}
                  <span className="font-semibold text-foreground font-mono">{deleteTarget.name}</span> ({deleteTarget.id})?
                </p>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-muted/40 text-[11px] font-mono text-muted-foreground">
              Image: {deleteTarget.image}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-3.5 py-2 rounded-lg border border-input text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleting ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1.5" />}
                {deleting ? 'Removing...' : 'Delete Container'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
