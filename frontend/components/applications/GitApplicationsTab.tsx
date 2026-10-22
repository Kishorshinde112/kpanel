"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderGit2,
  GitBranch,
  Globe,
  Server,
  Plus,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Clock,
  Layers,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  CheckCircle2,
  FileCode,
  Box,
  Copy,
  Check,
  Cpu,
  Sliders
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../ui/Card';
import { GitApplication, ApplicationsListResponse } from '../../types/application';
import { CreateGitApplicationModal } from './CreateGitApplicationModal';

interface GitApplicationsTabProps {
  onShowToast: (text: string, type?: 'success' | 'error') => void;
}

export const GitApplicationsTab: React.FC<GitApplicationsTabProps> = ({ onShowToast }) => {
  const [applications, setApplications] = useState<GitApplication[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchApplications = useCallback(async (targetPage = 1, isSilent = false) => {
    if (!isSilent) setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/applications?page=${targetPage}&limit=20`);

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Your session has expired. Please refresh the page to sign in.');
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message || 'Failed to fetch registered applications.');
      }

      const json: ApplicationsListResponse = await res.json();
      setApplications(Array.isArray(json.data) ? json.data : []);
      if (json.pagination) {
        setPagination(json.pagination);
      }
    } catch (err: any) {
      setError(err.message || 'Cannot communicate with K-Panel API.');
      if (!isSilent) {
        onShowToast(err.message || 'Error loading applications', 'error');
      }
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => {
    fetchApplications(1);
  }, [fetchApplications]);

  const handleCopy = (e: React.MouseEvent, text: string, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    onShowToast('Copied to clipboard');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreateSuccess = (newApp: GitApplication) => {
    onShowToast(`Application "${newApp.name}" registered successfully!`);
    fetchApplications(1);
  };

  return (
    <div className="space-y-6">
      {/* Action Header & Summary Bar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <FolderGit2 className="w-5 h-5 text-primary" />
            <span>Git Repository Services</span>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Registered web applications, repository mappings, and automated deployment profiles.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchApplications(pagination.page)}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-xl border border-input bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
            title="Refresh applications"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            Refresh
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-xs font-semibold transition-all shadow-sm gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Register Git Application</span>
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && !loading && (
        <div className="p-4 rounded-xl border border-destructive/40 bg-destructive/10 text-xs text-red-300 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold block text-red-200">Unable to load Git applications</span>
            <p className="mt-0.5 text-red-300/80">{error}</p>
          </div>
          <button
            onClick={() => fetchApplications(pagination.page)}
            className="px-3 py-1 rounded-lg border border-destructive/30 bg-destructive/20 text-xs font-medium hover:bg-destructive/30"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main Content Area */}
      {loading && applications.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-border/60 rounded-2xl bg-card/40 text-muted-foreground gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          <span className="text-xs font-medium">Loading Git application profiles...</span>
        </div>
      ) : applications.length === 0 && !error ? (
        /* Empty State */
        <Card className="border-dashed border-2 bg-card/30 p-8 sm:p-12 text-center flex flex-col items-center justify-center space-y-4">
          <div className="p-4 rounded-2xl bg-primary/10 border border-primary/20 text-primary">
            <FolderGit2 className="w-8 h-8" />
          </div>
          <div className="max-w-md space-y-1">
            <h3 className="text-base font-semibold text-foreground">No Git applications registered yet</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Connect your first Git repository (GitHub, GitLab, or generic Git) to configure branches, build strategies, ports, and domains.
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Register First Application</span>
          </button>
        </Card>
      ) : (
        /* Applications Card Grid */
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {applications.map((app) => (
              <Card
                key={app.id}
                className="flex flex-col justify-between hover:border-primary/50 transition-all duration-200 bg-card/70 backdrop-blur-sm shadow-sm"
              >
                <CardHeader className="pb-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className="p-2.5 bg-primary/10 rounded-xl text-primary shrink-0 border border-primary/20">
                        <FolderGit2 className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <Link
                          href={`/applications/${app.id}`}
                          className="hover:text-primary transition-colors block truncate"
                        >
                          <CardTitle className="text-base font-semibold truncate text-foreground hover:text-primary transition-colors cursor-pointer" title={app.name}>
                            {app.name}
                          </CardTitle>
                        </Link>
                        <CardDescription className="text-xs truncate font-mono text-muted-foreground" title={app.slug}>
                          {app.slug}
                        </CardDescription>
                      </div>
                    </div>

                    {/* Status Badge: Configured - Not Deployed */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30">
                        Configured
                      </span>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="pb-4 space-y-3 text-xs">
                  {/* Repository URL */}
                  <div className="p-2 rounded-lg bg-muted/40 font-mono text-[11px] truncate flex items-center justify-between gap-2">
                    <span className="truncate text-foreground/90 select-all" title={app.repo_url}>
                      {app.repo_url}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleCopy(e, app.repo_url, `repo-${app.id}`)}
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-1"
                      title="Copy Repository URL"
                    >
                      {copiedId === `repo-${app.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>

                  {/* Attributes Pills */}
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="p-2 rounded-lg bg-muted/30 border border-border/50 space-y-0.5">
                      <span className="text-muted-foreground block text-[10px]">Tracked Branch</span>
                      <div className="flex items-center gap-1 font-mono font-medium text-foreground truncate">
                        <GitBranch className="w-3 h-3 text-primary shrink-0" />
                        <span className="truncate">{app.branch}</span>
                      </div>
                    </div>

                    <div className="p-2 rounded-lg bg-muted/30 border border-border/50 space-y-0.5">
                      <span className="text-muted-foreground block text-[10px]">Build Strategy</span>
                      <div className="flex items-center gap-1 font-medium capitalize text-foreground truncate">
                        <FileCode className="w-3 h-3 text-blue-400 shrink-0" />
                        <span className="truncate">{app.build_type}</span>
                      </div>
                    </div>

                    <div className="p-2 rounded-lg bg-muted/30 border border-border/50 space-y-0.5">
                      <span className="text-muted-foreground block text-[10px]">Container Port</span>
                      <div className="flex items-center gap-1 font-mono font-medium text-foreground">
                        <Server className="w-3 h-3 text-purple-400 shrink-0" />
                        <span>:{app.port}</span>
                      </div>
                    </div>

                    <div className="p-2 rounded-lg bg-muted/30 border border-border/50 space-y-0.5">
                      <span className="text-muted-foreground block text-[10px]">Domain</span>
                      <div className="flex items-center gap-1 font-medium text-foreground truncate" title={app.domain || 'None'}>
                        <Globe className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span className="truncate">{app.domain || 'Not Bound'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Cgroups limits */}
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/40">
                    <span className="flex items-center gap-1">
                      <Cpu className="w-3 h-3" /> {app.cpu_limit} Cores • {app.memory_limit_mb} MB RAM
                    </span>
                    <span className="flex items-center gap-1 text-[10px]">
                      <Clock className="w-3 h-3" /> {new Date(app.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </CardContent>

                {/* Footer Status Notice & Manage Link */}
                <CardFooter className="pt-0 border-t border-border/40 bg-muted/20 px-4 py-2.5 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                    <span>Configured</span>
                  </div>

                  <Link
                    href={`/applications/${app.id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold transition-colors"
                    title="Manage application configuration"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>Manage</span>
                  </Link>
                </CardFooter>
              </Card>
            ))}
          </div>

          {/* Pagination Controls */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-border/60 text-xs text-muted-foreground">
              <div>
                Showing page <span className="font-semibold text-foreground">{pagination.page}</span> of{' '}
                <span className="font-semibold text-foreground">{pagination.totalPages}</span> ({pagination.total} Total)
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => fetchApplications(pagination.page - 1)}
                  disabled={pagination.page <= 1 || loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-input text-xs font-medium hover:bg-muted disabled:opacity-50 transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Previous
                </button>
                <button
                  onClick={() => fetchApplications(pagination.page + 1)}
                  disabled={pagination.page >= pagination.totalPages || loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-input text-xs font-medium hover:bg-muted disabled:opacity-50 transition-colors"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Application Modal */}
      <CreateGitApplicationModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
};
