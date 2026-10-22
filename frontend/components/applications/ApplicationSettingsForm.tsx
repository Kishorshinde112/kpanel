"use client";

import React, { useState, useEffect } from 'react';
import {
  Save,
  RotateCcw,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Lock,
  GitBranch,
  FolderGit2,
  Globe,
  Server,
  Cpu,
  Layers,
  Sliders,
  FileCode,
  Info
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../ui/Card';
import { GitApplication, BuildType } from '../../types/application';

interface ApplicationSettingsFormProps {
  application: GitApplication;
  onSaveSuccess: (updatedApp: GitApplication) => void;
  onShowToast: (text: string, type?: 'success' | 'error') => void;
}

export const ApplicationSettingsForm: React.FC<ApplicationSettingsFormProps> = ({
  application,
  onSaveSuccess,
  onShowToast
}) => {
  // Form fields initialized from current application record
  const [name, setName] = useState(application.name);
  const [repoUrl, setRepoUrl] = useState(application.repo_url);
  const [branch, setBranch] = useState(application.branch);
  const [buildType, setBuildType] = useState<BuildType>(application.build_type);
  const [buildPath, setBuildPath] = useState(application.build_path);
  const [port, setPort] = useState<number | string>(application.port);
  const [domain, setDomain] = useState(application.domain || '');
  const [cpuLimit, setCpuLimit] = useState<number | string>(application.cpu_limit);
  const [memoryLimitMb, setMemoryLimitMb] = useState<number | string>(application.memory_limit_mb);

  // Status & error states
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sync state when incoming application prop updates
  useEffect(() => {
    setName(application.name);
    setRepoUrl(application.repo_url);
    setBranch(application.branch);
    setBuildType(application.build_type);
    setBuildPath(application.build_path);
    setPort(application.port);
    setDomain(application.domain || '');
    setCpuLimit(application.cpu_limit);
    setMemoryLimitMb(application.memory_limit_mb);
    setErrorMessage(null);
  }, [application]);

  // Compute whether any supported editable value has changed
  const hasChanges =
    name.trim() !== application.name ||
    repoUrl.trim() !== application.repo_url ||
    branch.trim() !== application.branch ||
    buildType !== application.build_type ||
    buildPath.trim() !== application.build_path ||
    Number(port) !== application.port ||
    domain.trim() !== (application.domain || '') ||
    Number(cpuLimit) !== application.cpu_limit ||
    Number(memoryLimitMb) !== application.memory_limit_mb;

  // Reverts all fields back to the currently saved application record
  const handleCancel = () => {
    setName(application.name);
    setRepoUrl(application.repo_url);
    setBranch(application.branch);
    setBuildType(application.build_type);
    setBuildPath(application.build_path);
    setPort(application.port);
    setDomain(application.domain || '');
    setCpuLimit(application.cpu_limit);
    setMemoryLimitMb(application.memory_limit_mb);
    setErrorMessage(null);
    onShowToast('Changes discarded; original configuration restored.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!hasChanges) return;

    // 1. Client-side field validations
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage('Application name is required.');
      return;
    }

    const trimmedRepoUrl = repoUrl.trim();
    if (!trimmedRepoUrl) {
      setErrorMessage('Git repository URL is required.');
      return;
    }

    // Reject embedded credentials in URLs
    if (/^[a-zA-Z]+:\/\/[^@/\s]+@/.test(trimmedRepoUrl) || /:([^@/\s]+)@/.test(trimmedRepoUrl)) {
      setErrorMessage('Repository URL must not contain embedded passwords or access tokens.');
      return;
    }

    // Reject local file paths
    if (/^(file:\/\/|\/|\.\/|\.\.\/|[a-zA-Z]:\\)/i.test(trimmedRepoUrl)) {
      setErrorMessage('Local file repository schemes are not permitted.');
      return;
    }

    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setErrorMessage('Container port must be an integer between 1 and 65535.');
      return;
    }

    const trimmedBuildPath = buildPath.trim() || '/';
    if (trimmedBuildPath.includes('..')) {
      setErrorMessage('Build path cannot contain directory traversal references ("..").');
      return;
    }

    const parsedCpu = Number(cpuLimit);
    if (isNaN(parsedCpu) || parsedCpu < 0.1 || parsedCpu > 32.0) {
      setErrorMessage('CPU limit must be between 0.1 and 32.0 cores.');
      return;
    }

    const parsedMemory = Number(memoryLimitMb);
    if (!Number.isInteger(parsedMemory) || parsedMemory < 64 || parsedMemory > 65536) {
      setErrorMessage('Memory limit must be between 64 MB and 65536 MB.');
      return;
    }

    const trimmedDomain = domain.trim();
    if (trimmedDomain && (trimmedDomain.includes('://') || trimmedDomain.includes('/') || trimmedDomain.includes(':'))) {
      setErrorMessage('Domain must be a bare hostname without http://, port, or path.');
      return;
    }

    // 2. Build changes payload (sending only supported fields)
    const changes: Record<string, any> = {};
    if (trimmedName !== application.name) changes.name = trimmedName;
    if (trimmedRepoUrl !== application.repo_url) changes.repo_url = trimmedRepoUrl;
    if (branch.trim() !== application.branch) changes.branch = branch.trim();
    if (buildType !== application.build_type) changes.build_type = buildType;
    if (trimmedBuildPath !== application.build_path) {
      changes.build_path = trimmedBuildPath.startsWith('/') ? trimmedBuildPath : `/${trimmedBuildPath}`;
    }
    if (parsedPort !== application.port) changes.port = parsedPort;
    if (trimmedDomain !== (application.domain || '')) {
      // If cleared, pass empty string which the service maps to null
      changes.domain = trimmedDomain ? trimmedDomain.toLowerCase() : null;
    }
    if (parsedCpu !== application.cpu_limit) changes.cpu_limit = parsedCpu;
    if (parsedMemory !== application.memory_limit_mb) changes.memory_limit_mb = parsedMemory;

    // 3. Dispatch PUT request
    setIsSaving(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(application.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      });

      const responseData = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Your session has expired. Please refresh and log in again.');
        }
        if (res.status === 404) {
          throw new Error('This application was not found on the server.');
        }
        throw new Error(responseData.error?.message || 'Failed to update application settings.');
      }

      // Success (HTTP 200)
      const updatedApp: GitApplication = responseData.data;
      onSaveSuccess(updatedApp);
      onShowToast('Application configuration updated successfully.');
    } catch (err: any) {
      // Keep edited values in form on failure
      setErrorMessage(err.message || 'An error occurred while saving configuration.');
      onShowToast(err.message || 'Save failed', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
      <CardHeader className="border-b border-border/40 pb-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Application Configuration & Settings</CardTitle>
              <CardDescription className="text-xs">
                Update repository source, build strategy, and hardware resource limits.
              </CardDescription>
            </div>
          </div>

          {hasChanges && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/10 text-blue-300 border border-blue-500/30">
              Unsaved Changes
            </span>
          )}
        </div>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardContent className="pt-5 space-y-5 text-xs">
          {/* Error Notice */}
          {errorMessage && (
            <div className="p-3.5 rounded-xl border border-destructive/40 bg-destructive/10 text-xs text-red-300 flex items-start gap-2.5 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{errorMessage}</div>
            </div>
          )}

          {/* Section A: Application Identity */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Identity & Naming
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="edit-name" className="text-xs font-semibold text-foreground block mb-1">
                  Application Name <span className="text-red-400">*</span>
                </label>
                <input
                  id="edit-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSaving}
                  className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground"
                />
              </div>

              {/* Read-Only Permanent Slug */}
              <div>
                <label htmlFor="edit-slug" className="text-xs font-semibold text-foreground block mb-1">
                  System Slug (Read-Only)
                </label>
                <div className="relative">
                  <input
                    id="edit-slug"
                    type="text"
                    disabled
                    readOnly
                    value={application.slug}
                    className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/20 border border-input/60 text-muted-foreground font-mono cursor-not-allowed pr-8"
                  />
                  <div className="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none text-muted-foreground/60">
                    <Lock className="w-3.5 h-3.5" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground/80 mt-1">
                  Permanent system identifier. Immutable to protect future deployment routing.
                </p>
              </div>
            </div>
          </div>

          {/* Section B: Git Source & Branch */}
          <div className="space-y-4 pt-3 border-t border-border/40">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Git Source Configuration
            </h3>

            <div>
              <label htmlFor="edit-repo" className="text-xs font-semibold text-foreground block mb-1">
                Git Repository URL <span className="text-red-400">*</span>
              </label>
              <input
                id="edit-repo"
                type="text"
                required
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                disabled={isSaving}
                className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono text-[11px]"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Public HTTPS or SSH Git clone URL. Never embed tokens or credentials directly in the URL.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="edit-branch" className="text-xs font-semibold text-foreground block mb-1">
                  Target Branch <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
                    <GitBranch className="w-3.5 h-3.5" />
                  </div>
                  <input
                    id="edit-branch"
                    type="text"
                    required
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={isSaving}
                    className="w-full pl-8 pr-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="edit-build-type" className="text-xs font-semibold text-foreground block mb-1">
                  Build Strategy
                </label>
                <select
                  id="edit-build-type"
                  value={buildType}
                  onChange={(e) => setBuildType(e.target.value as BuildType)}
                  disabled={isSaving}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground"
                >
                  <option value="dockerfile">Custom Dockerfile</option>
                  <option value="railpack">Railpack Buildpack</option>
                  <option value="compose">Docker Compose Stack</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="edit-build-path" className="text-xs font-semibold text-foreground block mb-1">
                Build Root Directory (Repository Context)
              </label>
              <input
                id="edit-build-path"
                type="text"
                value={buildPath}
                onChange={(e) => setBuildPath(e.target.value)}
                disabled={isSaving}
                className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono text-[11px]"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Root path inside repository where Dockerfile or buildpack configuration resides (e.g. <code className="font-mono text-foreground">/</code>).
              </p>
            </div>
          </div>

          {/* Section C: Runtime Routing & Resources */}
          <div className="space-y-4 pt-3 border-t border-border/40">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Runtime Networking & Resource Limits
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="edit-port" className="text-xs font-semibold text-foreground block mb-1">
                  Internal Container Port <span className="text-red-400">*</span>
                </label>
                <input
                  id="edit-port"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  disabled={isSaving}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                />
              </div>

              <div>
                <label htmlFor="edit-domain" className="text-xs font-semibold text-foreground block mb-1">
                  Custom Domain Hostname (Optional)
                </label>
                <input
                  id="edit-domain"
                  type="text"
                  placeholder="e.g. app.kishorlab.dev"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  disabled={isSaving}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Leave blank to unbind custom domain routing.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="edit-cpu" className="text-xs font-semibold text-foreground block mb-1">
                  CPU Limit (Cores)
                </label>
                <input
                  id="edit-cpu"
                  type="number"
                  step="0.1"
                  min={0.1}
                  max={32.0}
                  value={cpuLimit}
                  onChange={(e) => setCpuLimit(e.target.value)}
                  disabled={isSaving}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                />
              </div>

              <div>
                <label htmlFor="edit-ram" className="text-xs font-semibold text-foreground block mb-1">
                  RAM Allocation (MB)
                </label>
                <input
                  id="edit-ram"
                  type="number"
                  min={64}
                  max={65536}
                  step={64}
                  value={memoryLimitMb}
                  onChange={(e) => setMemoryLimitMb(e.target.value)}
                  disabled={isSaving}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                />
              </div>
            </div>
          </div>
        </CardContent>

        {/* Footer Save & Discard Actions */}
        <CardFooter className="pt-3 border-t border-border/40 bg-muted/20 px-6 py-3 flex items-center justify-between">
          <button
            type="button"
            onClick={handleCancel}
            disabled={!hasChanges || isSaving}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-input text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Discard Changes</span>
          </button>

          <button
            type="submit"
            disabled={!hasChanges || isSaving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSaving ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Saving Settings...</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>Save Changes</span>
              </>
            )}
          </button>
        </CardFooter>
      </form>
    </Card>
  );
};
