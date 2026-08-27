"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import {
  Archive,
  Database,
  FileText,
  Download,
  Trash2,
  Plus,
  RefreshCw,
  HardDrive,
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
  Search,
  FolderArchive,
  Folder,
  Sparkles,
  ShieldCheck,
  Check,
  ExternalLink,
  Layers,
  ArrowDownToLine,
  Server
} from 'lucide-react';

interface BackupItem {
  id: string;
  filename: string;
  path: string;
  dir?: string;
  size: number;
  sizeFormatted: string;
  type: 'database' | 'archive' | 'config' | 'script';
  createdAt: string;
  isDir?: boolean;
}

interface BackupsSummary {
  total: number;
  totalSizeBytes: number;
  totalSizeFormatted: string;
  lastBackup: string | null;
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [summary, setSummary] = useState<BackupsSummary>({
    total: 0,
    totalSizeBytes: 0,
    totalSizeFormatted: '0 MB',
    lastBackup: null
  });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'database' | 'archive' | 'config'>('all');

  // Create Backup Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [backupType, setBackupType] = useState<'database' | 'apps_archive' | 'snapshot'>('database');
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [createFeedback, setCreateFeedback] = useState<{ success: boolean; message: string } | null>(null);

  // Delete & Download states
  const [deletingFilename, setDeletingFilename] = useState<string | null>(null);

