"use client";

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { 
  Globe, Plus, Trash2, RefreshCw, Cloud, CloudOff, 
  Server, Search, CheckCircle2, AlertCircle, ExternalLink, ShieldCheck, X,
  Radio, Network, Edit2, Lock, Zap, ShieldAlert, Sliders, ToggleLeft, ToggleRight
} from 'lucide-react';

interface Zone {
  id: string;
  name: string;
  status: string;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

interface TunnelRoute {
  hostname: string;
  service: string;
  path: string;
}

interface TunnelInfo {
  id: string;
  name: string;
  status: string;
  connectionsCount: number;
}

interface ZoneSettings {
  ssl: string;
  development_mode: boolean;
  always_use_https: boolean;
  security_level: string;
  automatic_https_rewrites: boolean;
}

const DEFAULT_VPS_IP = "161.118.188.35";

export default function DomainsPage() {
  const [activeTab, setActiveTab] = useState<'dns' | 'settings' | 'tunnel'>('dns');
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [loadingZones, setLoadingZones] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Zone Settings State
  const [settings, setSettings] = useState<ZoneSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSetting, setSavingSetting] = useState<string | null>(null);
  const [purgingCache, setPurgingCache] = useState(false);

  // Tunnel State
  const [tunnelInfo, setTunnelInfo] = useState<TunnelInfo | null>(null);
  const [tunnelRoutes, setTunnelRoutes] = useState<TunnelRoute[]>([]);
  const [loadingTunnel, setLoadingTunnel] = useState(false);
  const [showAddTunnelModal, setShowAddTunnelModal] = useState(false);
  const [tunnelHostname, setTunnelHostname] = useState('');
  const [tunnelService, setTunnelService] = useState('http://localhost:');

  // Add DNS Record Form State
  const [showAddModal, setShowAddModal] = useState(false);
  const [formType, setFormType] = useState('A');
  const [formName, setFormName] = useState('');
  const [formContent, setFormContent] = useState(DEFAULT_VPS_IP);
  const [formProxied, setFormProxied] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Edit DNS Record State
  const [editingRecord, setEditingRecord] = useState<DnsRecord | null>(null);
  const [editFormType, setEditFormType] = useState('A');
  const [editFormName, setEditFormName] = useState('');
  const [editFormContent, setEditFormContent] = useState('');
  const [editFormProxied, setEditFormProxied] = useState(true);
  const [editFormTtl, setEditFormTtl] = useState(1);
  const [isEditing, setIsEditing] = useState(false);

  // 1. Fetch Zones & Tunnel on mount
  useEffect(() => {
    fetchZones();
    fetchTunnelData();
  }, []);

  // 2. Fetch Records & Settings when selectedZone changes
  useEffect(() => {
    if (selectedZone) {
      fetchRecords(selectedZone.id);
      fetchZoneSettings(selectedZone.id);
    }
  }, [selectedZone]);

  const showToast = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const fetchZones = async () => {
    setLoadingZones(true);
    try {
      const res = await fetch('/api/cloudflare/zones');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setZones(data);
      if (data.length > 0) {
        const defaultZone = data.find((z: Zone) => z.name === 'kishorlab.dev') || data[0];
        setSelectedZone(defaultZone);
      }
    } catch (err: any) {
      showToast('error', `Failed to load Cloudflare zones: ${err.message}`);
    } finally {
      setLoadingZones(false);
    }
  };

