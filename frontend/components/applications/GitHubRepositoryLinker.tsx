"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  FolderGit2,
  GitBranch,
  ShieldCheck,
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
  Lock,
  ExternalLink,
  RefreshCw,
  Building,
  User,
  Trash2,
  Unlink,
  Check,
  Globe,
  Sliders,
  AlertTriangle,
  Info,
  ChevronDown
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../ui/Card';
import { GitApplication } from '../../types/application';

interface RepositoryAssociation {
  applicationId: string;
  installationId: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  associationStatus: string;
  accountLogin: string;
  installationStatus: string;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface GitHubInstallation {
  installation_id: string;
  account_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  installation_status: string;
  is_allowlisted: boolean;
  suspended: boolean;
}

interface DiscoveredRepository {
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  repository_full_name: string;
  repository_private: boolean;
  installation_id: string;
  html_url: string;
}

interface GitHubRepositoryLinkerProps {
  application: GitApplication;
  onShowToast: (text: string, type?: 'success' | 'error') => void;
}

export const GitHubRepositoryLinker: React.FC<GitHubRepositoryLinkerProps> = ({
  application,
  onShowToast
}) => {
  const [association, setAssociation] = useState<RepositoryAssociation | null>(null);
  const [loadingAssociation, setLoadingAssociation] = useState(true);

  // App & Installation status
  const [isAppConfigured, setIsAppConfigured] = useState<boolean | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loadingInstallations, setLoadingInstallations] = useState(false);

  // Linking form state
  const [selectedInstallationId, setSelectedInstallationId] = useState<string>('');
  const [repositories, setRepositories] = useState<DiscoveredRepository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string>('');
  const [isLinking, setIsLinking] = useState(false);
  const [linkingError, setLinkingError] = useState<string | null>(null);

