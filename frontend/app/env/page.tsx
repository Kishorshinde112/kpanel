"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  TerminalSquare,
  FileCode,
  Save,
  RotateCw,
  Plus,
  Trash2,
  Copy,
  Check,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Search,
  RefreshCw,
  Eye,
  EyeOff,
  Code,
  Table,
  Layers,
  Container as ContainerIcon,
  Download,
  FolderOpen,
  X,
  FilePlus,
  Sparkles,
  Sliders
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';

interface EnvFileItem {
  id: string;
  name: string;
  path: string;
  dir: string;
  parentDir: string;
  size: number;
  modifiedAt: string;
  variableCount: number;
  container?: {
    id: string;
    name: string;
    status: string;
  } | null;
}

interface EnvVariable {
  id: string;
  key: string;
  value: string;
  comment?: string;
  isComment?: boolean;
}

export default function EnvPage() {
  const [envFiles, setEnvFiles] = useState<EnvFileItem[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [selectedFile, setSelectedFile] = useState<EnvFileItem | null>(null);

  // Editor State
  const [editorMode, setEditorMode] = useState<'table' | 'raw'>('table');
  const [rawContent, setRawContent] = useState<string>('');
  const [originalRawContent, setOriginalRawContent] = useState<string>('');
  const [variables, setVariables] = useState<EnvVariable[]>([]);
  const [loadingContent, setLoadingContent] = useState<boolean>(false);

  // Masking & Filters
  const [maskSecrets, setMaskSecrets] = useState<boolean>(true);
  const [revealedKeys, setRevealedKeys] = useState<{ [key: string]: boolean }>({});
  const [searchVarQuery, setSearchVarQuery] = useState<string>('');
  const [searchFileQuery, setSearchFileQuery] = useState<string>('');

  // Saving / Restarting
  const [saving, setSaving] = useState<boolean>(false);
  const [savingAndRestarting, setSavingAndRestarting] = useState<boolean>(false);

  // Modals & Feedback
  const [showNewEnvModal, setShowNewEnvModal] = useState<boolean>(false);
  const [newEnvPath, setNewEnvPath] = useState<string>('/home/ubuntu/apps/');
  const [newEnvName, setNewEnvName] = useState<string>('.env');
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Convert raw text to variable items
  const parseRawToVariables = (text: string): EnvVariable[] => {
    const lines = text.split('\n');
    const result: EnvVariable[] = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('#')) {
        result.push({
          id: `comment_${idx}_${Date.now()}`,
          key: '',
          value: '',
          comment: trimmed.replace(/^#\s*/, ''),
          isComment: true,
        });
        return;
      }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        result.push({
          id: `var_${idx}_${Date.now()}`,
          key,
          value,
          comment: '',
          isComment: false,
        });
      } else {
        result.push({
          id: `var_${idx}_${Date.now()}`,
          key: trimmed,
          value: '',
          comment: '',
          isComment: false,
        });
      }
    });
    return result;
  };

  // Convert variables back to raw text
  const parseVariablesToRaw = (vars: EnvVariable[]): string => {
    return vars
      .map((v) => {
        if (v.isComment) {
          return `# ${v.comment || ''}`;
        }
        if (!v.key && !v.value) return '';
        const needsQuotes = v.value.includes(' ') || v.value.includes('#') || v.value.includes('\n');
        const formattedVal = needsQuotes ? `"${v.value}"` : v.value;
        const commentPart = v.comment ? ` # ${v.comment}` : '';
        return `${v.key}=${formattedVal}${commentPart}`;
      })
      .filter(Boolean)
      .join('\n');
  };

  // Fetch list of env files
  const fetchEnvList = useCallback(async (autoSelectFirst = false) => {
    setLoadingList(true);
    try {
      const res = await fetch('/api/env/list');
      if (!res.ok) throw new Error('Failed to load environment files');
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setEnvFiles(list);

      if (list.length > 0 && (autoSelectFirst || !selectedFile)) {
        loadEnvContent(list[0]);
      }
    } catch (err: any) {
      showToast(err.message || 'Error fetching env list', 'error');
    } finally {
      setLoadingList(false);
    }
  }, [selectedFile]);

  useEffect(() => {
    fetchEnvList(true);
  }, []);

  // Load selected .env file content
  const loadEnvContent = async (file: EnvFileItem) => {
    setSelectedFile(file);
    setLoadingContent(true);
    try {
      const res = await fetch(`/api/env/content?path=${encodeURIComponent(file.path)}`);
      if (!res.ok) throw new Error('Failed to read env file content');
      const data = await res.json();
      const text = data.content || '';
      setRawContent(text);
      setOriginalRawContent(text);
      setVariables(parseRawToVariables(text));
    } catch (err: any) {
      showToast(err.message || 'Could not open .env file', 'error');
    } finally {
      setLoadingContent(false);
    }
  };

  // Handle Mode Switch
  const switchMode = (mode: 'table' | 'raw') => {
    if (mode === 'raw') {
      // Sync table state into raw string
      const newRaw = parseVariablesToRaw(variables);
      setRawContent(newRaw);
    } else {
      // Sync raw string into table items
      const newVars = parseRawToVariables(rawContent);
      setVariables(newVars);
    }
    setEditorMode(mode);
  };

  // Update a single variable in Table mode
  const updateVariable = (id: string, field: 'key' | 'value' | 'comment', val: string) => {
    setVariables((prev) =>
      prev.map((v) => (v.id === id ? { ...v, [field]: val } : v))
    );
  };

  // Add a new variable row in Table mode
  const addVariableRow = () => {
    const newVar: EnvVariable = {
      id: `new_${Date.now()}`,
      key: 'NEW_VARIABLE_KEY',
      value: '',
      comment: '',
      isComment: false,
    };
    setVariables((prev) => [newVar, ...prev]);
  };

  // Delete variable row
  const deleteVariableRow = (id: string) => {
    setVariables((prev) => prev.filter((v) => v.id !== id));
  };

  // Save changes
  const handleSave = async (andRestart = false) => {
    if (!selectedFile) return;

    if (andRestart) setSavingAndRestarting(true);
    else setSaving(true);

    const contentToSave = editorMode === 'raw' ? rawContent : parseVariablesToRaw(variables);

    try {
      const body: any = {
        path: selectedFile.path,
        content: contentToSave,
      };

      if (andRestart && selectedFile.container?.id) {
        body.restartContainerId = selectedFile.container.id;
      }

      const res = await fetch('/api/env/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to save environment variables');
      }

      setOriginalRawContent(contentToSave);
      setRawContent(contentToSave);
      setVariables(parseRawToVariables(contentToSave));

      showToast(data.message || (andRestart ? 'Saved & container restarted!' : 'Variables saved successfully!'));
      fetchEnvList(false);
    } catch (err: any) {
      showToast(err.message || 'Error saving .env file', 'error');
    } finally {
      setSaving(false);
      setSavingAndRestarting(false);
    }
  };

  // Create New .env file
  const handleCreateNewEnv = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const targetPath = `${newEnvPath.replace(/\/$/, '')}/${newEnvName.trim()}`;
      const res = await fetch('/api/env/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: targetPath,
          content: `# Environment configuration\nPORT=3000\nNODE_ENV=production\n`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create .env file');

      showToast(`Created new .env file at ${targetPath}`);
      setShowNewEnvModal(false);
      fetchEnvList(true);
    } catch (err: any) {
      showToast(err.message || 'Creation error', 'error');
    }
  };

  const isDirty = useMemo(() => {
    if (editorMode === 'raw') {
      return rawContent !== originalRawContent;
    }
    const currentSerialized = parseVariablesToRaw(variables);
    return currentSerialized !== originalRawContent;
  }, [editorMode, rawContent, originalRawContent, variables]);

  const filteredFiles = envFiles.filter((f) => {
    if (!searchFileQuery.trim()) return true;
    const q = searchFileQuery.toLowerCase();
    return (
      f.name.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q) ||
      f.parentDir.toLowerCase().includes(q) ||
      f.container?.name.toLowerCase().includes(q)
    );
  });

  const filteredVariables = variables.filter((v) => {
    if (!searchVarQuery.trim()) return true;
    const q = searchVarQuery.toLowerCase();
    return (
      v.key.toLowerCase().includes(q) ||
      v.value.toLowerCase().includes(q) ||
      (v.comment && v.comment.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border shadow-xl text-sm transition-all duration-300 ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
              : 'bg-red-950/90 border-red-500/50 text-red-200'
          }`}
        >
          {toastMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Environment Variables</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Inspect, edit, and hot-reload <code className="font-mono text-primary">.env</code> configurations across Docker stacks.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewEnvModal(true)}
            className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-3.5 py-2 text-xs font-medium transition-colors shadow-sm"
          >
            <FilePlus className="w-3.5 h-3.5 mr-1.5" />
            New .env File
          </button>

          <button
            onClick={() => fetchEnvList(false)}
            disabled={loadingList}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
            title="Scan for .env files"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loadingList ? 'animate-spin text-primary' : ''}`} />
            Rescan
          </button>
        </div>
      </div>

      {/* Main Workspace Layout (Sidebar + Editor Area) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* ========================================================================= */}
        {/* LEFT SIDEBAR: DETECTED .ENV FILES */}
        {/* ========================================================================= */}
        <div className="lg:col-span-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Detected Files ({envFiles.length})
            </span>
          </div>

          {/* Search files */}
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by project or path..."
              value={searchFileQuery}
              onChange={(e) => setSearchFileQuery(e.target.value)}
              className="h-8.5 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            />
          </div>

          {/* File list */}
          <div className="space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto pr-1">
            {loadingList && envFiles.length === 0 ? (
              <div className="p-8 text-center border rounded-xl bg-card/40 text-muted-foreground text-xs">
                <RefreshCw className="w-5 h-5 animate-spin text-primary mx-auto mb-2" />
                Scanning filesystem for .env files...
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="p-6 text-center border border-dashed rounded-xl bg-card/20 text-muted-foreground text-xs">
                No matching .env files found.
              </div>
            ) : (
              filteredFiles.map((file) => {
                const isSelected = selectedFile?.path === file.path;
                return (
                  <div
                    key={file.path}
                    onClick={() => loadEnvContent(file)}
                    className={`p-3 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-primary/10 border-primary/50 text-foreground shadow-sm'
                        : 'bg-card/70 border-border/70 hover:bg-card hover:border-border text-muted-foreground'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        <TerminalSquare className={`w-4 h-4 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        <span className="font-semibold text-xs truncate text-foreground">
                          {file.parentDir} / {file.name}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground shrink-0">
                        {file.variableCount} vars
                      </span>
                    </div>

                    <div className="text-[11px] font-mono text-muted-foreground truncate mt-1.5" title={file.path}>
                      {file.path}
                    </div>

                    {file.container && (
                      <div className="flex items-center gap-1.5 mt-2 text-[10px]">
                        <ContainerIcon className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400 font-mono">
                          Linked: {file.container.name} ({file.container.status})
                        </span>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ========================================================================= */}
        {/* RIGHT AREA: .ENV EDITOR (DUAL-MODE) */}
        {/* ========================================================================= */}
        <div className="lg:col-span-8">
          {selectedFile ? (
            <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden flex flex-col min-h-[600px]">
              {/* Editor Header */}
              <div className="p-4 border-b border-border bg-muted/20 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-foreground truncate">
                      {selectedFile.name}
                    </h2>
                    {isDirty && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        Unsaved Changes
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                    {selectedFile.path}
                  </p>
                </div>

                {/* Mode Switcher & Global Mask Toggle */}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setMaskSecrets(!maskSecrets)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-input bg-card text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title={maskSecrets ? 'Reveal Secrets' : 'Mask Secrets'}
                  >
                    {maskSecrets ? <EyeOff className="w-3.5 h-3.5 text-amber-400" /> : <Eye className="w-3.5 h-3.5 text-emerald-400" />}
                    {maskSecrets ? 'Hidden' : 'Visible'}
                  </button>

                  <div className="flex items-center rounded-lg border border-input bg-card p-0.5 text-xs">
                    <button
                      onClick={() => switchMode('table')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors font-medium ${
                        editorMode === 'table' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Table className="w-3.5 h-3.5" />
                      Table
                    </button>
                    <button
                      onClick={() => switchMode('raw')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors font-medium ${
                        editorMode === 'raw' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Code className="w-3.5 h-3.5" />
                      Raw .env
                    </button>
                  </div>
                </div>
              </div>

              {/* Sub-toolbar (Search variables & Add row) */}
              <div className="px-4 py-2.5 border-b border-border/40 bg-muted/10 flex items-center justify-between gap-3">
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Search keys or values..."
                    value={searchVarQuery}
                    onChange={(e) => setSearchVarQuery(e.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  />
                </div>

                <div className="flex items-center gap-2">
                  {editorMode === 'table' && (
                    <button
                      onClick={addVariableRow}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Variable
                    </button>
                  )}

                  <button
                    onClick={() => {
                      const text = editorMode === 'raw' ? rawContent : parseVariablesToRaw(variables);
                      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = selectedFile.name;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="p-1.5 rounded-lg border border-input bg-card text-muted-foreground hover:text-foreground transition-colors"
                    title="Download .env"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Main Editor Body */}
              <div className="flex-1 p-4 overflow-y-auto">
                {loadingContent ? (
                  <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
                    <RefreshCw className="w-5 h-5 animate-spin text-primary" />
                    <span className="text-xs">Reading environment variables...</span>
                  </div>
                ) : editorMode === 'table' ? (
                  /* ========================================================================= */
                  /* TABLE KEY-VALUE EDITOR */
                  /* ========================================================================= */
                  <div className="space-y-2">
                    {filteredVariables.length === 0 ? (
                      <div className="text-center py-12 border border-dashed rounded-xl text-muted-foreground text-xs">
                        No variables found. Click "Add Variable" above to add one.
                      </div>
                    ) : (
                      filteredVariables.map((v) => {
                        if (v.isComment) {
                          return (
                            <div key={v.id} className="p-2 rounded-lg bg-muted/40 font-mono text-xs text-muted-foreground flex items-center gap-2">
                              <span className="text-primary font-bold">#</span>
                              <input
                                type="text"
                                value={v.comment || ''}
                                onChange={(e) => updateVariable(v.id, 'comment', e.target.value)}
                                className="flex-1 bg-transparent focus:outline-none italic text-muted-foreground"
                                placeholder="Comment text..."
                              />
                              <button
                                onClick={() => deleteVariableRow(v.id)}
                                className="p-1 text-muted-foreground hover:text-red-400"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          );
                        }

                        const isKeyRevealed = !maskSecrets || revealedKeys[v.id];

                        return (
                          <div
                            key={v.id}
                            className="p-2.5 rounded-lg border border-border/70 bg-card/90 hover:border-primary/40 transition-colors flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
                          >
                            {/* Key Column */}
                            <div className="sm:w-1/3 min-w-[160px]">
                              <input
                                type="text"
                                value={v.key}
                                onChange={(e) => updateVariable(v.id, 'key', e.target.value.toUpperCase().replace(/\s+/g, '_'))}
                                placeholder="KEY_NAME"
                                className="w-full h-8 px-2.5 rounded-md border border-input bg-background font-mono text-xs font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary uppercase"
                              />
                            </div>

                            {/* Value Column */}
                            <div className="flex-1 flex items-center gap-1 min-w-0">
                              <input
                                type={isKeyRevealed ? 'text' : 'password'}
                                value={v.value}
                                onChange={(e) => updateVariable(v.id, 'value', e.target.value)}
                                placeholder="variable_value"
                                className="w-full h-8 px-2.5 rounded-md border border-input bg-background font-mono text-xs text-emerald-300 focus:outline-none focus:ring-1 focus:ring-primary"
                              />

                              <button
                                type="button"
                                onClick={() =>
                                  setRevealedKeys((prev) => ({ ...prev, [v.id]: !prev[v.id] }))
                                }
                                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                                title={isKeyRevealed ? 'Hide Value' : 'Show Value'}
                              >
                                {isKeyRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            </div>

                            {/* Row Actions */}
                            <div className="flex items-center justify-end gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(v.value);
                                  setCopiedKey(v.id);
                                  showToast(`Copied ${v.key} value`);
                                  setTimeout(() => setCopiedKey(null), 2000);
                                }}
                                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                                title="Copy Value"
                              >
                                {copiedKey === v.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>

                              <button
                                type="button"
                                onClick={() => deleteVariableRow(v.id)}
                                className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-950/20"
                                title="Remove Variable"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  /* ========================================================================= */
                  /* RAW TEXT CODE EDITOR */
                  /* ========================================================================= */
                  <div className="h-full min-h-[420px] rounded-lg border border-border/80 bg-[#0d1117] p-3 font-mono text-xs">
                    <textarea
                      value={rawContent}
                      onChange={(e) => setRawContent(e.target.value)}
                      spellCheck={false}
                      placeholder="# Define your KEY=VALUE variables here"
                      className="w-full h-full min-h-[400px] bg-transparent text-gray-200 resize-none focus:outline-none leading-relaxed selection:bg-primary/30"
                    />
                  </div>
                )}
              </div>

              {/* Editor Footer Actions */}
              <div className="p-4 border-t border-border bg-muted/20 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground font-mono">
                  <span>
                    {editorMode === 'table' ? `${variables.length} defined entries` : `${rawContent.split('\n').length} lines`}
                  </span>
                  {selectedFile.container && (
                    <span className="ml-3 text-emerald-400">
                      Target: {selectedFile.container.name} ({selectedFile.container.id})
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 justify-end">
                  <button
                    onClick={() => handleSave(false)}
                    disabled={saving || savingAndRestarting}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-input bg-card text-foreground hover:bg-muted text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Save className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
                    {saving ? 'Saving...' : 'Save File'}
                  </button>

                  <button
                    onClick={() => handleSave(true)}
                    disabled={saving || savingAndRestarting}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${savingAndRestarting ? 'animate-spin' : ''}`} />
                    {savingAndRestarting ? 'Saving & Restarting...' : 'Save & Restart Stack'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="border border-dashed rounded-xl h-[500px] flex flex-col items-center justify-center text-muted-foreground p-8 text-center space-y-3">
              <TerminalSquare className="w-12 h-12 text-muted-foreground/30" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">No Environment File Selected</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Select a configuration from the sidebar or create a new .env file.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* NEW .ENV FILE MODAL */}
      {/* ========================================================================= */}
      {showNewEnvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <FilePlus className="w-5 h-5 text-primary" />
                <h3 className="text-lg font-semibold text-foreground">Create .env File</h3>
              </div>
              <button
                onClick={() => setShowNewEnvModal(false)}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateNewEnv} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Target Directory
                </label>
                <input
                  type="text"
                  value={newEnvPath}
                  onChange={(e) => setNewEnvPath(e.target.value)}
                  placeholder="/home/ubuntu/apps/my-app"
                  required
                  className="w-full h-9 rounded-lg border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  File Name
                </label>
                <input
                  type="text"
                  value={newEnvName}
                  onChange={(e) => setNewEnvName(e.target.value)}
                  placeholder=".env"
                  required
                  className="w-full h-9 rounded-lg border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewEnvModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-input text-xs font-medium text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
                >
                  Create & Open
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
