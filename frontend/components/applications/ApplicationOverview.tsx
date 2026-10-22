"use client";

import React, { useState } from 'react';
import {
  FolderGit2,
  GitBranch,
  Globe,
  Server,
  FileCode,
  Cpu,
  Activity,
  Clock,
  Copy,
  Check,
  ShieldCheck,
  AlertCircle,
  Box,
  Layers,
  Lock,
  ExternalLink,
  Info
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../ui/Card';
import { GitApplication } from '../../types/application';

interface ApplicationOverviewProps {
  application: GitApplication;
  onShowToast: (text: string, type?: 'success' | 'error') => void;
}

export const ApplicationOverview: React.FC<ApplicationOverviewProps> = ({
  application,
  onShowToast
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    onShowToast('Copied to clipboard');
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* 1. Quick Stats Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tracked Branch */}
        <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Tracked Branch</CardDescription>
            <CardTitle className="text-lg font-bold text-foreground flex items-center gap-2 truncate">
              <GitBranch className="w-4 h-4 text-primary shrink-0" />
              <span className="truncate font-mono text-sm">{application.branch}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-[11px] text-muted-foreground">
            Target branch for automated deployments
          </CardContent>
        </Card>

        {/* Build Strategy */}
        <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Build Strategy</CardDescription>
            <CardTitle className="text-lg font-bold text-foreground flex items-center gap-2 truncate capitalize">
              <FileCode className="w-4 h-4 text-blue-400 shrink-0" />
              <span className="truncate text-sm">{application.build_type}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-[11px] text-muted-foreground truncate">
            Context: <code className="font-mono text-foreground">{application.build_path}</code>
          </CardContent>
        </Card>

        {/* Port & Routing */}
        <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Internal Routing</CardDescription>
            <CardTitle className="text-lg font-bold text-foreground flex items-center gap-2 truncate">
              <Server className="w-4 h-4 text-purple-400 shrink-0" />
              <span className="font-mono text-sm">Port {application.port}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-[11px] text-muted-foreground truncate">
            {application.domain ? (
              <span className="text-emerald-400 flex items-center gap-1 truncate">
                <Globe className="w-3 h-3 shrink-0" /> {application.domain}
              </span>
            ) : (
              'No custom domain bound'
            )}
          </CardContent>
        </Card>

        {/* Resource Quota */}
        <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Cgroups Quota</CardDescription>
            <CardTitle className="text-lg font-bold text-foreground flex items-center gap-2 truncate">
              <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-sm">{application.cpu_limit} Cores</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-[11px] text-muted-foreground">
            {application.memory_limit_mb} MB RAM Allocation
          </CardContent>
        </Card>
      </div>

      {/* 2. Repository & Technical Specification Details */}
      <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Repository Specification</CardTitle>
              <CardDescription className="text-xs">
                Permanent registration metadata stored in K-Panel SQLite persistence.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-5 space-y-4 text-xs">
          {/* Repository Clone URL */}
          <div className="space-y-1.5">
            <label className="text-muted-foreground font-medium text-[11px] block">
              Git Repository Clone URL
            </label>
            <div className="p-3 rounded-xl bg-muted/40 border border-border/60 flex items-center justify-between gap-3 font-mono text-[11px]">
              <span className="truncate text-foreground select-all" title={application.repo_url}>
                {application.repo_url}
              </span>
              <button
                onClick={() => handleCopy(application.repo_url, 'repo_url')}
                className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Copy URL"
              >
                {copiedKey === 'repo_url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Details 2-Column Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="p-3 rounded-xl bg-muted/30 border border-border/50 space-y-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold block">
                Application UUID
              </span>
              <div className="flex items-center justify-between font-mono text-[11px] text-foreground">
                <span className="truncate" title={application.id}>{application.id}</span>
                <button
                  onClick={() => handleCopy(application.id, 'id')}
                  className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copiedKey === 'id' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/50 space-y-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold block">
                Permanent System Slug
              </span>
              <div className="font-mono text-[11px] text-foreground flex items-center justify-between">
                <span>{application.slug}</span>
                <span className="text-[10px] font-sans text-muted-foreground flex items-center gap-1">
                  <Lock className="w-3 h-3 opacity-60" /> Immutable
                </span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/50 space-y-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold block">
                Registered On
              </span>
              <div className="text-[11px] text-foreground flex items-center gap-1.5 font-mono">
                <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span>{new Date(application.created_at).toLocaleString()}</span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/50 space-y-1">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold block">
                Last Configuration Update
              </span>
              <div className="text-[11px] text-foreground flex items-center gap-1.5 font-mono">
                <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span>{new Date(application.updated_at).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Future Deployment Engine Notice */}
      <Card className="bg-card/70 border-border/80 shadow-sm backdrop-blur-sm">
        <CardHeader className="border-b border-border/40 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold">Deployment Engine Status</CardTitle>
                <CardDescription className="text-xs">
                  Execution queue, container BuildKit builds, and Traefik router status.
                </CardDescription>
              </div>
            </div>
            <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30">
              Engine Pending (Phase 3)
            </span>
          </div>
        </CardHeader>

        <CardContent className="pt-5 space-y-4 text-xs">
          <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 text-amber-200/90 leading-relaxed space-y-1.5">
            <div className="font-semibold text-amber-300 flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0" />
              <span>Deployment automation is not configured yet.</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              This repository profile is persistently saved in SQLite. Automated BuildKit containerization, shallow commit checkout,
              zero-downtime Blue-Green traffic switching, and health-check verifiers will execute when the background deployment worker
              is activated in Phase 3. No live containers or mock deployments have been created.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
            <div className="p-3 rounded-xl bg-muted/30 border border-border/40 space-y-1">
              <span className="text-[10px] text-muted-foreground block font-medium">SQLite Profile Status</span>
              <span className="font-semibold text-emerald-400 flex items-center gap-1.5 text-xs">
                <Check className="w-3.5 h-3.5" /> Valid & Persisted
              </span>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/40 space-y-1">
              <span className="text-[10px] text-muted-foreground block font-medium">Target Architecture</span>
              <span className="font-mono text-xs text-foreground">linux/arm64 (Oracle A1)</span>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/40 space-y-1">
              <span className="text-[10px] text-muted-foreground block font-medium">Active Deployment</span>
              <span className="text-muted-foreground text-xs font-mono">None (Configured Only)</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