  // Unlink confirmation modal state
  const [showUnlinkModal, setShowUnlinkModal] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);

  // 1. Fetch current association for this application
  const fetchAssociation = useCallback(async () => {
    setLoadingAssociation(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}/github-repository`);
      if (res.status === 404) {
        setAssociation(null);
        return;
      }
      if (res.ok) {
        const json = await res.json();
        setAssociation(json.data || null);
      }
    } catch {
      setAssociation(null);
    } finally {
      setLoadingAssociation(false);
    }
  }, [application.id]);

  // 2. Fetch GitHub App Status & Allowlisted Installations
  const fetchGitHubStatusAndInstallations = useCallback(async () => {
    setLoadingInstallations(true);
    try {
      const statusRes = await fetch('/api/github/status');
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setIsAppConfigured(statusData.configured);

        if (statusData.configured) {
          const instRes = await fetch('/api/github/installations');
          if (instRes.ok) {
            const instData = await instRes.json();
            const allInsts: GitHubInstallation[] = Array.isArray(instData.data) ? instData.data : [];
            // Filter strictly to allowlisted and active installations
            const eligible = allInsts.filter((i) => i.is_allowlisted && i.installation_status === 'active');
            setInstallations(eligible);
            if (eligible.length > 0 && !selectedInstallationId) {
              setSelectedInstallationId(eligible[0].installation_id);
            }
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to load GitHub status', err);
    } finally {
      setLoadingInstallations(false);
    }
  }, [selectedInstallationId]);

  useEffect(() => {
    fetchAssociation();
  }, [fetchAssociation]);

  useEffect(() => {
    fetchGitHubStatusAndInstallations();
  }, [fetchGitHubStatusAndInstallations]);

  // 3. When an installation is selected, fetch accessible repositories
  useEffect(() => {
    if (!selectedInstallationId) return;

    let isMounted = true;
    const fetchRepos = async () => {
      setLoadingRepos(true);
      setLinkingError(null);
      try {
        const res = await fetch(`/api/github/installations/${encodeURIComponent(selectedInstallationId)}/repositories?limit=100`);
        if (!res.ok) {
          setRepositories([]);
          return;
        }
        const json = await res.json();
        if (isMounted) {
          const repoList: DiscoveredRepository[] = Array.isArray(json.data) ? json.data : [];
          setRepositories(repoList);

          // Auto-select repository if full_name matches application.repo_url
          const matching = repoList.find((r) =>
            application.repo_url.toLowerCase().includes(r.repository_full_name.toLowerCase())
          );
          if (matching) {
            setSelectedRepoId(matching.repository_id);
          } else if (repoList.length > 0) {
            setSelectedRepoId(repoList[0].repository_id);
          }
        }
      } catch {
        if (isMounted) setRepositories([]);
      } finally {
        if (isMounted) setLoadingRepos(false);
      }
    };

    fetchRepos();
    return () => {
      isMounted = false;
    };
  }, [selectedInstallationId, application.repo_url]);

  // Handle Linking Submission
  const handleLinkRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkingError(null);

    if (!selectedInstallationId || !selectedRepoId) {
      setLinkingError('Please select both a verified installation and an authorized repository.');
      return;
    }

    setIsLinking(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}/github-repository`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installation_id: selectedInstallationId,
          repository_id: selectedRepoId
        })
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Your session has expired. Please refresh and log in again.');
        }
        throw new Error(json.error?.message || 'Failed to link GitHub repository.');
      }

      setAssociation(json.data);
      onShowToast(`Repository "${json.data.repositoryFullName}" linked successfully!`);
    } catch (err: any) {
      setLinkingError(err.message || 'An error occurred while linking repository.');
      onShowToast(err.message || 'Linking failed', 'error');
    } finally {
      setIsLinking(false);
    }
  };

  // Handle Unlinking
  const handleUnlink = async () => {
    setIsUnlinking(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}/github-repository`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error?.message || 'Failed to unlink repository.');
      }

      setAssociation(null);
      setShowUnlinkModal(false);
      onShowToast('GitHub repository association removed.');
    } catch (err: any) {
      onShowToast(err.message || 'Unlink failed', 'error');
    } finally {
      setIsUnlinking(false);
    }
  };

  return (
    <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm overflow-hidden">
      <CardHeader className="border-b border-border/40 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">GitHub Repository Authorization</CardTitle>
              <CardDescription className="text-xs">
                Link this application to a verified GitHub App installation for private repository checkouts.
              </CardDescription>
            </div>
          </div>

          {loadingAssociation ? (
            <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : association ? (
            <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              <span>Verified & Linked</span>
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-muted text-muted-foreground border border-border/80">
              Unlinked (Public Clone Only)
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-5 space-y-4 text-xs">
        {loadingAssociation ? (
          <div className="p-8 text-center text-muted-foreground space-y-2">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto text-primary" />
            <p className="text-xs font-medium">Checking repository association status...</p>
          </div>
        ) : association ? (
          /* State E: Active Verified Association */
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-muted/30 border border-border/60 space-y-3">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="font-semibold text-sm text-foreground block truncate">
                      {association.repositoryFullName}
                    </span>
                    <span className="text-[11px] text-muted-foreground font-mono">
                      Repo ID: {association.repositoryId} • Account: {association.accountLogin}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${association.repositoryPrivate ? 'bg-purple-500/10 text-purple-300 border border-purple-500/20' : 'bg-blue-500/10 text-blue-300 border border-blue-500/20'}`}>
                    {association.repositoryPrivate ? 'Private Repository' : 'Public Repository'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowUnlinkModal(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
                  >
                    <Unlink className="w-3.5 h-3.5" />
                    <span>Unlink</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
                <div>
                  <span className="text-muted-foreground/80 block">Verified Organization</span>
                  <span className="font-medium text-foreground">{association.accountLogin} (Installation: {association.installationId})</span>
                </div>
                <div>
                  <span className="text-muted-foreground/80 block">Last Verified</span>
                  <span className="font-mono text-foreground">{new Date(association.verifiedAt).toLocaleString()}</span>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-primary shrink-0" />
              <span>Private checkout authorization is active. The deployment engine can clone this private repository using short-lived tokens.</span>
            </p>
          </div>
        ) : isAppConfigured === false ? (
          /* State A: GitHub App Not Configured */
          <div className="p-4 rounded-xl border border-border/80 bg-muted/30 text-muted-foreground space-y-2.5">
            <div className="flex items-center gap-2 text-foreground font-semibold">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              <span>GitHub App Is Not Configured on Server</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              To link private repositories, configure <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">GITHUB_APP_ID</code> and <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">GITHUB_APP_PRIVATE_KEY_PATH</code> in your backend environment.
            </p>
            <Link
              href="/applications"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-input text-xs font-medium text-foreground hover:bg-muted transition-colors"
            >
              <span>Go to Git Applications Panel</span>
              <ExternalLink className="w-3 h-3 opacity-60" />
            </Link>
          </div>
        ) : installations.length === 0 ? (
          /* State B: No Allowlisted Installation Available */
          <div className="p-4 rounded-xl border border-border/80 bg-muted/30 text-muted-foreground space-y-2.5">
            <div className="flex items-center gap-2 text-foreground font-semibold">
              <Building className="w-4 h-4 text-blue-400" />
              <span>No Authorized GitHub Installation Available</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              No active GitHub App installations matching <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">GITHUB_ALLOWED_ACCOUNT_IDS</code> were found.
              Please install the GitHub App on your organization or ensure your numeric account ID is allowlisted.
            </p>
            <Link
              href="/applications"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-input text-xs font-medium text-foreground hover:bg-muted transition-colors"
            >
              <span>Manage Installations</span>
              <ExternalLink className="w-3 h-3 opacity-60" />
            </Link>
          </div>
        ) : (
          /* State C & D: Link Repository Workflow */
          <form onSubmit={handleLinkRepository} className="space-y-4">
            {linkingError && (
              <div className="p-3.5 rounded-xl border border-destructive/40 bg-destructive/10 text-xs text-red-300 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 font-medium">{linkingError}</div>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1">
                  1. Select Authorized GitHub Organization / Account
                </label>
                <select
                  value={selectedInstallationId}
                  onChange={(e) => setSelectedInstallationId(e.target.value)}
                  disabled={isLinking}
                  className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground"
                >
                  {installations.map((inst) => (
                    <option key={inst.installation_id} value={inst.installation_id}>
                      {inst.account_login} ({inst.account_type}) • Installation ID: {inst.installation_id}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-foreground">
                    2. Select Authorized Repository
                  </label>
                  {loadingRepos && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin text-primary" /> Loading accessible repositories...
                    </span>
                  )}
                </div>

                {repositories.length > 0 ? (
                  <select
                    value={selectedRepoId}
                    onChange={(e) => setSelectedRepoId(e.target.value)}
                    disabled={isLinking || loadingRepos}
                    className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                  >
                    {repositories.map((repo) => (
                      <option key={repo.repository_id} value={repo.repository_id}>
                        {repo.repository_full_name} ({repo.repository_private ? 'Private' : 'Public'}) [ID: {repo.repository_id}]
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="p-3 rounded-xl bg-muted/20 border border-border/60 text-muted-foreground text-xs">
                    {loadingRepos ? 'Probing repository accessibility...' : 'No repositories accessible in this installation.'}
                  </div>
                )}
              </div>

              {/* URL Match Verification Hint */}
              <div className="p-3 rounded-xl bg-muted/30 border border-border/50 text-[11px] space-y-1">
                <span className="text-muted-foreground block font-medium">Configured Application Clone URL:</span>
                <span className="font-mono text-foreground block truncate">{application.repo_url}</span>
                <p className="text-[10px] text-muted-foreground/80 pt-0.5">
                  The selected repository must match the application repository name and organization.
                </p>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                disabled={isLinking || loadingRepos || !selectedInstallationId || !selectedRepoId}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all disabled:opacity-50 shadow-sm"
              >
                {isLinking ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Verifying with GitHub...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Verify & Link Repository</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </CardContent>

      {/* Unlink Confirmation Dialog */}
      {showUnlinkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-card border border-border/80 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-destructive/10 text-destructive border border-destructive/20 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-foreground">Unlink GitHub Repository?</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Are you sure you want to unlink <span className="font-semibold text-foreground">{association?.repositoryFullName}</span>?
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-muted/40 border border-border/50 text-[11px] text-muted-foreground space-y-1 leading-relaxed">
              <p>• Unlinking removes private checkout token authorization for this application.</p>
              <p>• Your application configuration, deployments, and Docker containers will NOT be deleted.</p>
              <p>• The GitHub App will remain installed on your GitHub account.</p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowUnlinkModal(false)}
                disabled={isUnlinking}
                className="px-3.5 py-1.5 rounded-xl border border-input text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUnlink}
                disabled={isUnlinking}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-destructive text-destructive-foreground text-xs font-semibold hover:bg-destructive/90 transition-all disabled:opacity-50"
              >
                {isUnlinking ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
                <span>Confirm Unlink</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
