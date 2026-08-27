"use client";

import React, { useState, useEffect, useRef } from 'react';
import { FileText, RefreshCw, X, Search, Download, Copy, Check, Terminal, Play, Square, ArrowDown } from 'lucide-react';

interface ContainerItem {
  id: string;
  name: string;
  status: string;
  image: string;
}

interface LogExplorerModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialContainerId?: string;
}

export const LogExplorerModal: React.FC<LogExplorerModalProps> = ({ isOpen, onClose, initialContainerId }) => {
  const [containers, setContainers] = useState<ContainerItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [copied, setCopied] = useState(false);
  
  const logEndRef = useRef<HTMLDivElement>(null);

  // Fetch all containers when opened
  useEffect(() => {
    if (!isOpen) return;

    const fetchContainers = async () => {
      try {
        const res = await fetch('/api/apps');
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setContainers(data);
          if (!selectedId) {
            const first = initialContainerId || data[0].id;
            setSelectedId(first);
          }
        }
      } catch (err) {
        console.error('Failed to list containers', err);
      }
    };

    fetchContainers();
  }, [isOpen, initialContainerId]);

  // Fetch logs for selected container
  const fetchLogs = async (containerId: string) => {
    if (!containerId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/apps/${containerId}/logs?tail=200`);
      const data = await res.json();
      setLogs(data.logs || 'No logs recorded yet.');
    } catch (err: any) {
      setLogs(`Error fetching logs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedId && isOpen) {
      fetchLogs(selectedId);
    }
  }, [selectedId, isOpen]);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh || !selectedId || !isOpen) return;
    const timer = setInterval(() => {
      fetchLogs(selectedId);
    }, 3000);
    return () => clearInterval(timer);
  }, [autoRefresh, selectedId, isOpen]);

  const handleCopy = () => {
    navigator.clipboard.writeText(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedId}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const filteredLogs = searchFilter
    ? logs.split('\n').filter(line => line.toLowerCase().includes(searchFilter.toLowerCase())).join('\n')
    : logs;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl h-[85vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between px-6 py-4 border-b border-border/50 bg-muted/20 gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Container Log Explorer</h2>
              <p className="text-xs text-muted-foreground">Real-time access, error logs & diagnostic stream</p>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
            {/* Container Selector */}
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-3 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary max-w-[200px]"
            >
              {containers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status})
                </option>
              ))}
            </select>

            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between px-6 py-2.5 bg-muted/30 border-b border-border/40 gap-2">
          
          {/* Search Input */}
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search / filter logs..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors border ${autoRefresh ? 'bg-green-500/10 border-green-500/30 text-green-500' : 'bg-background border-input text-muted-foreground hover:text-foreground'}`}
            >
              {autoRefresh ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {autoRefresh ? 'Live Streaming' : 'Stream Paused'}
            </button>

            <button
              onClick={() => fetchLogs(selectedId)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>

            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>

            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Download className="w-3 h-3" />
              Export
            </button>
          </div>

        </div>

        {/* Log Viewer Area */}
        <div className="flex-1 bg-[#0d1117] p-4 overflow-auto font-mono text-xs text-gray-200 leading-relaxed select-text">
          {loading && !logs ? (
            <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-primary" />
              Loading log stream...
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all">
              {filteredLogs || 'No matching log entries found.'}
            </pre>
          )}
          <div ref={logEndRef} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-2.5 border-t border-border/50 bg-muted/20 text-xs text-muted-foreground">
          <span>Displaying last 200 lines for {selectedId || 'container'}</span>
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1 font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
