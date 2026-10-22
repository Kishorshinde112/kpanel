"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  FolderGit2,
  Sliders,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Server,
  Layers,
  ChevronRight,
  ExternalLink,
  ShieldCheck,
  AlertTriangle
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../../../components/ui/Card';
import { GitApplication } from '../../../types/application';
import { ApplicationOverview } from '../../../components/applications/ApplicationOverview';
import { ApplicationSettingsForm } from '../../../components/applications/ApplicationSettingsForm';

export default function ApplicationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [application, setApplication] = useState<GitApplication | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isNotFound, setIsNotFound] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'settings'>('overview');
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  const fetchApplicationDetails = useCallback(async (isSilent = false) => {
    if (!id) return;
    if (!isSilent) setLoading(true);
    setError(null);
    setIsNotFound(false);

    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(id)}`);

      if (!res.ok) {
        if (res.status === 404) {
          setIsNotFound(true);
          return;
        }
        if (res.status === 401) {
          throw new Error('Your session has expired. Please refresh the page to sign in.');
        }
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || 'Failed to fetch application details.');
      }

      const json = await res.json();
      if (json.data) {
        setApplication(json.data);
      } else {
        setIsNotFound(true);
      }
    } catch (err: any) {
      setError(err.message || 'Cannot communicate with K-Panel API server.');
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchApplicationDetails();
  }, [fetchApplicationDetails]);

  const handleSaveSuccess = (updatedApp: GitApplication) => {
    setApplication(updatedApp);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border shadow-2xl text-xs font-medium transition-all duration-300 ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
              : 'bg-red-950/90 border-red-500/50 text-red-200'
          }`}
        >
          {toastMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Top Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link
          href="/applications"
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Applications</span>
        </Link>
        <ChevronRight className="w-3.5 h-3.5 opacity-40" />
        <span className="text-foreground font-mono truncate max-w-[200px]">
          {application?.slug || id}
        </span>
      </div>

      {/* Loading State */}
      {loading ? (
        <div className="flex flex-col items-center justify-center h-80 border border-border/60 rounded-2xl bg-card/40 text-muted-foreground gap-3">
          <RefreshCw className="w-7 h-7 animate-spin text-primary" />
          <span className="text-xs font-medium">Loading application profile...</span>
        </div>
      ) : isNotFound ? (
        /* 404 Not Found State */
        <Card className="border-dashed border-2 bg-card/30 p-8 sm:p-12 text-center flex flex-col items-center justify-center space-y-4">
          <div className="p-3.5 rounded-2xl bg-destructive/10 text-destructive border border-destructive/20">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <div className="max-w-md space-y-1">
            <h2 className="text-base font-semibold text-foreground">Application Not Found</h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              No registered application profile exists with ID <code className="font-mono text-foreground">{id}</code>.
              It may have been removed or the link is invalid.
            </p>
          </div>
          <Link
            href="/applications"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all shadow-sm"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Applications</span>
          </Link>
        </Card>
      ) : error ? (
        /* API / Connection Error State */
        <Card className="border-destructive/40 bg-destructive/10 p-6 sm:p-8 space-y-4 text-center">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
          <div>
            <h2 className="text-base font-bold text-foreground">Failed to Load Application</h2>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
          <button
            onClick={() => fetchApplicationDetails()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry Connection</span>
          </button>
        </Card>
      ) : application ? (
        /* Render Application Detail View */
        <div className="space-y-6">
          {/* Header Title & Status Bar */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground truncate">
                  {application.name}
                </h1>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono bg-muted text-muted-foreground border border-border/80">
                  {application.slug}
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30">
                  Configured — Not Deployed
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Managed Git Application Profile • ID: <span className="font-mono">{application.id}</span>
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => fetchApplicationDetails(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-input bg-card text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
                title="Refresh details"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Refresh</span>
              </button>

              <Link
                href="/applications"
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border border-input bg-card text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>All Applications</span>
              </Link>
            </div>
          </div>

          {/* Sub-Navigation Tabs: Overview vs Configuration */}
          <div className="flex items-center space-x-2 border-b border-border/60 pb-3">
            <button
              onClick={() => setActiveTab('overview')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                activeTab === 'overview'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <FolderGit2 className="w-4 h-4" />
              <span>Overview & Specifications</span>
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                activeTab === 'settings'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <Sliders className="w-4 h-4" />
              <span>Configuration & Settings</span>
            </button>
          </div>

          {/* Active Tab View */}
          {activeTab === 'overview' ? (
            <ApplicationOverview application={application} onShowToast={showToast} />
          ) : (
            <ApplicationSettingsForm
              application={application}
              onSaveSuccess={handleSaveSuccess}
              onShowToast={showToast}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