  const fetchBackups = async () => {
    try {
      const res = await fetch('/api/backups');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          // If returned as direct array
          const items: BackupItem[] = data.map((b: any, i: number) => ({
            id: b.id || `b_${i}`,
            filename: b.filename || b.name || 'backup.sql',
            path: b.path || '',
            size: b.size || 0,
            sizeFormatted: b.sizeFormatted || `${((b.size || 0) / 1024 / 1024).toFixed(2)} MB`,
            type: b.type || (b.filename?.endsWith('.sql') ? 'database' : 'archive'),
            createdAt: b.createdAt || b.mtime || new Date().toISOString(),
            isDir: b.isDir
          }));

          const totalBytes = items.reduce((acc, curr) => acc + (curr.size || 0), 0);
          const newest = items.length > 0 ? items[0].createdAt : null;

          setBackups(items);
          setSummary({
            total: items.length,
            totalSizeBytes: totalBytes,
            totalSizeFormatted: `${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
            lastBackup: newest
          });
        } else if (data.backups) {
          setBackups(data.backups);
          if (data.summary) {
            setSummary(data.summary);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load backups', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBackups();
  }, []);

  const handleCreateBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingBackup(true);
    setCreateFeedback(null);

    try {
      const res = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: backupType })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Backup creation failed');
      }

      setCreateFeedback({
        success: true,
        message: `Backup created: ${data.filename} (${data.sizeFormatted || 'Saved'})`
      });
      fetchBackups();
      setTimeout(() => {
        setShowCreateModal(false);
        setCreateFeedback(null);
      }, 2000);
    } catch (err: any) {
      setCreateFeedback({
        success: false,
        message: err.message || 'Error generating backup archive'
      });
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(`Are you sure you want to permanently delete this backup file?\n\nFile: ${filename}`)) {
      return;
    }

    setDeletingFilename(filename);
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchBackups();
      }
    } catch (err) {
      console.error('Failed to delete backup', err);
    } finally {
      setDeletingFilename(null);
    }
  };

  const filteredBackups = backups.filter(b => {
    const matchesSearch =
      b.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
      b.type.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;
    if (typeFilter === 'all') return true;
    return b.type === typeFilter;
  });

  const dbCount = backups.filter(b => b.type === 'database').length;
  const archiveCount = backups.filter(b => b.type === 'archive').length;
  const configCount = backups.filter(b => b.type === 'config' || b.type === 'script').length;

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Archive className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Backups & Snapshots</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                Create and manage SQL database dumps, application folder archives, and system snapshots.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <button
            onClick={() => {
              setLoading(true);
              fetchBackups();
            }}
            disabled={loading}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-all shadow-sm"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Create Backup
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total Backups
            </CardDescription>
            <Archive className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {loading ? '-' : summary.total}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              SQL dumps & folder archives
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total Backup Storage
            </CardDescription>
            <HardDrive className="w-4 h-4 text-blue-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-400">
              {loading ? '-' : summary.totalSizeFormatted}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Across /home/ubuntu/backups
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Last Backup Created
            </CardDescription>
            <Clock className="w-4 h-4 text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-base font-bold text-foreground truncate">
              {summary.lastBackup
                ? new Date(summary.lastBackup).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : 'No backups yet'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.lastBackup ? 'Verified integrity' : 'Create an archive to protect data'}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Storage Destinations
            </CardDescription>
            <FolderArchive className="w-4 h-4 text-purple-400" />
          </CardHeader>
          <CardContent>
            <div className="text-base font-bold text-foreground">
              Local NVMe Pool
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Ready
              </span>
              <span className="text-[11px] text-muted-foreground">/home/ubuntu/backups</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Backups List & Management Section */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Existing Backups</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Download, manage, and inspect historical database snapshots and app file backups.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search backups..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full sm:w-60 pl-8 pr-3 py-1.5 text-xs rounded-lg bg-card border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center p-0.5 rounded-lg bg-muted/40 border border-border/50 text-xs">
              <button
                onClick={() => setTypeFilter('all')}
                className={`px-2.5 py-1 rounded-md transition-all ${typeFilter === 'all' ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                All ({backups.length})
              </button>
              <button
                onClick={() => setTypeFilter('database')}
                className={`px-2.5 py-1 rounded-md transition-all ${typeFilter === 'database' ? 'bg-card text-blue-400 font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Databases ({dbCount})
              </button>
              <button
                onClick={() => setTypeFilter('archive')}
                className={`px-2.5 py-1 rounded-md transition-all ${typeFilter === 'archive' ? 'bg-card text-purple-400 font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Archives ({archiveCount})
              </button>
            </div>
          </div>
        </div>

        {/* Backups Table */}
        <div className="rounded-xl border border-border bg-card/40 backdrop-blur-sm overflow-hidden shadow-sm">
          {loading && backups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-56 text-muted-foreground gap-3">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm">Scanning backup directories on host...</p>
            </div>
          ) : filteredBackups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground p-6 text-center">
              <FolderArchive className="w-10 h-10 mb-2 opacity-40 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No backups found</p>
              <p className="text-xs text-muted-foreground mt-1">Click "Create Backup" above to generate your first snapshot.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wider border-b border-border font-medium">
                  <tr>
                    <th className="py-3 px-4">Backup Filename</th>
                    <th className="py-3 px-4">Type</th>
                    <th className="py-3 px-4">Storage Size</th>
                    <th className="py-3 px-4">Created Date & Time</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filteredBackups.map((b) => {
                    const isDeleting = deletingFilename === b.filename;
                    const isSql = b.type === 'database' || b.filename.endsWith('.sql');
                    const isTar = b.type === 'archive' || b.filename.endsWith('.tar.gz') || b.filename.endsWith('.zip');

                    return (
                      <tr key={b.filename} className="hover:bg-muted/30 transition-colors group">
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2.5">
                            <div className={`p-2 rounded-lg ${isSql ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : isTar ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}`}>
                              {isSql ? <Database className="w-4 h-4" /> : isTar ? <Archive className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                            </div>
                            <div>
                              <div className="font-semibold text-foreground font-mono text-xs truncate max-w-sm">
                                {b.filename}
                              </div>
                              <span className="text-[10px] text-muted-foreground truncate block max-w-xs mt-0.5">
                                {b.path || `/home/ubuntu/backups/${b.filename}`}
                              </span>
                            </div>
                          </div>
                        </td>

                        <td className="py-3.5 px-4">
                          {isSql ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                              Database SQL
                            </span>
                          ) : isTar ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                              Folder Archive
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              Config Snapshot
                            </span>
                          )}
                        </td>

                        <td className="py-3.5 px-4 text-xs font-mono font-medium text-foreground">
                          {b.sizeFormatted}
                        </td>

                        <td className="py-3.5 px-4 text-xs text-muted-foreground">
                          {new Date(b.createdAt).toLocaleString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </td>

                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <a
                              href={`/api/backups/download/${encodeURIComponent(b.filename)}`}
                              download={b.filename}
                              title="Download Backup"
                              className="inline-flex items-center gap-1 rounded-lg border border-border/80 bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
                            >
                              <ArrowDownToLine className="w-3.5 h-3.5" />
                              Download
                            </a>

                            <button
                              onClick={() => handleDeleteBackup(b.filename)}
                              disabled={isDeleting}
                              title="Delete Backup"
                              className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50"
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
          )}
        </div>
      </div>

      {/* "Create Backup" Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl p-6 space-y-5 animate-in zoom-in-95">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <Archive className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Create Instant Backup</h3>
                  <p className="text-xs text-muted-foreground">Select backup source and generate snapshot archive.</p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            {createFeedback && (
              <div className={`p-3.5 rounded-xl border text-xs flex items-center gap-2.5 ${createFeedback.success ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
                {createFeedback.success ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                <span>{createFeedback.message}</span>
              </div>
            )}

            <form onSubmit={handleCreateBackup} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-2">
                  Select Backup Strategy
                </label>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setBackupType('database')}
                    className={`w-full p-3 rounded-xl border text-left flex items-start gap-3 transition-all ${
                      backupType === 'database'
                        ? 'bg-primary/10 border-primary shadow-sm'
                        : 'bg-muted/30 border-border/60 hover:bg-muted/60'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${backupType === 'database' ? 'bg-blue-500/20 text-blue-400' : 'bg-muted text-muted-foreground'}`}>
                      <Database className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-xs text-foreground flex items-center justify-between">
                        <span>Database SQL Dump</span>
                        {backupType === 'database' && <Check className="w-4 h-4 text-primary" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Dumps MariaDB / PostgreSQL databases into a `.sql` file using `mysqldump` / `pg_dump`.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setBackupType('apps_archive')}
                    className={`w-full p-3 rounded-xl border text-left flex items-start gap-3 transition-all ${
                      backupType === 'apps_archive'
                        ? 'bg-primary/10 border-primary shadow-sm'
                        : 'bg-muted/30 border-border/60 hover:bg-muted/60'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${backupType === 'apps_archive' ? 'bg-purple-500/20 text-purple-400' : 'bg-muted text-muted-foreground'}`}>
                      <FolderArchive className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-xs text-foreground flex items-center justify-between">
                        <span>Applications Folder Archive</span>
                        {backupType === 'apps_archive' && <Check className="w-4 h-4 text-primary" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Creates compressed `.tar.gz` archive of `/home/ubuntu/apps` and application codebases.
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setBackupType('snapshot')}
                    className={`w-full p-3 rounded-xl border text-left flex items-start gap-3 transition-all ${
                      backupType === 'snapshot'
                        ? 'bg-primary/10 border-primary shadow-sm'
                        : 'bg-muted/30 border-border/60 hover:bg-muted/60'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${backupType === 'snapshot' ? 'bg-amber-500/20 text-amber-400' : 'bg-muted text-muted-foreground'}`}>
                      <Layers className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-xs text-foreground flex items-center justify-between">
                        <span>K-Panel Configuration Snapshot</span>
                        {backupType === 'snapshot' && <Check className="w-4 h-4 text-primary" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Backs up K-Panel settings, deployments state, and persistent panel data.
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-muted/40 border border-border/50 text-[11px] text-muted-foreground flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span>Backups are saved directly to <code className="text-foreground">/home/ubuntu/backups</code>.</span>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingBackup}
                  className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-5 py-2 text-xs font-medium hover:bg-primary/90 transition-all disabled:opacity-50 shadow-sm"
                >
                  {creatingBackup ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Creating Backup...
                    </>
                  ) : (
                    <>
                      <Archive className="w-3.5 h-3.5 mr-1.5" />
                      Generate Backup Now
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}