"use client";

import React, { useState, useEffect } from 'react';
import { Rocket, X, Check, RefreshCw, ExternalLink, Box, Server, Database, Code, CheckCircle2, AlertCircle } from 'lucide-react';

interface Blueprint {
  id: string;
  name: string;
  category: string;
  description: string;
  defaultPort: number;
  icon: string;
}

interface DeployBlueprintModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DeployBlueprintModal: React.FC<DeployBlueprintModalProps> = ({ isOpen, onClose }) => {
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [selectedBp, setSelectedBp] = useState<Blueprint | null>(null);
  const [appName, setAppName] = useState('');
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState<number>(8096);
  const [loading, setLoading] = useState(false);
  const [deployResult, setDeployResult] = useState<{ success: boolean; url?: string; message?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const fetchBlueprints = async () => {
      try {
        const res = await fetch('/api/blueprints');
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setBlueprints(data);
          setSelectedBp(data[0]);
          setPort(data[0].defaultPort);
        }
      } catch (err) {
        console.error('Failed to load blueprints', err);
      }
    };

    fetchBlueprints();
  }, [isOpen]);

  const handleSelectBlueprint = (bp: Blueprint) => {
    setSelectedBp(bp);
    setPort(bp.defaultPort);
    setDeployResult(null);
  };

  const handleDeploy = async () => {
    if (!selectedBp || !appName.trim()) return;

    setLoading(true);
    setDeployResult(null);

    try {
      const res = await fetch('/api/blueprints/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blueprintId: selectedBp.id,
          appName: appName.trim(),
          domain: domain.trim() || `${appName.trim()}.kishorlab.dev`,
          port: Number(port)
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Deployment failed');
      }

      setDeployResult({
        success: true,
        url: data.url,
        message: data.message || 'Stack deployed successfully!'
      });
    } catch (err: any) {
      setDeployResult({
        success: false,
        error: err.message || 'Failed to deploy stack.'
      });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 bg-muted/20">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Rocket className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">1-Click App Blueprints</h2>
              <p className="text-xs text-muted-foreground">Instantly launch standardized container stacks with Traefik SSL routing</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Blueprint Selector Cards */}
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2 block">
              1. Select Application Stack
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {blueprints.map((bp) => {
                const isSelected = selectedBp?.id === bp.id;
                return (
                  <div
                    key={bp.id}
                    onClick={() => handleSelectBlueprint(bp)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-start space-x-3 ${
                      isSelected
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'border-border/60 hover:border-border hover:bg-muted/30'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                      {bp.id.includes('wordpress') ? <Box className="w-5 h-5" /> :
                       bp.id.includes('postgres') ? <Database className="w-5 h-5" /> :
                       bp.id.includes('node') ? <Code className="w-5 h-5" /> :
                       <Server className="w-5 h-5" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">{bp.name}</span>
                        {isSelected && <Check className="w-4 h-4 text-primary" />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{bp.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Configuration Form */}
          {selectedBp && (
            <div className="space-y-4 border-t border-border/50 pt-4">
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider block">
                2. Deployment Configuration
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">App Name (Slug)</label>
                  <input
                    type="text"
                    placeholder="e.g. my-awesome-app"
                    value={appName}
                    onChange={(e) => {
                      setAppName(e.target.value);
                      if (!domain || domain.endsWith('.kishorlab.dev')) {
                        setDomain(`${e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-')}.kishorlab.dev`);
                      }
                    }}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Domain Name</label>
                  <input
                    type="text"
                    placeholder="e.g. app.kishorlab.dev"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium">Internal Port</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="w-full max-w-xs rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                />
              </div>
            </div>
          )}

          {/* Deploy Feedback */}
          {deployResult && (
            <div className={`p-4 rounded-xl border ${deployResult.success ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'} flex items-start gap-3 text-sm`}>
              {deployResult.success ? <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
              <div className="space-y-1 flex-1">
                <div className="font-semibold">{deployResult.success ? 'Deployment Successful!' : 'Deployment Error'}</div>
                <p className="text-xs">{deployResult.message || deployResult.error}</p>
                {deployResult.url && (
                  <a
                    href={deployResult.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary underline font-medium mt-1"
                  >
                    Open Live App <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border/50 bg-muted/20">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDeploy}
            disabled={loading || !appName.trim()}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Rocket className="w-4 h-4 mr-2" />}
            {loading ? 'Deploying Stack...' : 'Deploy Now'}
          </button>
        </div>

      </div>
    </div>
  );
};
