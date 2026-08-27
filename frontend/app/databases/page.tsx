"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import { Database, RefreshCw, Archive, Play, Square, FileText, CheckCircle2, AlertCircle, HardDrive, Shield, Plus, ExternalLink, Download } from 'lucide-react';
import { LogExplorerModal } from '../../components/tools/LogExplorerModal';

interface DatabaseInstance {
  id: string;
  name: string;
  image: string;
  type: 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis';
  status: string;
  count: number | null;
  label: string;
}

export default function DatabasesPage() {
  const [databases, setDatabases] = useState<DatabaseInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [backingUpId, setBackingUpId] = useState<string | null>(null);
  const [backupResult, setBackupResult] = useState<{ id: string; filename: string; success: boolean; message: string } | null>(null);
  
  // Log viewer modal
  const [selectedDbLogId, setSelectedDbLogId] = useState<string | null>(null);

  const fetchDatabases = async () => {
    try {
      const res = await fetch('/api/db');
      if (res.ok) {
        const data = await res.json();
        setDatabases(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to load databases', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDatabases();
  }, []);

  const handleBackup = async (db: DatabaseInstance) => {
    setBackingUpId(db.id);
    setBackupResult(null);

    try {
      const res = await fetch(`/api/db/${db.id}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbType: db.type })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Backup failed');
      }

      setBackupResult({
        id: db.id,
        filename: data.filename,
        success: true,
        message: `Backup saved to ${data.path} (${(data.size / 1024).toFixed(1)} KB)`
      });
    } catch (err: any) {
      setBackupResult({
        id: db.id,
        filename: '',
        success: false,
        message: err.message || 'Backup failed'
      });
    } finally {
      setBackingUpId(null);
    }
  };

  const handleRestart = async (id: string) => {
    try {
      await fetch(`/api/apps/${id}/restart`, { method: 'POST' });
      fetchDatabases();
    } catch (err) {
      console.error('Failed to restart DB', err);
    }
  };

  const totalRunning = databases.filter(d => d.status === 'running').length;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Databases Manager</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Monitor, inspect table schemas, and automate backups for PostgreSQL, MariaDB, and Redis.
          </p>
        </div>

        <button
          onClick={() => {
            setLoading(true);
            fetchDatabases();
          }}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Active Database Containers</CardDescription>
            <CardTitle className="text-2xl font-bold text-primary">{databases.length}</CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Running Engines</CardDescription>
            <CardTitle className="text-2xl font-bold text-green-500">{totalRunning} Online</CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Backup Engine</CardDescription>
            <CardTitle className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Archive className="w-5 h-5 text-primary" /> Active
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Backup Feedback Alert */}
      {backupResult && (
        <div className={`p-4 rounded-xl border ${backupResult.success ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'} flex items-start gap-3 text-sm animate-in fade-in`}>
          {backupResult.success ? <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
          <div className="flex-1">
            <div className="font-semibold">{backupResult.success ? 'Database Backup Created Successfully' : 'Backup Error'}</div>
            <p className="text-xs mt-0.5">{backupResult.message}</p>
          </div>
        </div>
      )}

      {/* Database Grid */}
      {loading && databases.length === 0 ? (
        <div className="flex justify-center items-center h-48 text-muted-foreground gap-2">
          <RefreshCw className="w-5 h-5 animate-spin text-primary" />
          Scanning Docker database containers...
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {databases.map((db) => {
            const isBackingUp = backingUpId === db.id;
            return (
              <Card key={db.id} className="flex flex-col hover:border-primary/50 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="p-2 rounded-lg bg-primary/10 text-primary">
                        <Database className="w-5 h-5" />
                      </div>
                      <div>
                        <CardTitle className="text-base font-semibold truncate max-w-[170px]">
                          {db.name}
                        </CardTitle>
                        <CardDescription className="text-xs uppercase font-mono text-primary">
                          {db.type} ({db.image})
                        </CardDescription>
                      </div>
                    </div>

                    {/* Status Dot */}
                    <div className="flex items-center gap-1.5">
                      <span className="relative flex h-2.5 w-2.5">
                        {db.status === 'running' && (
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                        )}
                        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${db.status === 'running' ? 'bg-green-500' : 'bg-gray-500'}`}></span>
                      </span>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="flex-1 pb-4 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between p-2 rounded-md bg-muted/40">
                    <span className="text-muted-foreground">Detected Records / Schema:</span>
                    <span className="font-semibold font-mono text-foreground">
                      {db.count !== null ? `${db.count} ${db.label}` : 'Active (Running)'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-md bg-muted/40">
                    <span className="text-muted-foreground">Container ID:</span>
                    <span className="font-mono text-muted-foreground">{db.id}</span>
                  </div>
                </CardContent>

                <CardFooter className="pt-0 border-t border-border/40 bg-muted/20 px-4 py-3 gap-2 flex items-center justify-between">
                  <button
                    onClick={() => handleBackup(db)}
                    disabled={isBackingUp || db.status !== 'running'}
                    className="inline-flex items-center justify-center rounded-md bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    {isBackingUp ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Archive className="w-3.5 h-3.5 mr-1.5" />}
                    {isBackingUp ? 'Dumping...' : 'Backup SQL'}
                  </button>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSelectedDbLogId(db.id)}
                      title="View Logs"
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <FileText className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleRestart(db.id)}
                      title="Restart Container"
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      {/* Log Explorer Modal */}
      {selectedDbLogId && (
        <LogExplorerModal
          isOpen={true}
          onClose={() => setSelectedDbLogId(null)}
          initialContainerId={selectedDbLogId}
        />
      )}
    </div>
  );
}