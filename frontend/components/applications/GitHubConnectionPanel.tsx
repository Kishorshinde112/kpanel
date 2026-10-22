"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
  Lock,
  GitBranch,
  Building,
  User,
  HelpCircle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/Card';

interface GitHubAppStatus {
  configured: boolean;
  allowlistConfigured: boolean;
  app: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

interface GitHubInstallation {
  installation_id: string;
  account_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  installation_status: 'active' | 'suspended' | 'not_allowlisted';
  is_allowlisted: boolean;
  suspended: boolean;
}

interface GitHubConnectionPanelProps {
  onShowToast: (text: string, type?: 'success' | 'error') => void;
}

export const GitHubConnectionPanel: React.FC<GitHubConnectionPanelProps> = ({ onShowToast }) => {
  const [status, setStatus] = useState<GitHubAppStatus | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingInstallations, setRefreshingInstallations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // 1. Fetch GitHub App Status & Install URL
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/github/status');
      if (res.status === 401) {
        return;
      }
      if (!res.ok) {
        throw new Error('Failed to verify GitHub App configuration.');
      }
      const data: GitHubAppStatus = await res.json();
      setStatus(data);

      if (data.configured) {
        // Fetch install URL
        const urlRes = await fetch('/api/github/install-url');
        if (urlRes.ok) {
          const urlData = await urlRes.json();
          setInstallUrl(urlData.installUrl);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Cannot communicate with GitHub integration API.');
    } finally {
      setLoading(false);
    }
  }, []);

  // 2. Fetch Verified Installations
  const fetchInstallations = useCallback(async (isSilent = false) => {
    if (!status?.configured) return;
    if (!isSilent) setRefreshingInstallations(true);

    try {
      const res = await fetch('/api/github/installations');
      if (res.status === 401) {
        return;
      }
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || 'Failed to list GitHub App installations.');
      }
      const json = await res.json();
      setInstallations(Array.isArray(json.data) ? json.data : []);
    } catch (err: any) {
      if (!isSilent) {
        onShowToast(err.message || 'Error loading installations', 'error');
      }
    } finally {
      if (!isSilent) setRefreshingInstallations(false);
    }
  }, [status?.configured, onShowToast]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (status?.configured) {
      fetchInstallations(true);
    }
  }, [status?.configured, fetchInstallations]);

  const handleRefreshClick = async () => {
    await fetchStatus();
    if (status?.configured) {
      await fetchInstallations(false);
    }
    onShowToast('GitHub App status refreshed.');
  };

  return (
    <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm overflow-hidden">
      <CardHeader className="py-3 px-4 sm:px-6 border-b border-border/40 bg-muted/10">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20 shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-semibold text-foreground">
                  GitHub App Integration & Private Repositories
                </CardTitle>
                {loading ? (
                  <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />
                ) : status?.configured ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Configured • {status.app?.name || 'K-Panel App'}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-muted text-muted-foreground border border-border/80">
                    Unconfigured (Public Repositories Only)
                  </span>
                )}
              </div>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Authenticate private GitHub repositories using short-lived installation tokens.
              </CardDescription>
            </div>
          </div>

          <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end">
            <button
              onClick={handleRefreshClick}
              disabled={loading || refreshingInstallations}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-input text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
              title="Refresh GitHub Status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingInstallations ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>

            {status?.configured && installUrl && (
              <a
                href={installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all shadow-sm"
              >
                <span>Install GitHub App</span>
                <ExternalLink className="w-3 h-3 opacity-75" />
              </a>
            )}

            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={isExpanded ? 'Collapse section' : 'Expand section'}
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </CardHeader>

      {/* Expanded Details Section */}
      {isExpanded && (
        <CardContent className="p-4 sm:p-6 space-y-4 text-xs animate-in fade-in duration-150">
          {!status?.configured ? (
            /* Unconfigured State */
            <div className="p-4 rounded-xl border border-border/80 bg-muted/30 text-muted-foreground space-y-2">
              <div className="flex items-center gap-2 text-foreground font-semibold">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <span>GitHub App Identity Not Configured on Server</span>
              </div>
              <p className="text-[11px] leading-relaxed">
                K-Panel is currently running in public repository mode. Public Git repositories on GitHub can be fetched and configured without any credentials.
              </p>
              <div className="p-3 rounded-lg bg-background/60 border border-border/60 text-[11px] font-mono space-y-1">
                <span className="text-muted-foreground block text-[10px] font-sans font-medium">To enable private repositories, configure in backend environment:</span>
                <div>GITHUB_APP_ID=your_app_id</div>
                <div>GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem</div>
                <div>GITHUB_ALLOWED_ACCOUNT_IDS=your_numeric_github_id</div>
              </div>
            </div>
          ) : (
            /* Configured State: Installations List */
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <div className="font-semibold text-foreground flex items-center gap-2">
                  <span>Connected GitHub Organizations & Accounts</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-muted text-muted-foreground">
                    {installations.length}
                  </span>
                </div>
                {!status.allowlistConfigured && (
                  <span className="text-[11px] text-amber-400 flex items-center gap-1 font-medium">
                    <AlertCircle className="w-3.5 h-3.5" /> GITHUB_ALLOWED_ACCOUNT_IDS not set
                  </span>
                )}
              </div>

              {installations.length === 0 ? (
                <div className="p-6 rounded-xl border border-dashed border-border/80 text-center space-y-2 bg-muted/10">
                  <p className="text-muted-foreground text-xs">
                    No GitHub App installations found for <strong className="text-foreground">{status.app?.name}</strong>.
                  </p>
                  <p className="text-[11px] text-muted-foreground/80">
                    Click &ldquo;Install GitHub App&rdquo; to authorize repositories in your GitHub account or organization.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {installations.map((inst) => (
                    <div
                      key={inst.installation_id}
                      className="p-3 rounded-xl bg-muted/30 border border-border/60 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="p-2 rounded-lg bg-muted text-muted-foreground shrink-0 border border-border/50">
                          {inst.account_type === 'Organization' ? (
                            <Building className="w-4 h-4 text-blue-400" />
                          ) : (
                            <User className="w-4 h-4 text-primary" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-foreground truncate text-xs flex items-center gap-1.5">
                            <span className="truncate">{inst.account_login}</span>
                            <span className="text-[10px] font-normal text-muted-foreground">({inst.account_type})</span>
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate font-mono">
                            Installation ID: {inst.installation_id} • Scope: {inst.repository_selection}
                          </p>
                        </div>
                      </div>

                      {/* Status Badges */}
                      <div className="shrink-0 flex items-center gap-1.5">
                        {inst.installation_status === 'active' && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            Active
                          </span>
                        )}
                        {inst.installation_status === 'suspended' && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            Suspended
                          </span>
                        )}
                        {inst.installation_status === 'not_allowlisted' && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20" title="Account ID not in GITHUB_ALLOWED_ACCOUNT_IDS">
                            Not Allowlisted
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
};
