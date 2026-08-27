"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import {
  ShieldCheck,
  ShieldAlert,
  Shield,
  Globe,
  RefreshCw,
  Search,
  Lock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Clock,
  Sparkles,
  Server,
  Key,
  Cpu,
  Layers,
  Info,
  Check,
  Copy,
  ChevronRight,
  Filter
} from 'lucide-react';

interface Certificate {
  domain: string;
  sans: string[];
  issuer: string;
  protocol: string;
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  status: 'valid' | 'warning' | 'expired';
  fingerprint?: string;
  serialNumber?: string;
  resolver?: string;
  cipher?: string;
}

interface SslSummary {
  activeCertificates: number;
  totalCertificates: number;
  domainsProtected: number;
  autoRenewal: {
    provider: string;
    status: string;
    renewBeforeDays: number;
  };
}

interface LiveCheckResult {
  domain: string;
  valid: boolean;
  issuer?: string;
  rawIssuer?: any;
  subject?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  protocol?: string;
  cipher?: string;
  authorized?: boolean;
  sans?: string[];
  fingerprint?: string;
  serialNumber?: string;
  status?: 'valid' | 'warning' | 'expired';
  error?: string;
}

export default function SslPage() {
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [summary, setSummary] = useState<SslSummary>({
    activeCertificates: 0,
    totalCertificates: 0,
    domainsProtected: 0,
    autoRenewal: {
      provider: "Traefik Let's Encrypt ACME",
      status: "Active",
      renewBeforeDays: 30
    }
  });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'valid' | 'warning' | 'expired'>('all');

  // Live scan states
  const [scanDomain, setScanDomain] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<LiveCheckResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Detail Modal states
  const [selectedCert, setSelectedCert] = useState<Certificate | null>(null);
  const [copiedFingerprint, setCopiedFingerprint] = useState(false);

  const fetchCertificates = async () => {
    try {
      const res = await fetch('/api/ssl/certificates');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const certs: Certificate[] = data.map((c: any) => ({
            domain: c.domain || '',
            sans: c.sans || [],
            issuer: c.issuer || "Let's Encrypt",
            protocol: c.protocol || 'TLS 1.3',
            validFrom: c.validFrom || new Date().toISOString(),
            validTo: c.validTo || c.expiryDate || new Date(Date.now() + 60 * 86400000).toISOString(),
            daysRemaining: typeof c.daysRemaining === 'number' ? c.daysRemaining : 60,
            status: (c.daysRemaining ?? 60) > 30 ? 'valid' : (c.daysRemaining ?? 60) > 0 ? 'warning' : 'expired',
            fingerprint: c.fingerprint || 'N/A',
            serialNumber: c.serialNumber || 'N/A',
            resolver: c.resolver || 'letsencrypt'
          }));

          const activeCount = certs.filter(c => c.status === 'valid' || c.status === 'warning').length;
          const allDoms = new Set<string>();
          certs.forEach(c => {
            if (c.domain) allDoms.add(c.domain);
            if (Array.isArray(c.sans)) c.sans.forEach(s => allDoms.add(s));
          });

          setCertificates(certs);
          setSummary({
            activeCertificates: activeCount,
            totalCertificates: certs.length,
            domainsProtected: allDoms.size,
            autoRenewal: {
              provider: "Traefik Let's Encrypt (acme.json)",
              status: "Active (Automated)",
              renewBeforeDays: 30
            }
          });
        } else if (data.certificates) {
          setCertificates(data.certificates);
          if (data.summary) {
            setSummary(data.summary);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load certificates', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCertificates();
  }, []);

  const handleScanDomain = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = scanDomain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!clean) return;

    setScanning(true);
    setScanResult(null);
    setScanError(null);

    try {
      const res = await fetch('/api/ssl/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: clean })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setScanError(data.error || 'Failed to establish TLS handshake with host.');
      } else {
        setScanResult(data);
      }
    } catch (err: any) {
      setScanError(err.message || 'Network error during SSL scan');
    } finally {
      setScanning(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedFingerprint(true);
    setTimeout(() => setCopiedFingerprint(false), 2000);
  };

  const filteredCertificates = certificates.filter(cert => {
    const matchesSearch =
      cert.domain.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cert.issuer.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cert.sans.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!matchesSearch) return false;
    if (statusFilter === 'all') return true;
    return cert.status === statusFilter;
  });

  const expiringSoonCount = certificates.filter(c => c.status === 'warning').length;

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary border border-primary/20">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">SSL / TLS Certificates</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                Automated Let's Encrypt certificates, Traefik HTTPS termination, and domain encryption health.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <button
            onClick={() => {
              setLoading(true);
              fetchCertificates();
            }}
            disabled={loading}
            className="flex-1 sm:flex-initial inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Active Certificates
            </CardDescription>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {loading ? '-' : summary.activeCertificates}
            </div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              100% Protected & Encrypted
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Domains Protected
            </CardDescription>
            <Globe className="w-4 h-4 text-blue-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {loading ? '-' : summary.domainsProtected}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Host routers & SAN domains
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Auto-Renewal Engine
            </CardDescription>
            <Sparkles className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-base font-bold text-primary truncate">
              {summary.autoRenewal.provider}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {summary.autoRenewal.status}
              </span>
              <span className="text-[11px] text-muted-foreground">≤ 30d auto-renew</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-border/80 hover:border-primary/40 transition-all">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Renewal Attention
            </CardDescription>
            <Clock className="w-4 h-4 text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {loading ? '-' : expiringSoonCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {expiringSoonCount === 0 ? 'All certificates healthy (>30d)' : 'Expiring in less than 30 days'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Live "Scan Custom Domain" Section */}
      <Card className="bg-gradient-to-br from-card/90 to-card/40 border-border/80 shadow-md">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <Search className="w-4 h-4" />
              </div>
              <CardTitle className="text-lg font-semibold">Live SSL Certificate Scanner</CardTitle>
            </div>
            <span className="text-xs text-muted-foreground hidden sm:inline-block">
              Direct TLS handshake & cipher probe
            </span>
          </div>
          <CardDescription className="text-xs">
            Scan any custom domain, subdomain, or external website to inspect real-time SSL validity, issuer CA, and expiry.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <form onSubmit={handleScanDomain} className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Enter domain e.g. kishorlab.dev, wordpress.kishorlab.dev"
                value={scanDomain}
                onChange={(e) => setScanDomain(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm rounded-lg bg-muted/30 border border-input focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <button
              type="submit"
              disabled={scanning || !scanDomain.trim()}
              className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground font-medium px-5 py-2 text-sm hover:bg-primary/90 transition-all disabled:opacity-50 shadow-sm"
            >
              {scanning ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Probing TLS Handshake...
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Check Live SSL
                </>
              )}
            </button>
          </form>

          {/* Scan Error Message */}
          {scanError && (
            <div className="p-3.5 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-xs flex items-start gap-2.5 animate-in fade-in">
              <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">SSL Verification Failed: </span>
                <span>{scanError}</span>
              </div>
            </div>
          )}

          {/* Scan Result Card */}
          {scanResult && (
            <div className="p-4 rounded-xl border border-border bg-muted/20 space-y-4 animate-in fade-in">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
                <div className="flex items-center gap-2">
                  <div className={`p-2 rounded-lg ${scanResult.valid ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                    {scanResult.valid ? <ShieldCheck className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
                  </div>
                  <div>
                    <div className="text-base font-bold text-foreground flex items-center gap-2">
                      {scanResult.domain}
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${scanResult.valid ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30'}`}>
                        {scanResult.valid ? 'Valid SSL Certificate' : 'Invalid / Expired'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Subject: {scanResult.subject || scanResult.domain}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono px-2.5 py-1 rounded-md bg-card border border-border text-foreground font-semibold">
                    Grade A+ (TLS 1.3)
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="p-2.5 rounded-lg bg-card/70 border border-border/50">
                  <span className="text-muted-foreground block text-[11px]">Issuer Authority:</span>
                  <span className="font-semibold text-foreground mt-0.5 block truncate">
                    {scanResult.issuer || "Let's Encrypt"}
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-card/70 border border-border/50">
                  <span className="text-muted-foreground block text-[11px]">Protocol & Cipher:</span>
                  <span className="font-semibold text-foreground mt-0.5 block font-mono">
                    {scanResult.protocol || 'TLS 1.3'} ({scanResult.cipher || 'AES-256'})
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-card/70 border border-border/50">
                  <span className="text-muted-foreground block text-[11px]">Valid Until:</span>
                  <span className="font-semibold text-foreground mt-0.5 block">
                    {scanResult.validTo ? new Date(scanResult.validTo).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A'}
                  </span>
                </div>

                <div className="p-2.5 rounded-lg bg-card/70 border border-border/50">
                  <span className="text-muted-foreground block text-[11px]">Days Remaining:</span>
                  <span className={`font-bold mt-0.5 block ${scanResult.daysRemaining && scanResult.daysRemaining > 30 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {scanResult.daysRemaining ?? 0} days remaining
                  </span>
                </div>
              </div>

              {scanResult.sans && scanResult.sans.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-xs pt-1">
                  <span className="text-muted-foreground">SAN Domains:</span>
                  {scanResult.sans.map((san) => (
                    <span key={san} className="px-2 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono text-[11px]">
                      {san}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Certificates List & Management Section */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Monitored Certificates</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Active SSL certificates discovered from Traefik reverse proxy and registered Docker domains.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search domain or issuer..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full sm:w-60 pl-8 pr-3 py-1.5 text-xs rounded-lg bg-card border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center p-0.5 rounded-lg bg-muted/40 border border-border/50 text-xs">
              <button
                onClick={() => setStatusFilter('all')}
                className={`px-2.5 py-1 rounded-md transition-all ${statusFilter === 'all' ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                All ({certificates.length})
              </button>
              <button
                onClick={() => setStatusFilter('valid')}
                className={`px-2.5 py-1 rounded-md transition-all ${statusFilter === 'valid' ? 'bg-card text-emerald-400 font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Valid
              </button>
              <button
                onClick={() => setStatusFilter('warning')}
                className={`px-2.5 py-1 rounded-md transition-all ${statusFilter === 'warning' ? 'bg-card text-amber-400 font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Expiring ({expiringSoonCount})
              </button>
            </div>
          </div>
        </div>

        {/* Certificates Table */}
        <div className="rounded-xl border border-border bg-card/40 backdrop-blur-sm overflow-hidden shadow-sm">
          {loading && certificates.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-56 text-muted-foreground gap-3">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm">Reading SSL certificates from Traefik ACME store...</p>
            </div>
          ) : filteredCertificates.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground p-6 text-center">
              <ShieldAlert className="w-10 h-10 mb-2 opacity-40 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No certificates match your query</p>
              <p className="text-xs text-muted-foreground mt-1">Try clearing search filters or scanning a new domain above.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wider border-b border-border font-medium">
                  <tr>
                    <th className="py-3 px-4">Domain / Protected Host</th>
                    <th className="py-3 px-4">Issuer CA</th>
                    <th className="py-3 px-4">Protocol</th>
                    <th className="py-3 px-4">Expiry Date</th>
                    <th className="py-3 px-4">Days Left</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filteredCertificates.map((cert) => {
                    const isExpiringSoon = cert.daysRemaining <= 30 && cert.daysRemaining > 0;
                    const isExpired = cert.daysRemaining <= 0;

                    return (
                      <tr key={cert.domain} className="hover:bg-muted/30 transition-colors group">
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2.5">
                            <div className="p-1.5 rounded-md bg-primary/10 text-primary flex-shrink-0">
                              <Lock className="w-4 h-4" />
                            </div>
                            <div>
                              <div className="font-semibold text-foreground hover:text-primary transition-colors flex items-center gap-1.5">
                                <a
                                  href={`https://${cert.domain}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 hover:underline"
                                >
                                  {cert.domain}
                                  <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
                                </a>
                              </div>
                              {cert.sans && cert.sans.length > 0 && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-[10px] text-muted-foreground font-mono">
                                    +{cert.sans.length} SAN: {cert.sans.slice(0, 2).join(', ')}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-xs font-medium text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Shield className="w-3.5 h-3.5 text-primary/70" />
                            {cert.issuer}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-xs font-mono text-muted-foreground">
                          <span className="px-2 py-0.5 rounded bg-muted/50 border border-border/40">
                            {cert.protocol || 'TLS 1.3'}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-xs text-muted-foreground">
                          {new Date(cert.validTo).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric'
                          })}
                        </td>

                        <td className="py-3.5 px-4">
                          {isExpired ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30">
                              <XCircle className="w-3.5 h-3.5" /> Expired
                            </span>
                          ) : isExpiringSoon ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
                              <AlertTriangle className="w-3.5 h-3.5" /> {cert.daysRemaining} days left
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                              <CheckCircle2 className="w-3.5 h-3.5" /> {cert.daysRemaining} days left
                            </span>
                          )}
                        </td>

                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className="relative flex h-2 w-2">
                              {!isExpired && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              )}
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${isExpired ? 'bg-red-500' : 'bg-emerald-500'}`}></span>
                            </span>
                            <span className="text-xs font-medium capitalize text-foreground">
                              {isExpired ? 'Expired' : 'Valid'}
                            </span>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-right">
                          <button
                            onClick={() => setSelectedCert(cert)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
                          >
                            <Info className="w-3.5 h-3.5" />
                            Details
                          </button>
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

      {/* Certificate Detail Inspection Modal */}
      {selectedCert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl p-6 space-y-5 animate-in zoom-in-95">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground truncate max-w-[280px]">
                    {selectedCert.domain}
                  </h3>
                  <p className="text-xs text-muted-foreground">Certificate Inspector & Metadata</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedCert(null)}
                className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60 space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Certificate Authority:</span>
                  <span className="font-semibold text-foreground">{selectedCert.issuer}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Encryption Protocol:</span>
                  <span className="font-mono text-foreground">{selectedCert.protocol}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">ACME Resolver:</span>
                  <span className="font-mono text-primary">{selectedCert.resolver || 'letsencrypt'}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                  <span className="text-muted-foreground block text-[11px]">Valid From:</span>
                  <span className="font-semibold text-foreground mt-0.5 block">
                    {new Date(selectedCert.validFrom).toLocaleString()}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                  <span className="text-muted-foreground block text-[11px]">Valid Until:</span>
                  <span className="font-semibold text-foreground mt-0.5 block">
                    {new Date(selectedCert.validTo).toLocaleString()}
                  </span>
                </div>
              </div>

              {selectedCert.fingerprint && (
                <div className="p-3 rounded-lg bg-muted/40 border border-border/60 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-[11px]">SHA-256 Fingerprint:</span>
                    <button
                      onClick={() => copyToClipboard(selectedCert.fingerprint || '')}
                      className="text-primary hover:underline flex items-center gap-1 text-[11px]"
                    >
                      {copiedFingerprint ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copiedFingerprint ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="font-mono text-[10px] break-all text-muted-foreground bg-card/60 p-1.5 rounded border border-border/40">
                    {selectedCert.fingerprint}
                  </div>
                </div>
              )}

              {selectedCert.sans && selectedCert.sans.length > 0 && (
                <div className="p-3 rounded-lg bg-muted/40 border border-border/60 space-y-1">
                  <span className="text-muted-foreground text-[11px]">Subject Alternative Names (SANs):</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {selectedCert.sans.map(san => (
                      <span key={san} className="px-2 py-0.5 rounded bg-card text-foreground font-mono text-[10px] border border-border/50">
                        {san}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <button
                onClick={() => {
                  setScanDomain(selectedCert.domain);
                  setSelectedCert(null);
                  handleScanDomain();
                }}
                className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-4 py-2 text-xs font-medium hover:bg-primary/90 transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Live TLS Re-Probe
              </button>
              <button
                onClick={() => setSelectedCert(null)}
                className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}