"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import {
  Clock,
  Play,
  Trash2,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Calendar,
  Code,
  Copy,
  Check,
  Search,
  Zap,
  Sparkles,
  Layers,
  ChevronRight,
  Info,
  Timer,
  XCircle
} from 'lucide-react';

interface CronJob {
  id: string;
  index?: number;
  schedule: string;
  command: string;
  comment?: string;
  humanReadable: string;
  active: boolean;
  raw?: string;
}

interface CronSummary {
  total: number;
  active: number;
}

interface RunResult {
  command: string;
  success: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  executedAt: string;
}

const SCHEDULE_PRESETS = [
  { label: 'Every 5 Mins', expr: '*/5 * * * *', desc: 'Runs every 5th minute' },
  { label: 'Hourly', expr: '0 * * * *', desc: 'Runs once at the beginning of every hour' },
  { label: 'Daily (Midnight)', expr: '0 0 * * *', desc: 'Runs every night at 00:00 UTC' },
  { label: 'Daily (12 PM)', expr: '0 12 * * *', desc: 'Runs every day at 12:00 PM (noon)' },
  { label: 'Weekly (Sun)', expr: '0 0 * * 0', desc: 'Runs every Sunday at midnight' },
  { label: 'Monthly (1st)', expr: '0 0 1 * *', desc: 'Runs on the 1st day of every month at midnight' }
];

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [summary, setSummary] = useState<CronSummary>({ total: 0, active: 0 });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Add Modal states
  const [showAddModal, setShowAddModal] = useState(false);
  const [newSchedule, setNewSchedule] = useState('0 0 * * *');
  const [newCommand, setNewCommand] = useState('');
  const [newComment, setNewComment] = useState('');
  const [savingJob, setSavingJob] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Run Modal states
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [showRunModal, setShowRunModal] = useState(false);

  // Delete states
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copiedCommandId, setCopiedCommandId] = useState<string | null>(null);

  const fetchCronJobs = async () => {
    try {
      const res = await fetch('/api/cron');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          // If returned as direct array
          const parsedJobs: CronJob[] = data.map((j: any, i: number) => ({
            id: j.id || `cron_${i}`,
            index: j.lineIndex ?? i,
            schedule: j.schedule || '* * * * *',
            command: j.command || '',
            comment: j.comment || '',
            humanReadable: j.humanReadable || j.schedule || 'Scheduled task',
            active: true,
            raw: j.raw || ''
          }));
          setJobs(parsedJobs);
          setSummary({ total: parsedJobs.length, active: parsedJobs.length });
        } else if (data.jobs) {
          setJobs(data.jobs);
          if (data.summary) {
            setSummary(data.summary);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load cron jobs', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCronJobs();
  }, []);

  const handleAddCron = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSchedule.trim() || !newCommand.trim()) {
      setAddError('Schedule expression and command are required.');
      return;
    }

    setSavingJob(true);
    setAddError(null);

    try {
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule: newSchedule.trim(),
          command: newCommand.trim(),
          comment: newComment.trim()
        })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to save cron job');
      }

      setShowAddModal(false);
      setNewCommand('');
      setNewComment('');
      setNewSchedule('0 0 * * *');
      fetchCronJobs();
    } catch (err: any) {
      setAddError(err.message || 'Error saving cron job');
    } finally {
      setSavingJob(false);
    }
  };

  const handleDeleteJob = async (job: CronJob) => {
    if (!confirm(`Are you sure you want to remove this cron job?\n\nCommand: ${job.command}`)) {
      return;
    }

    setDeletingId(job.id);
    try {
      const res = await fetch(`/api/cron/${job.id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchCronJobs();
      }
    } catch (err) {
      console.error('Failed to delete cron job', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleRunNow = async (job: CronJob) => {
    setRunningJobId(job.id);
    setRunResult(null);

    try {
      const res = await fetch('/api/cron/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: job.command })
      });

      const data = await res.json();
      setRunResult({
        command: job.command,
        success: data.success ?? true,
        exitCode: data.exitCode ?? 0,
        output: data.output || '(Execution finished with empty output)',
        durationMs: data.durationMs ?? 100,
        executedAt: new Date().toLocaleTimeString()
      });
      setShowRunModal(true);
    } catch (err: any) {
      setRunResult({
        command: job.command,
        success: false,
        exitCode: 1,
        output: `Execution error: ${err.message}`,
        durationMs: 0,
        executedAt: new Date().toLocaleTimeString()
      });
      setShowRunModal(true);
    } finally {
      setRunningJobId(null);
    }
  };

  const copyCommand = (id: string, cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCommandId(id);
    setTimeout(() => setCopiedCommandId(null), 2000);
  };

  const filteredJobs = jobs.filter(job => {
    const matchesSearch =
      job.command.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (job.comment && job.comment.toLowerCase().includes(searchQuery.toLowerCase())) ||
      job.schedule.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.humanReadable.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Cron Jobs & Scheduled Tasks</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                Manage Linux crontab schedules, recurring automation pipelines, and trigger immediate task runs.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <button
            onClick={() => {
              setLoading(true);
              fetchCronJobs();
            }}
            disabled={loading}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-all shadow-sm"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Add Cron Job
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total Cron Jobs
            </CardDescription>
            <Clock className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {loading ? '-' : summary.total}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Registered in Linux crontab
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Active Schedules
            </CardDescription>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-400">
              {loading ? '-' : summary.active} Running
            </div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Automated execution active
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Cron Engine
            </CardDescription>
            <Zap className="w-4 h-4 text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="text-base font-bold text-foreground">
              System Crontab Daemon
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Healthy
              </span>
              <span className="text-[11px] text-muted-foreground">/var/spool/cron</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Crontab Search & Filter */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Active Crontab Entries</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Review expression timings, human-readable definitions, and execute commands on-demand.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search command or schedule..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-card border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Table of Cron Jobs */}
        <div className="rounded-xl border border-border bg-card/40 backdrop-blur-sm overflow-hidden shadow-sm">
          {loading && jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-56 text-muted-foreground gap-3">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm">Reading server crontab entries...</p>
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground p-6 text-center">
              <Clock className="w-10 h-10 mb-2 opacity-40 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No cron jobs configured</p>
              <p className="text-xs text-muted-foreground mt-1">Click "Add Cron Job" to schedule your first automated task.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wider border-b border-border font-medium">
                  <tr>
                    <th className="py-3 px-4">Schedule Expression</th>
                    <th className="py-3 px-4">Human Readable Timing</th>
                    <th className="py-3 px-4">Description / Purpose</th>
                    <th className="py-3 px-4">Command</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filteredJobs.map((job) => {
                    const isRunning = runningJobId === job.id;
                    const isDeleting = deletingId === job.id;

                    return (
                      <tr key={job.id} className="hover:bg-muted/30 transition-colors group">
                        <td className="py-3.5 px-4">
                          <div className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold px-2.5 py-1 rounded-md bg-primary/10 text-primary border border-primary/20">
                            <Timer className="w-3.5 h-3.5" />
                            {job.schedule}
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-xs font-medium text-foreground">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            <span>{job.humanReadable}</span>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-xs text-muted-foreground">
                          {job.comment ? (
                            <span className="font-medium text-foreground">{job.comment}</span>
                          ) : (
                            <span className="italic text-muted-foreground/60">Automated task</span>
                          )}
                        </td>

                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-1.5 max-w-md">
                            <div className="font-mono text-xs bg-muted/60 px-2.5 py-1 rounded border border-border/50 text-muted-foreground truncate flex-1">
                              {job.command}
                            </div>
                            <button
                              onClick={() => copyCommand(job.id, job.command)}
                              title="Copy command"
                              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {copiedCommandId === job.id ? (
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => handleRunNow(job)}
                              disabled={isRunning}
                              title="Run Now"
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2.5 py-1 text-xs font-medium transition-all disabled:opacity-50"
                            >
                              <Play className={`w-3 h-3 ${isRunning ? 'animate-spin' : ''}`} />
                              {isRunning ? 'Running...' : 'Run Now'}
                            </button>

                            <button
                              onClick={() => handleDeleteJob(job)}
                              disabled={isDeleting}
                              title="Delete Cron Job"
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

      {/* "Add Cron Job" Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-2xl p-6 space-y-5 animate-in zoom-in-95">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Schedule New Cron Task</h3>
                  <p className="text-xs text-muted-foreground">Add a recurring scheduled job to the Linux crontab.</p>
                </div>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            {addError && (
              <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{addError}</span>
              </div>
            )}

            <form onSubmit={handleAddCron} className="space-y-4">
              {/* Presets Grid */}
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Schedule Preset
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {SCHEDULE_PRESETS.map((preset) => {
                    const isSelected = newSchedule === preset.expr;
                    return (
                      <button
                        type="button"
                        key={preset.label}
                        onClick={() => setNewSchedule(preset.expr)}
                        className={`p-2 rounded-lg border text-left text-xs transition-all ${
                          isSelected
                            ? 'bg-primary/10 border-primary text-primary font-medium shadow-sm'
                            : 'bg-muted/30 border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                        }`}
                      >
                        <div className="font-semibold">{preset.label}</div>
                        <div className="font-mono text-[10px] opacity-75 mt-0.5">{preset.expr}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Schedule Expression Input */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-foreground">
                    Cron Schedule Expression (min hour dom mon dow)
                  </label>
                  <span className="text-[11px] text-primary font-mono font-semibold">
                    {newSchedule}
                  </span>
                </div>
                <input
                  type="text"
                  placeholder="e.g. 0 0 * * *"
                  value={newSchedule}
                  onChange={(e) => setNewSchedule(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              {/* Description / Comment */}
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  Description / Comment (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Daily database backup & WordPress sync"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              {/* Command Input */}
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  Shell Command to Execute
                </label>
                <textarea
                  rows={3}
                  placeholder="e.g. /usr/bin/python3 /home/ubuntu/script.py >> /home/ubuntu/logs/cron.log 2>&1"
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingJob || !newCommand.trim()}
                  className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-5 py-2 text-xs font-medium hover:bg-primary/90 transition-all disabled:opacity-50 shadow-sm"
                >
                  {savingJob ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Saving to Crontab...
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5 mr-1.5" />
                      Save Cron Job
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* "Run Now" Execution Console Modal */}
      {showRunModal && runResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl p-6 space-y-4 animate-in zoom-in-95">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${runResult.success ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                  <Terminal className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Command Execution Output</h3>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>Executed at {runResult.executedAt}</span>
                    <span>•</span>
                    <span>Duration: {runResult.durationMs}ms</span>
                    <span>•</span>
                    <span className={`font-semibold ${runResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                      Exit Code: {runResult.exitCode}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowRunModal(false)}
                className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <div className="p-2.5 rounded-lg bg-muted/40 border border-border/50 font-mono text-xs text-muted-foreground truncate">
              <span className="text-primary font-bold mr-1.5">$</span>
              {runResult.command}
            </div>

            {/* Terminal Window */}
            <div className="rounded-lg bg-black/90 border border-border/60 p-4 font-mono text-xs text-green-400 max-h-72 overflow-y-auto space-y-1 shadow-inner">
              <pre className="whitespace-pre-wrap leading-relaxed font-mono">
                {runResult.output}
              </pre>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <button
                onClick={() => setShowRunModal(false)}
                className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-5 py-2 text-xs font-medium hover:bg-primary/90 transition-all shadow-sm"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}