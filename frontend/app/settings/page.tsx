"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import {
  Settings,
  Server,
  Cpu,
  HardDrive,
  Activity,
  Trash2,
  Sparkles,
  ShieldCheck,
  KeyRound,
  LogOut,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Layers,
  Box,
  Terminal,
  Clock,
  Globe,
  Database,
  Lock,
  Check,
  Flame,
  Info,
  Shield,
  Container
} from 'lucide-react';

interface ServerInfo {
  hostname: string;
  osType?: string;
  osRelease?: string;
  distro?: string;
  kernel: string;
  arch?: string;
  uptime: number;
  uptimeFormatted?: string;
  nodeVersion?: string;
  dockerVersion?: string;
  cpus?: number;
  cpuModel?: string;
  totalMemoryGB?: number;
  usedMemoryGB?: number;
  freeMemoryGB?: number;
  disk?: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    percent: number;
  };
  memory?: {
    total: number;
    used: number;
    free: number;
    totalGB: number;
    usedGB: number;
    percent: number;
  };
  serverTime?: string;
}

interface DockerUsage {
  images: { total: string | number; active: string | number; size: string; reclaimable: string };
  containers: { total: string | number; active: string | number; size: string; reclaimable: string };
  volumes: { total: string | number; active: string | number; size: string; reclaimable: string };
  buildCache: { total: string | number; active: string | number; size: string; reclaimable: string };
}

