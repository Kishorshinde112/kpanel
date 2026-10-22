"use client";

import React, { useState } from 'react';
import {
  X,
  GitBranch,
  FolderGit2,
  Server,
  Globe,
  Cpu,
  Layers,
  RefreshCw,
  AlertCircle,
  HelpCircle,
  Sliders,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Box
} from 'lucide-react';
import { GitApplication, BuildType, CreateApplicationInput } from '../../types/application';

interface CreateGitApplicationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (app: GitApplication) => void;
}

export const CreateGitApplicationModal: React.FC<CreateGitApplicationModalProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
  // Form fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [buildType, setBuildType] = useState<BuildType>('dockerfile');
  const [buildPath, setBuildPath] = useState('/');
  const [port, setPort] = useState<number | string>(3000);
  const [domain, setDomain] = useState('');
  const [cpuLimit, setCpuLimit] = useState<number | string>(1.0);
  const [memoryLimitMb, setMemoryLimitMb] = useState<number | string>(1024);

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const resetForm = () => {
    setName('');
    setSlug('');
    setRepoUrl('');
    setBranch('main');
    setBuildType('dockerfile');
    setBuildPath('/');
    setPort(3000);
    setDomain('');
    setCpuLimit(1.0);
    setMemoryLimitMb(1024);
    setShowAdvanced(false);
    setErrorMessage(null);
  };

  const handleClose = () => {
    if (!isSubmitting) {
      resetForm();
      onClose();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

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

    // Reject embedded credentials
    if (/^[a-zA-Z]+:\/\/[^@/\s]+@/.test(trimmedRepoUrl) || /:([^@/\s]+)@/.test(trimmedRepoUrl)) {
      setErrorMessage('Repository URL must not contain embedded passwords or access tokens.');
      return;
    }

    // Reject local paths
    if (/^(file:\/\/|\/|\.\/|\.\.\/|[a-zA-Z]:\\)/i.test(trimmedRepoUrl)) {
      setErrorMessage('Local file repository paths are not permitted.');
      return;
    }

    // Port validation
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setErrorMessage('Container port must be an integer between 1 and 65535.');
      return;
    }

    // Build path validation
    const trimmedBuildPath = buildPath.trim() || '/';
    if (trimmedBuildPath.includes('..')) {
      setErrorMessage('Build path cannot contain directory traversal references ("..").');
      return;
    }

    // CPU limit validation
    const parsedCpu = Number(cpuLimit);
    if (isNaN(parsedCpu) || parsedCpu < 0.1 || parsedCpu > 32.0) {
      setErrorMessage('CPU limit must be between 0.1 and 32.0 cores.');
      return;
    }

    // Memory limit validation
    const parsedMemory = Number(memoryLimitMb);
    if (!Number.isInteger(parsedMemory) || parsedMemory < 64 || parsedMemory > 65536) {
      setErrorMessage('Memory limit must be between 64 MB and 65536 MB.');
      return;
    }

    // Domain validation
    const trimmedDomain = domain.trim();
    if (trimmedDomain && (trimmedDomain.includes('://') || trimmedDomain.includes('/') || trimmedDomain.includes(':'))) {
      setErrorMessage('Domain must be a bare hostname without http://, port, or path.');
      return;
    }

    // 2. Build payload matching backend API requirements exactly
    const payload: CreateApplicationInput = {
      name: trimmedName,
      repo_url: trimmedRepoUrl,
      branch: branch.trim() || 'main',
      build_type: buildType,
      build_path: trimmedBuildPath.startsWith('/') ? trimmedBuildPath : `/${trimmedBuildPath}`,
      port: parsedPort,
      cpu_limit: parsedCpu,
      memory_limit_mb: parsedMemory
    };

    if (slug.trim()) {
      payload.slug = slug.trim().toLowerCase();
    }

    if (trimmedDomain) {
      payload.domain = trimmedDomain.toLowerCase();
    }

    // 3. Dispatch POST request
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseData = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Your session has expired. Please refresh and log in again.');
        }
        if (res.status === 409) {
          throw new Error(responseData.error?.message || 'Application slug is already in use. Please specify a unique slug.');
        }
        throw new Error(responseData.error?.message || 'Failed to register application.');
      }

      // Success (HTTP 201)
      const createdApp: GitApplication = responseData.data;
      resetForm();
      onSuccess(createdApp);
      onClose();
    } catch (err: any) {
      // Preserve form values on error
      setErrorMessage(err.message || 'An unexpected error occurred while communicating with the server.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-border/80 bg-card shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/60 bg-muted/20">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-primary/10 border border-primary/20 text-primary">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Register Git Application
              </h2>
              <p className="text-xs text-muted-foreground">
                Configure a Git repository and runtime specifications for K-Panel
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Informational Notice */}
          <div className="p-3.5 rounded-xl border border-blue-500/20 bg-blue-500/5 text-xs text-blue-200 flex items-start gap-2.5">
            <Box className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              <span className="font-semibold text-blue-300">Configuration Ledger</span>
              <p className="text-[11px] text-blue-200/80 mt-0.5">
                Registering stores the repository profile in SQLite. Automated BuildKit deployments will execute in Phase 3.
              </p>
            </div>
          </div>

          {/* Error Banner */}
          {errorMessage && (
            <div className="p-3.5 rounded-xl border border-destructive/40 bg-destructive/10 text-xs text-red-300 flex items-start gap-2.5 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{errorMessage}</div>
            </div>
          )}

          {/* Primary Required Fields */}
          <div className="space-y-4">
            <div>
              <label htmlFor="app-name" className="text-xs font-semibold text-foreground block mb-1">
                Application Name <span className="text-red-400">*</span>
              </label>
              <input
                id="app-name"
                type="text"
                required
                placeholder="e.g. My Portfolio Website"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSubmitting}
                className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div>
              <label htmlFor="repo-url" className="text-xs font-semibold text-foreground block mb-1">
                Git Repository URL <span className="text-red-400">*</span>
              </label>
              <input
                id="repo-url"
                type="text"
                required
                placeholder="https://github.com/organization/repository.git"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                disabled={isSubmitting}
                className="w-full px-3.5 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground placeholder:text-muted-foreground font-mono text-[11px]"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Public HTTPS or SSH Git clone URL. Never embed tokens or credentials directly in the URL.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="branch" className="text-xs font-semibold text-foreground block mb-1">
                  Tracked Branch
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
                    <GitBranch className="w-3.5 h-3.5" />
                  </div>
                  <input
                    id="branch"
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={isSubmitting}
                    placeholder="main"
                    className="w-full pl-8 pr-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="build-type" className="text-xs font-semibold text-foreground block mb-1">
                  Build Strategy
                </label>
                <select
                  id="build-type"
                  value={buildType}
                  onChange={(e) => setBuildType(e.target.value as BuildType)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground"
                >
                  <option value="dockerfile">Custom Dockerfile</option>
                  <option value="railpack">Railpack Buildpack</option>
                  <option value="compose">Docker Compose Stack</option>
                </select>
              </div>
            </div>
          </div>

          {/* Collapsible Advanced Settings */}
          <div className="pt-2 border-t border-border/50">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center justify-between w-full text-xs font-semibold text-muted-foreground hover:text-foreground py-1 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-primary" />
                <span>Advanced Configuration (Domain, Port, Cgroups)</span>
              </span>
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvanced && (
              <div className="space-y-4 pt-4 animate-in fade-in duration-200">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="slug" className="text-xs font-semibold text-foreground block mb-1">
                      Custom Slug (Optional)
                    </label>
                    <input
                      id="slug"
                      type="text"
                      placeholder="auto-derived-from-name"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono text-[11px]"
                    />
                  </div>

                  <div>
                    <label htmlFor="build-path" className="text-xs font-semibold text-foreground block mb-1">
                      Build Root Path
                    </label>
                    <input
                      id="build-path"
                      type="text"
                      placeholder="/"
                      value={buildPath}
                      onChange={(e) => setBuildPath(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono text-[11px]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="port" className="text-xs font-semibold text-foreground block mb-1">
                      Internal Container Port
                    </label>
                    <input
                      id="port"
                      type="number"
                      min={1}
                      max={65535}
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                    />
                  </div>

                  <div>
                    <label htmlFor="domain" className="text-xs font-semibold text-foreground block mb-1">
                      Custom Hostname / Domain
                    </label>
                    <input
                      id="domain"
                      type="text"
                      placeholder="e.g. app.kishorlab.dev"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="cpu-limit" className="text-xs font-semibold text-foreground block mb-1">
                      CPU Cores Limit
                    </label>
                    <input
                      id="cpu-limit"
                      type="number"
                      step="0.1"
                      min={0.1}
                      max={32.0}
                      value={cpuLimit}
                      onChange={(e) => setCpuLimit(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                    />
                  </div>

                  <div>
                    <label htmlFor="memory-limit" className="text-xs font-semibold text-foreground block mb-1">
                      RAM Allocation (MB)
                    </label>
                    <input
                      id="memory-limit"
                      type="number"
                      min={64}
                      max={65536}
                      step={64}
                      value={memoryLimitMb}
                      onChange={(e) => setMemoryLimitMb(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground font-mono"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer Controls */}
          <div className="pt-4 border-t border-border/60 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl border border-input text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim() || !repoUrl.trim()}
              className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all disabled:opacity-50 shadow-sm gap-2"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving Configuration...</span>
                </>
              ) : (
                <>
                  <FolderGit2 className="w-3.5 h-3.5" />
                  <span>Register Application</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
