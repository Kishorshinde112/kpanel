"use client";

import React, { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Container as ContainerIcon,
  Plus,
  Play,
  Square,
  RotateCw,
  Trash2,
  FileText,
  Rocket,
  Search,
  RefreshCw,
  Copy,
  Check,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Cpu,
  Activity,
  Layers,
  ExternalLink,
  Sliders,
  Grid,
  List
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import { LogExplorerModal } from '../../components/tools/LogExplorerModal';
import { DeployBlueprintModal } from '../../components/tools/DeployBlueprintModal';

interface ContainerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

interface DockerApp {
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

export default function ApplicationsPage() {
  const [apps, setApps] = useState<DockerApp[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  // Action states
  const [actionInProgress, setActionInProgress] = useState<{ [id: string]: string }>({});

  // Modals
  const [showDeployBlueprint, setShowDeployBlueprint] = useState<boolean>(false);
  const [selectedLogAppId, setSelectedLogAppId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DockerApp | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  const fetchApps = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const res = await fetch('/api/apps');
      if (!res.ok) throw new Error('Failed to fetch applications');
      const data = await res.json();
      setApps(Array.isArray(data) ? data : []);
    } catch (err: any) {
      if (!isSilent) showToast(err.message || 'Error fetching apps', 'error');
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  // Polling interval
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchApps(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchApps]);

  const handleAction = async (app: DockerApp, action: 'start' | 'stop' | 'restart') => {
    setActionInProgress((prev) => ({ ...prev, [app.id]: action }));
    try {
      const res = await fetch(`/api/apps/${app.id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Failed to ${action} app`);
      }
      showToast(`App '${app.name}' ${action}ed`);
      await fetchApps(true);
    } catch (err: any) {
      showToast(err.message || `Action failed`, 'error');
    } finally {
      setActionInProgress((prev) => {
        const next = { ...prev };
        delete next[app.id];
        return next;
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/apps/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to remove container');
      }
      showToast(`Removed app container '${deleteTarget.name}'`);
      setDeleteTarget(null);
      fetchApps();
    } catch (err: any) {
      showToast(err.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    showToast('ID copied to clipboard');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const filteredApps = apps.filter((app) => {
    const isRunning = app.status === 'running' || app.state === 'running';
    if (statusFilter === 'running' && !isRunning) return false;
    if (statusFilter === 'stopped' && isRunning) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        app.name.toLowerCase().includes(q) ||
        app.image.toLowerCase().includes(q) ||
        app.id.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const totalCount = apps.length;
  const runningCount = apps.filter((a) => a.status === 'running' || a.state === 'running').length;
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
          <h1 className="text-3xl font-bold tracking-tight">Applications & Stacks</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Deploy, supervise, and control your Docker services, databases, and microservices.
          </p>
        </div>

        {/* Top Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDeployBlueprint(true)}
            className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-3.5 py-2 text-xs font-medium transition-colors shadow-sm"
          >
            <Rocket className="w-3.5 h-3.5 mr-1.5" />
            1-Click Blueprint
          </button>

          <button
            onClick={() => fetchApps()}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
            title="Refresh apps"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Deployed Applications</CardDescription>
            <CardTitle className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Box className="w-5 h-5 text-primary" />
              {totalCount} Total Stacks
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Active & Serving Traffic</CardDescription>
            <CardTitle className="text-2xl font-bold text-emerald-400 flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              {runningCount} Running
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Inactive / Stopped</CardDescription>
            <CardTitle className="text-2xl font-bold text-muted-foreground flex items-center gap-2">
              <Square className="w-4 h-4 text-muted-foreground" />
              {stoppedCount} Offline
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search applications by name or image..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-xs shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          />
        </div>

        {/* Filter Pills & View Mode */}
        <div className="flex items-center gap-2 justify-between sm:justify-end">
          <div className="flex items-center rounded-lg border border-input bg-card p-1 text-xs">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1 rounded-md transition-colors font-medium ${
                statusFilter === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              All ({totalCount})
            </button>
            <button
              onClick={() => setStatusFilter('running')}
              className={`px-3 py-1 rounded-md transition-colors font-medium ${
                statusFilter === 'running' ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Running ({runningCount})
            </button>
            <button
              onClick={() => setStatusFilter('stopped')}
              className={`px-3 py-1 rounded-md transition-colors font-medium ${
                statusFilter === 'stopped' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Stopped ({stoppedCount})
            </button>
          </div>

          <div className="flex items-center rounded-lg border border-input bg-card p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'grid' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Grid Cards"
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

      {/* Main Apps Grid / Table */}
      {loading && apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border rounded-xl bg-card/40 text-muted-foreground gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          <span className="text-sm">Loading applications...</span>
        </div>
      ) : filteredApps.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-dashed rounded-xl bg-card/20 text-muted-foreground gap-3">
          <Box className="w-10 h-10 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">
              {searchQuery ? 'No matching apps found' : 'No applications running'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Deploy a new stack using Blueprints or Docker Compose.
            </p>
          </div>
        </div>
      ) : viewMode === 'grid' ? (
        /* GRID CARDS VIEW */
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredApps.map((app) => {
            const isRunning = app.status === 'running' || app.state === 'running';
            const actionLoading = actionInProgress[app.id];
            const parsedCpu = parseFloat(app.cpu?.replace('%', '') || '0');
            const parsedMemPerc = parseFloat(app.memPerc?.replace('%', '') || '0');

            return (
              <Card
                key={app.id}
                className="flex flex-col justify-between hover:border-primary/50 transition-all duration-200 bg-card/70"
              >
                <CardHeader className="pb-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className="p-2.5 bg-primary/10 rounded-lg text-primary shrink-0">
                        <Box className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base font-semibold truncate text-foreground" title={app.name}>
                          {app.name}
                        </CardTitle>
                        <CardDescription className="text-xs truncate font-mono text-muted-foreground" title={app.image}>
                          {app.image}
                        </CardDescription>
                      </div>
                    </div>

                    {/* Status Dot */}
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
                        {app.status || app.state}
                      </span>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="pb-4 space-y-3 text-xs">
                  {/* Container ID */}
                  <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 font-mono text-[11px]">
                    <span className="text-muted-foreground">ID:</span>
                    <button
                      onClick={() => handleCopy(app.id, app.id)}
                      className="flex items-center gap-1 text-foreground hover:text-primary transition-colors"
                      title="Click to copy ID"
                    >
                      <span>{app.id}</span>
                      {copiedId === app.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                    </button>
                  </div>

                  {/* Resource Badges */}
                  <div className="space-y-2 p-2.5 rounded-lg bg-muted/30 border border-border/40">
                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Cpu className="w-3 h-3 text-primary" /> CPU:
                        </span>
                        <span className="font-mono font-medium text-foreground">
                          {isRunning ? app.cpu || '0.00%' : '0%'}
                        </span>
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

                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Activity className="w-3 h-3 text-emerald-400" /> RAM:
                        </span>
                        <span className="font-mono font-medium text-foreground">
                          {isRunning ? app.memory || '0B' : '0B'}
                        </span>
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

                  {/* Ports */}
                  {app.ports && app.ports.length > 0 && (
                    <div className="flex items-center flex-wrap gap-1.5">
                      <span className="text-muted-foreground text-[11px]">Ports:</span>
                      {app.ports.map((p, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded text-[11px] font-mono bg-muted text-muted-foreground border border-border/50"
                        >
                          {p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}/${p.Type}`}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>

                {/* Footer Controls */}
                <CardFooter className="pt-0 border-t border-border/40 bg-muted/20 px-4 py-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    {isRunning ? (
                      <button
                        onClick={() => handleAction(app, 'stop')}
                        disabled={!!actionLoading}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        {actionLoading === 'stop' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handleAction(app, 'start')}
                        disabled={!!actionLoading}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        {actionLoading === 'start' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        Start
                      </button>
                    )}

                    <button
                      onClick={() => handleAction(app, 'restart')}
                      disabled={!!actionLoading}
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      title="Restart"
                    >
                      <RotateCw className={`w-3.5 h-3.5 ${actionLoading === 'restart' ? 'animate-spin text-primary' : ''}`} />
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSelectedLogAppId(app.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
                      title="Logs"
                    >
                      <FileText className="w-3.5 h-3.5 text-primary" />
                      Logs
                    </button>

                    <button
                      onClick={() => setDeleteTarget(app)}
                      className="p-1.5 rounded-md hover:bg-red-950/30 text-muted-foreground hover:text-red-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </CardFooter>
              </Card>
            );
          })}

          {/* Quick Deploy Blueprint Card */}
          <Card
            onClick={() => setShowDeployBlueprint(true)}
            className="flex flex-col border-dashed border-2 bg-transparent hover:bg-muted/10 cursor-pointer transition-all duration-150 justify-center items-center h-full min-h-[260px] p-6 text-center space-y-2 group"
          >
            <div className="p-3 rounded-full bg-primary/10 text-primary group-hover:scale-110 transition-transform">
              <Rocket className="w-6 h-6" />
            </div>
            <span className="font-semibold text-foreground text-sm">Deploy New Stack</span>
            <p className="text-xs text-muted-foreground max-w-xs">
              WordPress, Node + Redis, Python FastAPI, or Standalone PostgreSQL with Traefik SSL.
            </p>
          </Card>
        </div>
      ) : (
        /* TABLE VIEW */
        <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40 border-b border-border text-muted-foreground font-medium uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Application</th>
                  <th className="py-3 px-4 w-32">Status</th>
                  <th className="py-3 px-4 w-28">CPU</th>
                  <th className="py-3 px-4 w-36">Memory</th>
                  <th className="py-3 px-4">Ports</th>
                  <th className="py-3 px-4 w-40 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-sans text-xs">
                {filteredApps.map((app) => {
                  const isRunning = app.status === 'running' || app.state === 'running';
                  const actionLoading = actionInProgress[app.id];

                  return (
                    <tr key={app.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                            <Box className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-foreground truncate max-w-xs">{app.name}</div>
                            <div className="text-[11px] font-mono text-muted-foreground truncate max-w-xs">{app.image}</div>
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
                            {app.status || app.state}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono text-muted-foreground">
                        {isRunning ? app.cpu || '0.00%' : '—'}
                      </td>

                      <td className="py-3 px-4 font-mono text-muted-foreground">
                        {isRunning ? app.memory || '—' : '—'}
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {app.ports?.map((p, idx) => (
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
                              onClick={() => handleAction(app, 'stop')}
                              disabled={!!actionLoading}
                              className="p-1 rounded text-amber-400 hover:bg-amber-500/10 transition-colors"
                              title="Stop"
                            >
                              <Square className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleAction(app, 'start')}
                              disabled={!!actionLoading}
                              className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                              title="Start"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            onClick={() => handleAction(app, 'restart')}
                            disabled={!!actionLoading}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="Restart"
                          >
                            <RotateCw className={`w-3.5 h-3.5 ${actionLoading === 'restart' ? 'animate-spin' : ''}`} />
                          </button>

                          <button
                            onClick={() => setSelectedLogAppId(app.id)}
                            className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
                            title="Logs"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => setDeleteTarget(app)}
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

      {/* Blueprint Deploy Modal */}
      <DeployBlueprintModal
        isOpen={showDeployBlueprint}
        onClose={() => {
          setShowDeployBlueprint(false);
          fetchApps();
        }}
      />

      {/* Log Explorer Modal */}
      {selectedLogAppId && (
        <LogExplorerModal
          isOpen={true}
          onClose={() => setSelectedLogAppId(null)}
          initialContainerId={selectedLogAppId}
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
                  Remove Application Container
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Are you sure you want to stop and delete app container{' '}
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
                {deleting ? 'Removing...' : 'Delete Application'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}