  const fetchRecords = async (zoneId: string) => {
    setLoadingRecords(true);
    try {
      const res = await fetch(`/api/cloudflare/records?zoneId=${zoneId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRecords(data);
    } catch (err: any) {
      showToast('error', `Failed to fetch DNS records: ${err.message}`);
    } finally {
      setLoadingRecords(false);
    }
  };

  const fetchZoneSettings = async (zoneId: string) => {
    setLoadingSettings(true);
    try {
      const res = await fetch(`/api/cloudflare/settings/${zoneId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setSettings(data.settings);
      }
    } catch (err: any) {
      console.error('Failed to fetch settings:', err);
    } finally {
      setLoadingSettings(false);
    }
  };

  const updateZoneSetting = async (settingKey: string, value: any) => {
    if (!selectedZone) return;
    setSavingSetting(settingKey);
    try {
      const res = await fetch(`/api/cloudflare/settings/${selectedZone.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setting: settingKey, value })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || 'Failed to update setting');
      }

      setSettings(prev => prev ? { ...prev, [settingKey]: value } : null);
      showToast('success', `Cloudflare setting '${settingKey}' updated successfully!`);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setSavingSetting(null);
    }
  };

  const handlePurgeCache = async () => {
    if (!selectedZone) return;
    if (!confirm(`Purge entire Cloudflare edge cache for ${selectedZone.name}?`)) return;

    setPurgingCache(true);
    try {
      const res = await fetch(`/api/cloudflare/purge-cache/${selectedZone.id}`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || 'Failed to purge cache');
      }

      showToast('success', `⚡ Cache purged successfully for ${selectedZone.name}!`);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setPurgingCache(false);
    }
  };

  const fetchTunnelData = async () => {
    setLoadingTunnel(true);
    try {
      const res = await fetch('/api/cloudflare/tunnel/routes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setTunnelInfo(data.tunnel);
        setTunnelRoutes(data.routes);
      }
    } catch (err: any) {
      showToast('error', `Failed to load Cloudflare Tunnel: ${err.message}`);
    } finally {
      setLoadingTunnel(false);
    }
  };

  const handleAddRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedZone || !formName || !formContent) return;

    setIsSubmitting(true);
    try {
      const formattedName = formName.includes('.') ? formName : `${formName}.${selectedZone.name}`;
      const res = await fetch('/api/cloudflare/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zoneId: selectedZone.id,
          type: formType,
          name: formattedName,
          content: formContent,
          proxied: formProxied
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || data.error || 'Failed to create record');
      }

      showToast('success', `DNS Record '${formattedName}' created successfully!`);
      setShowAddModal(false);
      setFormName('');
      setFormContent(DEFAULT_VPS_IP);
      setFormProxied(true);
      fetchRecords(selectedZone.id);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (rec: DnsRecord) => {
    setEditingRecord(rec);
    setEditFormType(rec.type);
    setEditFormName(rec.name);
    setEditFormContent(rec.content);
    setEditFormProxied(rec.proxied);
    setEditFormTtl(rec.ttl);
  };

  const handleUpdateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedZone || !editingRecord) return;

    setIsEditing(true);
    try {
      const res = await fetch(`/api/cloudflare/records/${selectedZone.id}/${editingRecord.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: editFormType,
          name: editFormName,
          content: editFormContent,
          proxied: editFormProxied,
          ttl: editFormTtl
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || 'Failed to update record');
      }

      showToast('success', `DNS Record '${editFormName}' updated successfully!`);
      setEditingRecord(null);
      fetchRecords(selectedZone.id);
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setIsEditing(false);
    }
  };

  const handleDeleteRecord = async (recordId: string, recordName: string) => {
    if (!selectedZone) return;
    if (!confirm(`Are you sure you want to delete DNS record '${recordName}'?`)) return;

    setDeletingId(recordId);
    try {
      const res = await fetch(`/api/cloudflare/records/${selectedZone.id}/${recordId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || 'Failed to delete record');
      }

      showToast('success', `Record '${recordName}' deleted successfully.`);
      setRecords(prev => prev.filter(r => r.id !== recordId));
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddTunnelRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tunnelHostname || !tunnelService) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/cloudflare/tunnel/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostname: tunnelHostname.trim(),
          service: tunnelService.trim()
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || 'Failed to add tunnel route');
      }

      showToast('success', `Published Application '${tunnelHostname}' added to Tunnel!`);
      setShowAddTunnelModal(false);
      setTunnelHostname('');
      setTunnelService('http://localhost:');
      fetchTunnelData();
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteTunnelRoute = async (hostname: string) => {
    if (!confirm(`Remove '${hostname}' from Cloudflare Tunnel published ingress?`)) return;

    setDeletingId(hostname);
    try {
      const res = await fetch('/api/cloudflare/tunnel/routes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || 'Failed to remove route');
      }

      showToast('success', `Removed '${hostname}' from Tunnel.`);
      setTunnelRoutes(prev => prev.filter(r => r.hostname !== hostname));
    } catch (err: any) {
      showToast('error', err.message);
    } finally {
      setDeletingId(null);
    }
  };

  // Filtered records
  const filteredRecords = records.filter(r => {
    const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          r.content.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = typeFilter === 'ALL' || r.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const filteredTunnelRoutes = tunnelRoutes.filter(r => 
    r.hostname.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.service.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const proxiedCount = records.filter(r => r.proxied).length;
  const vpsPointedCount = records.filter(r => r.content === DEFAULT_VPS_IP).length;

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {notification && (
        <div className={`fixed top-5 right-5 z-50 flex items-center p-4 rounded-xl shadow-lg border text-sm transition-all duration-300 ${
          notification.type === 'success' 
            ? 'bg-emerald-950/90 text-emerald-200 border-emerald-800' 
            : 'bg-rose-950/90 text-rose-200 border-rose-800'
        }`}>
          {notification.type === 'success' ? <CheckCircle2 className="w-5 h-5 mr-3 text-emerald-400" /> : <AlertCircle className="w-5 h-5 mr-3 text-rose-400" />}
          <span>{notification.message}</span>
        </div>
      )}

      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Globe className="w-8 h-8 text-primary" />
            Cloudflare DNS, Settings & Tunnels
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage DNS records, SSL/TLS, edge caching, development mode, and Zero Trust Tunnels.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {activeTab !== 'tunnel' && (
            <select 
              className="h-10 px-3 rounded-lg border border-input bg-background font-medium text-sm focus:ring-2 focus:ring-primary focus:outline-none"
              value={selectedZone?.id || ''}
              onChange={(e) => {
                const zone = zones.find(z => z.id === e.target.value);
                if (zone) setSelectedZone(zone);
              }}
              disabled={loadingZones}
            >
              {zones.map(z => (
                <option key={z.id} value={z.id}>
                  {z.name} ({z.status})
                </option>
              ))}
            </select>
          )}

          <button 
            onClick={() => {
              if (activeTab === 'dns') selectedZone && fetchRecords(selectedZone.id);
              else if (activeTab === 'settings') selectedZone && fetchZoneSettings(selectedZone.id);
              else fetchTunnelData();
            }}
            disabled={loadingRecords || loadingTunnel || loadingSettings}
            className="p-2.5 rounded-lg border border-input bg-background hover:bg-accent transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${(loadingRecords || loadingTunnel || loadingSettings) ? 'animate-spin' : ''}`} />
          </button>

          {activeTab === 'dns' && (
            <button 
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center justify-center rounded-lg text-sm font-semibold transition-all bg-primary text-primary-foreground hover:bg-primary/90 shadow-md hover:shadow-primary/20 h-10 px-4"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add DNS Record
            </button>
          )}

          {activeTab === 'tunnel' && (
            <button 
              onClick={() => setShowAddTunnelModal(true)}
              className="inline-flex items-center justify-center rounded-lg text-sm font-semibold transition-all bg-emerald-600 text-white hover:bg-emerald-700 shadow-md h-10 px-4"
            >
              <Plus className="w-4 h-4 mr-2" />
              Publish App to Tunnel
            </button>
          )}
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
        <button
          onClick={() => setActiveTab('dns')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            activeTab === 'dns'
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <Globe className="w-4 h-4" />
          DNS Records ({records.length})
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            activeTab === 'settings'
              ? 'bg-amber-500 text-black shadow-sm'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <Sliders className="w-4 h-4" />
          Zone Settings & SSL ({selectedZone?.name})
        </button>

        <button
          onClick={() => setActiveTab('tunnel')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            activeTab === 'tunnel'
              ? 'bg-emerald-600 text-white shadow-sm'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <Network className="w-4 h-4" />
          Zero Trust Tunnel Apps ({tunnelRoutes.length})
          {tunnelInfo?.status === 'healthy' && (
            <span className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse ml-1" />
          )}
        </button>
      </div>

      {/* TAB 1: STANDARD DNS RECORDS */}
      {activeTab === 'dns' && (
        <>
          {/* Quick Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-4 flex items-center justify-between border border-border/60 bg-card/50 backdrop-blur">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total DNS Records</p>
                <p className="text-2xl font-bold mt-1">{loadingRecords ? '...' : records.length}</p>
              </div>
              <div className="p-3 bg-primary/10 rounded-xl text-primary">
                <Globe className="w-5 h-5" />
              </div>
            </Card>

            <Card className="p-4 flex items-center justify-between border border-border/60 bg-card/50 backdrop-blur">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Proxied via Cloudflare</p>
                <p className="text-2xl font-bold mt-1 text-amber-500">{loadingRecords ? '...' : proxiedCount}</p>
              </div>
              <div className="p-3 bg-amber-500/10 rounded-xl text-amber-500">
                <Cloud className="w-5 h-5" />
              </div>
            </Card>

            <Card className="p-4 flex items-center justify-between border border-border/60 bg-card/50 backdrop-blur">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pointed to This VPS</p>
                <p className="text-2xl font-bold mt-1 text-emerald-500">{loadingRecords ? '...' : vpsPointedCount}</p>
              </div>
              <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-500">
                <Server className="w-5 h-5" />
              </div>
            </Card>
          </div>

          {/* DNS Records Table */}
          <Card className="border border-border/60 shadow-sm">
            <CardHeader className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4">
              <div>
                <CardTitle className="text-xl flex items-center gap-2">
                  <span>{selectedZone?.name || 'Domain'}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                    Active Zone
                  </span>
                </CardTitle>
                <CardDescription className="mt-1">
                  Click the pencil icon to edit any DNS record or change proxy/IP.
                </CardDescription>
              </div>

              <div className="flex items-center gap-3 w-full sm:w-auto">
                <div className="relative flex-1 sm:w-64">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input 
                    type="text" 
                    placeholder="Search subdomain or IP..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 h-9 rounded-lg border border-input bg-background/50 text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </div>

                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="h-9 px-3 rounded-lg border border-input bg-background/50 text-sm font-medium focus:ring-2 focus:ring-primary focus:outline-none"
                >
                  <option value="ALL">All Types</option>
                  <option value="A">A</option>
                  <option value="CNAME">CNAME</option>
                  <option value="TXT">TXT</option>
                  <option value="MX">MX</option>
                </select>
              </div>
            </CardHeader>

            <CardContent>
              <div className="relative w-full overflow-auto rounded-lg border border-border/40">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted/40 text-muted-foreground border-b border-border/40 font-semibold text-xs uppercase tracking-wider">
                    <tr>
                      <th className="py-3 px-4">Type</th>
                      <th className="py-3 px-4">Name / Subdomain</th>
                      <th className="py-3 px-4">Target Content / IP</th>
                      <th className="py-3 px-4">Proxy Status</th>
                      <th className="py-3 px-4">TTL</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40 font-medium">
                    {loadingRecords ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-muted-foreground">
                          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-primary" />
                          Loading live DNS records...
                        </td>
                      </tr>
                    ) : filteredRecords.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-muted-foreground">
                          No DNS records matching your filter.
                        </td>
                      </tr>
                    ) : (
                      filteredRecords.map(record => (
                        <tr key={record.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-3 px-4">
                            <span className={`inline-block px-2.5 py-0.5 rounded-md text-xs font-bold ${
                              record.type === 'A' ? 'bg-blue-500/10 text-blue-500 border border-blue-500/20' :
                              record.type === 'CNAME' ? 'bg-purple-500/10 text-purple-500 border border-purple-500/20' :
                              record.type === 'TXT' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                              'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20'
                            }`}>
                              {record.type}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono font-semibold text-foreground">
                            {record.name}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
                            <span className="flex items-center gap-1.5">
                              {record.content}
                              {record.content === DEFAULT_VPS_IP && (
                                <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.2 rounded font-sans">VPS</span>
                              )}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            {record.proxied ? (
                              <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                                <Cloud className="w-3.5 h-3.5" /> Proxied
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
                                <CloudOff className="w-3.5 h-3.5" /> DNS Only
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-xs text-muted-foreground">
                            {record.ttl === 1 ? 'Auto' : `${record.ttl}s`}
                          </td>
                          <td className="py-3 px-4 text-right space-x-1">
                            <button
                              onClick={() => openEditModal(record)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title="Edit Record"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteRecord(record.id, record.name)}
                              disabled={deletingId === record.id}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                              title="Delete Record"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* TAB 2: ZONE SETTINGS & SSL */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          {/* Quick Actions Bar */}
          <Card className="border border-amber-500/20 bg-gradient-to-r from-amber-500/5 to-transparent">
            <CardHeader className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Zap className="w-5 h-5 text-amber-500" />
                  Quick Edge Operations: {selectedZone?.name}
                </CardTitle>
                <CardDescription>
                  Instant global cache purge and developer bypass controls.
                </CardDescription>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handlePurgeCache}
                  disabled={purgingCache}
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-black font-bold text-sm shadow-md transition-all disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${purgingCache ? 'animate-spin' : ''}`} />
                  {purgingCache ? 'Purging Cache...' : '⚡ Purge All Cache'}
                </button>
              </div>
            </CardHeader>
          </Card>

          {/* Settings Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* SSL / TLS Mode */}
            <Card className="border border-border/60">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Lock className="w-5 h-5 text-primary" />
                  SSL / TLS Encryption Mode
                </CardTitle>
                <CardDescription>
                  Defines how Cloudflare encrypts traffic between visitors, Cloudflare, and your origin server.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { key: 'off', label: 'Off', desc: 'No encryption. Insecure.' },
                  { key: 'flexible', label: 'Flexible', desc: 'Encrypts visitor to Cloudflare; HTTP to origin.' },
                  { key: 'full', label: 'Full (Recommended)', desc: 'End-to-end encryption with self-signed origin cert.' },
                  { key: 'strict', label: 'Full (Strict)', desc: 'Strict origin CA certificate validation.' }
                ].map(opt => (
                  <label 
                    key={opt.key}
                    onClick={() => updateZoneSetting('ssl', opt.key)}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                      settings?.ssl === opt.key 
                        ? 'border-primary bg-primary/10 shadow-sm' 
                        : 'border-border/50 hover:bg-muted/40'
                    }`}
                  >
                    <input 
                      type="radio" 
                      name="ssl_mode" 
                      checked={settings?.ssl === opt.key}
                      onChange={() => {}}
                      className="mt-1"
                    />
                    <div>
                      <p className="font-semibold text-sm">{opt.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </CardContent>
            </Card>

            {/* Development Mode & HTTPS Rewrites */}
            <div className="space-y-6">
              {/* Development Mode Card */}
              <Card className="border border-border/60">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Sliders className="w-5 h-5 text-amber-500" />
                    Development Mode
                  </CardTitle>
                  <CardDescription>
                    Temporarily bypass Cloudflare edge cache for 3 hours to see live code edits instantly.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <div>
                    <span className={`inline-block px-2.5 py-1 rounded-md text-xs font-bold ${
                      settings?.development_mode 
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                        : 'bg-zinc-500/10 text-zinc-400'
                    }`}>
                      {settings?.development_mode ? '🟢 Active (Cache Bypassed)' : '⚪ Inactive (Normal Cache)'}
                    </span>
                  </div>
                  <button
                    onClick={() => updateZoneSetting('development_mode', settings?.development_mode ? 'off' : 'on')}
                    disabled={savingSetting === 'development_mode'}
                    className={`px-4 py-2 rounded-lg font-bold text-xs transition-all ${
                      settings?.development_mode 
                        ? 'bg-rose-600 text-white hover:bg-rose-700' 
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'
                    }`}
                  >
                    {settings?.development_mode ? 'Turn Off Dev Mode' : 'Enable Dev Mode'}
                  </button>
                </CardContent>
              </Card>

              {/* Always Use HTTPS Card */}
              <Card className="border border-border/60">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-500" />
                    Always Use HTTPS
                  </CardTitle>
                  <CardDescription>
                    Redirect all `http://` requests to secure `https://` automatically.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">Automatic 301 Redirect</p>
                    <p className="text-xs text-muted-foreground">Enforces secure HTTPS across entire domain</p>
                  </div>
                  <button
                    onClick={() => updateZoneSetting('always_use_https', settings?.always_use_https ? 'off' : 'on')}
                    disabled={savingSetting === 'always_use_https'}
                    className={`px-4 py-2 rounded-lg font-bold text-xs transition-all ${
                      settings?.always_use_https 
                        ? 'bg-emerald-600 text-white' 
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {settings?.always_use_https ? 'Enabled (ON)' : 'Disabled (OFF)'}
                  </button>
                </CardContent>
              </Card>

              {/* Security Level Card */}
              <Card className="border border-border/60">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <ShieldAlert className="w-5 h-5 text-purple-400" />
                    Security Level
                  </CardTitle>
                  <CardDescription>
                    Adjust threat scoring and CAPTCHA challenge sensitivity.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <select
                    value={settings?.security_level || 'medium'}
                    onChange={(e) => updateZoneSetting('security_level', e.target.value)}
                    disabled={savingSetting === 'security_level'}
                    className="h-10 px-3 rounded-lg border border-input bg-background font-medium text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                  >
                    <option value="essentially_off">Essentially Off</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium (Standard)</option>
                    <option value="high">High</option>
                    <option value="under_attack">🚨 I'm Under Attack Mode</option>
                  </select>
                  <span className="text-xs text-muted-foreground font-mono">
                    Active: {settings?.security_level}
                  </span>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: ZERO TRUST TUNNELS (PUBLISHED INGRESS APPS) */}
      {activeTab === 'tunnel' && (
        <>
          {/* Tunnel Status Card */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-4 flex items-center justify-between border border-border/60 bg-card/50 backdrop-blur">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tunnel Name</p>
                <p className="text-xl font-bold mt-1 text-foreground flex items-center gap-2">
                  {tunnelInfo?.name || 'n8n-oracle'}
                  <span className="text-[11px] px-2 py-0.5 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded-full font-medium">
                    {tunnelInfo?.status || 'healthy'}
                  </span>
                </p>
              </div>
              <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-500">
                <ShieldCheck className="w-5 h-5" />
              </div>
            </Card>

            <Card className="p-4 flex items-center justify-between border border-border/60 bg-card/50 backdrop-blur">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Published Hostnames</p>
                <p className="text-2xl font-bold mt-1 text-purple-400">{tunnelRoutes.length}</p>
              </div>
              <div className="p-3 bg-purple-500/10 rounded-xl text-purple-400">
                <Network className="w-5 h-5" />
              </div>
            </Card>

            <Card className="p-4 flex items-center justify-between border border-border/60 bg-card/50 backdrop-blur">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Active Edge Connections</p>
                <p className="text-2xl font-bold mt-1 text-blue-400">{tunnelInfo?.connectionsCount || 4}</p>
              </div>
              <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400">
                <Radio className="w-5 h-5" />
              </div>
            </Card>
          </div>

          {/* Published Applications Table */}
          <Card className="border border-border/60 shadow-sm">
            <CardHeader className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4">
              <div>
                <CardTitle className="text-xl flex items-center gap-2">
                  <span>Cloudflare Tunnel Published Applications</span>
                </CardTitle>
                <CardDescription className="mt-1">
                  Public hostnames exposed securely via Cloudflare Argo Tunnel (No open ports needed)
                </CardDescription>
              </div>

              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input 
                  type="text" 
                  placeholder="Search published hostname..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 h-9 rounded-lg border border-input bg-background/50 text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>
            </CardHeader>

            <CardContent>
              <div className="relative w-full overflow-auto rounded-lg border border-border/40">
                <table className="w-full text-sm text-left">
                  <thead className="bg-muted/40 text-muted-foreground border-b border-border/40 font-semibold text-xs uppercase tracking-wider">
                    <tr>
                      <th className="py-3 px-4">Public Hostname</th>
                      <th className="py-3 px-4">Internal Service Target</th>
                      <th className="py-3 px-4">Routing Kind</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40 font-medium">
                    {loadingTunnel ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-muted-foreground">
                          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-500" />
                          Loading published tunnel ingress routes...
                        </td>
                      </tr>
                    ) : filteredTunnelRoutes.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-muted-foreground">
                          No published tunnel routes found.
                        </td>
                      </tr>
                    ) : (
                      filteredTunnelRoutes.map((route, idx) => (
                        <tr key={idx} className="hover:bg-muted/30 transition-colors">
                          <td className="py-3 px-4 font-mono font-semibold text-foreground">
                            <a 
                              href={`https://${route.hostname}`} 
                              target="_blank" 
                              rel="noreferrer"
                              className="hover:underline text-primary flex items-center gap-1.5"
                            >
                              {route.hostname}
                              <ExternalLink className="w-3.5 h-3.5 opacity-60" />
                            </a>
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
                            <span className="px-2 py-1 rounded bg-muted/60 border border-border/50">
                              {route.service}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <ShieldCheck className="w-3.5 h-3.5" /> Zero Trust Tunnel
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => handleDeleteTunnelRoute(route.hostname)}
                              disabled={deletingId === route.hostname}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                              title="Delete Published Route"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* MODAL 1: Add DNS Record Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-5 border-b border-border/60">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <Plus className="w-5 h-5 text-primary" /> Add Cloudflare DNS Record
              </h3>
              <button 
                onClick={() => setShowAddModal(false)}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddRecord} className="p-5 space-y-4">
              <div>
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Record Type
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {['A', 'CNAME', 'TXT', 'MX'].map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setFormType(t)}
                      className={`h-9 rounded-lg font-bold text-xs transition-all ${
                        formType === t 
                          ? 'bg-primary text-primary-foreground shadow-sm' 
                          : 'border border-input bg-background hover:bg-muted text-muted-foreground'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Name / Subdomain
                </label>
                <div className="flex items-center">
                  <input
                    type="text"
                    required
                    placeholder="e.g. app, api, or @"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="flex-1 h-10 px-3 rounded-l-lg border border-input bg-background text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                  <span className="h-10 px-3 bg-muted border border-l-0 border-input rounded-r-lg text-xs text-muted-foreground flex items-center font-mono">
                    .{selectedZone?.name}
                  </span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    Target Content / IP Address
                  </label>
                  <button
                    type="button"
                    onClick={() => setFormContent(DEFAULT_VPS_IP)}
                    className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    ⚡ Use VPS IP ({DEFAULT_VPS_IP})
                  </button>
                </div>
                <input
                  type="text"
                  required
                  placeholder="e.g. 161.118.188.35"
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background font-mono text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>

              <div className="p-3 bg-muted/40 rounded-xl border border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`p-2 rounded-lg ${formProxied ? 'bg-amber-500/10 text-amber-500' : 'bg-zinc-500/10 text-zinc-400'}`}>
                    <Cloud className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Cloudflare Proxy</p>
                    <p className="text-xs text-muted-foreground">CDN, DDoS protection & Free SSL</p>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={formProxied}
                  onChange={(e) => setFormProxied(e.target.checked)}
                  className="w-5 h-5 rounded border-input text-primary focus:ring-primary cursor-pointer"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-lg border border-input text-sm font-medium hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 shadow-md transition-all disabled:opacity-50"
                >
                  {isSubmitting ? 'Adding...' : 'Save Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Edit DNS Record Modal */}
      {editingRecord && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-5 border-b border-border/60">
              <h3 className="text-lg font-bold flex items-center gap-2 text-primary">
                <Edit2 className="w-5 h-5" /> Edit DNS Record
              </h3>
              <button 
                onClick={() => setEditingRecord(null)}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateRecord} className="p-5 space-y-4">
              <div>
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Record Type
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {['A', 'CNAME', 'TXT', 'MX'].map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setEditFormType(t)}
                      className={`h-9 rounded-lg font-bold text-xs transition-all ${
                        editFormType === t 
                          ? 'bg-primary text-primary-foreground shadow-sm' 
                          : 'border border-input bg-background hover:bg-muted text-muted-foreground'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Full Name / Subdomain
                </label>
                <input
                  type="text"
                  required
                  value={editFormName}
                  onChange={(e) => setEditFormName(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background font-mono text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    Target Content / IP Address
                  </label>
                  <button
                    type="button"
                    onClick={() => setEditFormContent(DEFAULT_VPS_IP)}
                    className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    ⚡ Use VPS IP ({DEFAULT_VPS_IP})
                  </button>
                </div>
                <input
                  type="text"
                  required
                  value={editFormContent}
                  onChange={(e) => setEditFormContent(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background font-mono text-sm focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </div>

              {/* Proxy Toggle */}
              <div className="p-3 bg-muted/40 rounded-xl border border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`p-2 rounded-lg ${editFormProxied ? 'bg-amber-500/10 text-amber-500' : 'bg-zinc-500/10 text-zinc-400'}`}>
                    <Cloud className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Cloudflare Proxy</p>
                    <p className="text-xs text-muted-foreground">CDN, DDoS protection & Free SSL</p>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={editFormProxied}
                  onChange={(e) => setEditFormProxied(e.target.checked)}
                  className="w-5 h-5 rounded border-input text-primary focus:ring-primary cursor-pointer"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingRecord(null)}
                  className="px-4 py-2 rounded-lg border border-input text-sm font-medium hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isEditing}
                  className="px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 shadow-md transition-all disabled:opacity-50"
                >
                  {isEditing ? 'Updating...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Add Tunnel Route Modal */}
      {showAddTunnelModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-5 border-b border-border/60">
              <h3 className="text-lg font-bold flex items-center gap-2 text-emerald-400">
                <ShieldCheck className="w-5 h-5" /> Publish Application to Tunnel
              </h3>
              <button 
                onClick={() => setShowAddTunnelModal(false)}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddTunnelRoute} className="p-5 space-y-4">
              <div>
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Public Hostname (FQDN)
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. myapp.kishorlab.dev"
                  value={tunnelHostname}
                  onChange={(e) => setTunnelHostname(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background font-mono text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-1.5">
                  Local Service Endpoint
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. http://localhost:8080 or http://127.0.0.1:3000"
                  value={tunnelService}
                  onChange={(e) => setTunnelService(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background font-mono text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Local container/port on the VPS to expose securely through the tunnel.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddTunnelModal(false)}
                  className="px-4 py-2 rounded-lg border border-input text-sm font-medium hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-700 shadow-md transition-all disabled:opacity-50"
                >
                  {isSubmitting ? 'Publishing...' : 'Publish to Tunnel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}