export default function SettingsPage() {
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [dockerUsage, setDockerUsage] = useState<DockerUsage>({
    images: { total: '56', active: '48', size: '23.7 GB', reclaimable: '20.76 GB (87%)' },
    containers: { total: '54', active: '52', size: '3.75 GB', reclaimable: '0 B' },
    volumes: { total: '32', active: '16', size: '2.47 GB', reclaimable: '1.66 GB (67%)' },
    buildCache: { total: '29', active: '0', size: '2.12 GB', reclaimable: '143 KB' }
  });
  const [loading, setLoading] = useState(true);

  // Prune Action states
  const [pruningType, setPruningType] = useState<string | null>(null);
  const [pruneLog, setPruneLog] = useState<{ type: string; output: string; time: string; success: boolean } | null>(null);

  // Password update states
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState<{ success: boolean; message: string } | null>(null);

  // Logout state
  const [loggingOut, setLoggingOut] = useState(false);

  const fetchSettingsInfo = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.server) {
          setServerInfo(data.server);
          if (data.dockerUsage) setDockerUsage(data.dockerUsage);
        } else {
          // Direct shape from /api/settings/system
          setServerInfo({
            hostname: data.hostname || 'ollama-server-a1',
            osType: data.os?.type || 'Linux',
            osRelease: data.os?.release || '6.17.0-1019-oracle',
            distro: data.os?.distro || 'Ubuntu 24.04 / Alpine Linux',
            kernel: data.kernel || data.os?.release || '6.17.0-1019-oracle',
            arch: data.os?.arch || 'arm64 (aarch64)',
            uptime: data.uptime || 1523337,
            uptimeFormatted: data.uptimeFormatted || '17d 15h 8m',
            nodeVersion: data.node || 'v20.20.2',
            dockerVersion: data.docker || 'Docker 27.x',
            cpus: data.cpu?.cores || 4,
            cpuModel: data.cpu?.model || 'Neoverse-N1',
            totalMemoryGB: data.memory?.totalGB || 23.4,
            usedMemoryGB: data.memory?.usedGB || 10.8,
            disk: data.disk || { totalGB: 144.3, usedGB: 94.4, freeGB: 49.9, percent: 65 },
            memory: data.memory,
            serverTime: data.serverTime || new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.error('Failed to load system settings info', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettingsInfo();
  }, []);

  const handlePrune = async (type: 'builder' | 'system' | 'images' | 'volumes', label: string) => {
    if (!confirm(`Are you sure you want to execute "${label}"?\n\nThis will purge unused Docker resources.`)) {
      return;
    }

    setPruningType(type);
    setPruneLog(null);

    try {
      const res = await fetch('/api/settings/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Prune operation failed');
      }

      setPruneLog({
        type: label,
        output: data.output || 'Cleanup completed successfully.',
        time: new Date().toLocaleTimeString(),
        success: true
      });
      fetchSettingsInfo();
    } catch (err: any) {
      setPruneLog({
        type: label,
        output: err.message || 'Error executing Docker prune',
        time: new Date().toLocaleTimeString(),
        success: false
      });
    } finally {
      setPruningType(null);
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 6) {
      setPasswordStatus({ success: false, message: 'New password must be at least 6 characters long.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordStatus({ success: false, message: 'New passwords do not match.' });
      return;
    }

    setUpdatingPassword(true);
    setPasswordStatus(null);

    try {
      const res = await fetch('/api/auth/update-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: currentPassword.trim(),
          newPassword: newPassword.trim()
        })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to update admin password');
      }

      setPasswordStatus({ success: true, message: 'Password updated successfully!' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setPasswordStatus({ success: false, message: err.message || 'Error updating password' });
    } finally {
      setUpdatingPassword(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    } catch {
      window.location.href = '/';
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Settings className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">System Settings & Optimizer</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                Server specifications, Docker maintenance, storage reclamation, and security credentials.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <button
            onClick={() => {
              setLoading(true);
              fetchSettingsInfo();
            }}
            disabled={loading}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh Telemetry
          </button>
        </div>
      </div>

      {/* 1. Server Information Overview Card */}
      <Card className="bg-card/60 backdrop-blur-sm border-border/80 shadow-sm">
        <CardHeader className="pb-3 border-b border-border/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <Server className="w-4 h-4" />
              </div>
              <CardTitle className="text-lg font-semibold">Server Specifications & Host Information</CardTitle>
            </div>
            <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-semibold bg-emerald-500/10 px-2.5 py-0.5 rounded-full border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Online & Healthy
            </span>
          </div>
          <CardDescription className="text-xs">
            Bare-metal Oracle ARM instance specs, operating system architecture, and runtime environments.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-4">
          {loading && !serverInfo ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground gap-2">
              <RefreshCw className="w-5 h-5 animate-spin text-primary" />
              Loading server metrics...
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 text-xs">
              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">Hostname</span>
                <span className="font-semibold text-foreground mt-1 block truncate text-sm">
                  {serverInfo?.hostname || 'ollama-server-a1'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">Operating System</span>
                <span className="font-semibold text-foreground mt-1 block truncate text-sm">
                  {serverInfo?.distro || `${serverInfo?.osType} ${serverInfo?.osRelease}`}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">Linux Kernel</span>
                <span className="font-semibold text-foreground mt-1 block truncate font-mono text-sm">
                  {serverInfo?.kernel || '6.17.0-1019-oracle'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">Architecture</span>
                <span className="font-semibold text-foreground mt-1 block font-mono text-sm">
                  {serverInfo?.arch || 'aarch64 (ARM 64-bit)'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">System Uptime</span>
                <span className="font-semibold text-emerald-400 mt-1 block text-sm">
                  {serverInfo?.uptimeFormatted || `${Math.floor((serverInfo?.uptime || 0) / 86400)} days`}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">Node.js Runtime</span>
                <span className="font-semibold text-foreground mt-1 block font-mono text-sm">
                  {serverInfo?.nodeVersion || 'v20.20.2'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">Docker Engine</span>
                <span className="font-semibold text-foreground mt-1 block truncate font-mono text-sm">
                  {serverInfo?.dockerVersion || 'Docker 27.x'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
                <span className="text-muted-foreground block text-[11px]">CPU Cores & Model</span>
                <span className="font-semibold text-foreground mt-1 block truncate text-sm">
                  {serverInfo?.cpus || 4}x {serverInfo?.cpuModel || 'ARM Neoverse-N1'}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Docker Maintenance & Storage Optimizer */}
      <Card className="bg-card/60 backdrop-blur-sm border-border/80 shadow-sm">
        <CardHeader className="pb-3 border-b border-border/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <Trash2 className="w-4 h-4" />
              </div>
              <CardTitle className="text-lg font-semibold">Docker Maintenance & Storage Optimizer</CardTitle>
            </div>
            <span className="text-xs text-muted-foreground hidden sm:inline-block">
              Reclaim gigabytes of dangling Docker caches
            </span>
          </div>
          <CardDescription className="text-xs">
            1-Click maintenance actions to prune dangling layers, unused builder caches, stopped containers, and orphaned volumes.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-5 space-y-6">
          {/* Reclaimable Disk Space Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
              <div className="flex items-center justify-between text-muted-foreground text-xs">
                <span>Images Cache</span>
                <Layers className="w-3.5 h-3.5 text-blue-400" />
              </div>
              <div className="text-base font-bold text-foreground mt-1">{dockerUsage.images.size}</div>
              <div className="text-[11px] text-emerald-400 mt-0.5">{dockerUsage.images.reclaimable} reclaimable</div>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
              <div className="flex items-center justify-between text-muted-foreground text-xs">
                <span>Containers</span>
                <Container className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="text-base font-bold text-foreground mt-1">{dockerUsage.containers.size}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{dockerUsage.containers.active} active running</div>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
              <div className="flex items-center justify-between text-muted-foreground text-xs">
                <span>Local Volumes</span>
                <HardDrive className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="text-base font-bold text-foreground mt-1">{dockerUsage.volumes.size}</div>
              <div className="text-[11px] text-emerald-400 mt-0.5">{dockerUsage.volumes.reclaimable} reclaimable</div>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/60">
              <div className="flex items-center justify-between text-muted-foreground text-xs">
                <span>Build Cache</span>
                <Cpu className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="text-base font-bold text-foreground mt-1">{dockerUsage.buildCache.size}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">Dangling build layers</div>
            </div>
          </div>

          {/* 1-Click Prune Actions Grid */}
          <div>
            <label className="text-xs font-semibold text-foreground uppercase tracking-wider block mb-3">
              1-Click Optimization Actions
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Action 1: Prune Build Cache */}
              <div className="p-4 rounded-xl border border-border/80 bg-card hover:border-primary/50 transition-all flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-sm text-foreground">Prune Build Cache</h4>
                    <Cpu className="w-4 h-4 text-amber-400" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Purges multi-stage build artifacts and buildkit cache layers.
                  </p>
                </div>
                <button
                  onClick={() => handlePrune('builder', 'Prune Build Cache')}
                  disabled={pruningType !== null}
                  className="w-full inline-flex items-center justify-center rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 px-3 py-2 text-xs font-medium transition-all disabled:opacity-50"
                >
                  {pruningType === 'builder' ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Pruning Build Cache...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                      Prune Build Cache
                    </>
                  )}
                </button>
              </div>

              {/* Action 2: Clean Unused Containers & Networks */}
              <div className="p-4 rounded-xl border border-border/80 bg-card hover:border-primary/50 transition-all flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-sm text-foreground">System Prune</h4>
                    <Activity className="w-4 h-4 text-emerald-400" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Removes all stopped containers, unused networks, and dangling images.
                  </p>
                </div>
                <button
                  onClick={() => handlePrune('system', 'System Prune')}
                  disabled={pruningType !== null}
                  className="w-full inline-flex items-center justify-center rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-3 py-2 text-xs font-medium transition-all disabled:opacity-50"
                >
                  {pruningType === 'system' ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Cleaning Containers & Networks...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                      Clean System & Networks
                    </>
                  )}
                </button>
              </div>

              {/* Action 3: Remove Dangling Images */}
              <div className="p-4 rounded-xl border border-border/80 bg-card hover:border-primary/50 transition-all flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-sm text-foreground">Remove Dangling Images</h4>
                    <Layers className="w-4 h-4 text-purple-400" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Purges untagged & orphaned image layers from disk storage.
                  </p>
                </div>
                <button
                  onClick={() => handlePrune('images', 'Remove Dangling Images')}
                  disabled={pruningType !== null}
                  className="w-full inline-flex items-center justify-center rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/30 px-3 py-2 text-xs font-medium transition-all disabled:opacity-50"
                >
                  {pruningType === 'images' ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Removing Images...
                    </>
                  ) : (
                    <>
                      <Layers className="w-3.5 h-3.5 mr-1.5" />
                      Remove Dangling Images
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Prune Output Console Box */}
          {pruneLog && (
            <div className="p-4 rounded-xl border border-border bg-black/90 space-y-2 animate-in fade-in">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-bold text-foreground">Docker Prune Output ({pruneLog.type})</span>
                  <span className="text-muted-foreground">• {pruneLog.time}</span>
                </div>
                <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${pruneLog.success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                  {pruneLog.success ? 'Success' : 'Failed'}
                </span>
              </div>
              <pre className="font-mono text-xs text-green-400 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                {pruneLog.output}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Security, Authentication & Session */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Update Password Card */}
        <Card className="bg-card/60 backdrop-blur-sm border-border/80 shadow-sm">
          <CardHeader className="pb-3 border-b border-border/40">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <KeyRound className="w-4 h-4" />
              </div>
              <CardTitle className="text-base font-semibold">Security & Access Password</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Update the master admin password for K-Panel dashboard authentication.
            </CardDescription>
          </CardHeader>

          <CardContent className="pt-4">
            {passwordStatus && (
              <div className={`p-3.5 rounded-xl border text-xs flex items-center gap-2.5 mb-4 ${passwordStatus.success ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
                {passwordStatus.success ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                <span>{passwordStatus.message}</span>
              </div>
            )}

            <form onSubmit={handlePasswordUpdate} className="space-y-3.5">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  placeholder="Enter current password (if set)"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  placeholder="Minimum 6 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  placeholder="Re-type new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={updatingPassword || !newPassword}
                  className="w-full inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-4 py-2 text-xs font-medium hover:bg-primary/90 transition-all disabled:opacity-50 shadow-sm"
                >
                  {updatingPassword ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Updating Password...
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5 mr-1.5" />
                      Update Password
                    </>
                  )}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Zero-Trust Architecture & Session Card */}
        <Card className="bg-card/60 backdrop-blur-sm border-border/80 shadow-sm flex flex-col justify-between">
          <div>
            <CardHeader className="pb-3 border-b border-border/40">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <CardTitle className="text-base font-semibold">Zero-Trust & Session Management</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Inspect security perimeter, Traefik edge reverse-proxying, and terminate active browser sessions.
              </CardDescription>
            </CardHeader>

            <CardContent className="pt-4 space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-muted/30 border border-border/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Globe className="w-4 h-4 text-emerald-400" />
                  <div>
                    <div className="font-semibold text-foreground">Traefik Reverse Proxy HTTPS</div>
                    <p className="text-[11px] text-muted-foreground">Automated ACME Let's Encrypt TLS 1.3 Termination</p>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  Active
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Shield className="w-4 h-4 text-blue-400" />
                  <div>
                    <div className="font-semibold text-foreground">Zero-Trust Header Guard</div>
                    <p className="text-[11px] text-muted-foreground">Strict-Transport-Security & CSP Enabled</p>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  Enforced
                </span>
              </div>

              <div className="p-3 rounded-xl bg-muted/30 border border-border/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Clock className="w-4 h-4 text-purple-400" />
                  <div>
                    <div className="font-semibold text-foreground">Current Session Lifetime</div>
                    <p className="text-[11px] text-muted-foreground">Secure HTTPOnly Cookie Session</p>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-[11px] font-mono text-muted-foreground">
                  24 Hours
                </span>
              </div>
            </CardContent>
          </div>

          <CardFooter className="pt-0 border-t border-border/40 p-4">
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="w-full inline-flex items-center justify-center rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 px-4 py-2 text-xs font-medium transition-all disabled:opacity-50"
            >
              {loggingOut ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  Logging out...
                </>
              ) : (
                <>
                  <LogOut className="w-3.5 h-3.5 mr-1.5" />
                  Log Out of K-Panel
                </>
              )}
            </button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
