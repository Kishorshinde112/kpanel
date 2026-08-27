"use client";

import React, { useState } from 'react';
import { Globe, Shield, Activity, Clock, CheckCircle2, AlertTriangle, XCircle, RefreshCw, X, ArrowRight, ExternalLink } from 'lucide-react';

interface WebsiteAnalyzerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ScanResult {
  success: boolean;
  domain: string;
  statusCode: number;
  ttfbMs: number;
  score: number;
  error?: string;
  ssl: {
    valid: boolean;
    issuer: string;
    subject?: string;
    daysRemaining: number;
    protocol: string;
  };
  security: {
    hsts: boolean;
    contentTypeOptions: boolean;
    frameOptions: boolean;
    csp: boolean;
    poweredBy?: string | null;
    server?: string;
    cloudflare?: boolean;
  };
  dns?: {
    ips: string[];
    mx: string[];
  };
  scannedAt: string;
}

const POPULAR_DOMAINS = [
  'kpanel.kishorlab.dev',
  'kishorlab.dev',
  'wordpress.kishorlab.dev',
  'n8n.kishorlab.dev',
  'postiz.kishorlab.dev'
];

export const WebsiteAnalyzerModal: React.FC<WebsiteAnalyzerModalProps> = ({ isOpen, onClose }) => {
  const [domainInput, setDomainInput] = useState('kpanel.kishorlab.dev');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleScan = async (targetDomain?: string) => {
    const domainToScan = targetDomain || domainInput;
    if (!domainToScan) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/analyze-domain?domain=${encodeURIComponent(domainToScan)}`);
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Domain scan failed');
      }

      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Failed to scan domain');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 bg-muted/20">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Website & Domain Analyzer</h2>
              <p className="text-xs text-muted-foreground">Scan DNS, SSL certificates, TTFB latency & security headers</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Input & Quick Chips */}
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="e.g. kpanel.kishorlab.dev"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleScan()}
                className="flex-1 rounded-lg border border-input bg-background px-3.5 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              />
              <button
                onClick={() => handleScan()}
                disabled={loading || !domainInput}
                className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Activity className="w-4 h-4 mr-2" />}
                Analyze
              </button>
            </div>

            {/* Chips */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-xs text-muted-foreground mr-1">Quick Select:</span>
              {POPULAR_DOMAINS.map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    setDomainInput(d);
                    handleScan(d);
                  }}
                  className="rounded-md bg-muted/60 hover:bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 flex items-center gap-3 text-sm">
              <XCircle className="w-5 h-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Results Display */}
          {result && (
            <div className="space-y-4 animate-in fade-in-50 duration-300">
              
              {/* Score & Header Card */}
              <div className="p-4 rounded-xl border bg-gradient-to-br from-card to-muted/30 flex items-center justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold">{result.domain}</span>
                    <a
                      href={`https://${result.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                  <p className="text-xs text-muted-foreground">Scanned on {new Date(result.scannedAt).toLocaleTimeString()}</p>
                </div>

                <div className="text-right flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-2xl font-black text-primary">{result.score}/100</div>
                    <div className="text-xs text-muted-foreground">Health Score</div>
                  </div>
                  <div className={`w-3 h-12 rounded-full ${result.score >= 80 ? 'bg-green-500' : result.score >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} />
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg border bg-card/60">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" /> TTFB Latency
                  </span>
                  <p className="text-lg font-bold mt-1 text-foreground">{result.ttfbMs} ms</p>
                </div>

                <div className="p-3 rounded-lg border bg-card/60">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Shield className="w-3.5 h-3.5" /> SSL Status
                  </span>
                  <p className="text-lg font-bold mt-1 text-green-500">
                    {result.ssl?.daysRemaining > 0 ? `${result.ssl.daysRemaining} Days` : 'Expired'}
                  </p>
                </div>

                <div className="p-3 rounded-lg border bg-card/60">
                  <span className="text-xs text-muted-foreground">HTTP Status</span>
                  <p className="text-lg font-bold mt-1 text-foreground">{result.statusCode} OK</p>
                </div>

                <div className="p-3 rounded-lg border bg-card/60">
                  <span className="text-xs text-muted-foreground">Edge / CDN</span>
                  <p className="text-lg font-bold mt-1 text-foreground">
                    {result.security?.cloudflare ? 'Cloudflare' : 'Direct'}
                  </p>
                </div>
              </div>

              {/* SSL Certificate Details */}
              <div className="p-4 rounded-lg border space-y-2">
                <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-green-500" /> SSL / TLS Details
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Issuer:</span> {result.ssl?.issuer || 'Let\'s Encrypt / Cloudflare'}</div>
                  <div><span className="text-muted-foreground">Protocol:</span> {result.ssl?.protocol || 'TLS 1.3'}</div>
                </div>
              </div>

              {/* Security Headers Checklist */}
              <div className="p-4 rounded-lg border space-y-2.5">
                <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                  Security Headers Check
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    {result.security.hsts ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                    <span>Strict-Transport-Security (HSTS)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {result.security.contentTypeOptions ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                    <span>X-Content-Type-Options</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {result.security.frameOptions ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                    <span>X-Frame-Options (Clickjack)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {result.security.csp ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                    <span>Content-Security-Policy</span>
                  </div>
                </div>
              </div>

              {/* DNS Info */}
              {result.dns && (
                <div className="p-4 rounded-lg border bg-muted/10 space-y-1.5">
                  <h4 className="text-xs font-semibold text-muted-foreground">Resolved IP Addresses</h4>
                  <div className="flex flex-wrap gap-2">
                    {result.dns.ips.map((ip, i) => (
                      <span key={i} className="font-mono text-xs px-2 py-0.5 rounded bg-muted text-foreground">
                        {ip}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-3 border-t border-border/50 bg-muted/20">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
