"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  FolderPlus,
  FolderOpen,
  File,
  FileCode,
  FileText,
  FileArchive,
  Image as ImageIcon,
  Plus,
  Trash2,
  Edit3,
  Save,
  RefreshCw,
  Upload,
  Download,
  Search,
  Copy,
  Check,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  X,
  ExternalLink,
  Eye,
  ChevronRight,
  Home,
  Maximize2,
  Minimize2,
  Grid,
  List,
  HardDrive,
  Clock,
  ArrowUp
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isDir?: boolean;
  size: number;
  modifiedAt: string;
  modified?: string;
  extension: string;
  isHidden: boolean;
  isEditable: boolean;
  isImage: boolean;
  isArchive: boolean;
}

interface DirectoryResponse {
  currentPath: string;
  parentPath: string;
  items: FileItem[];
  error?: string;
}

const QUICK_BOOKMARKS = [
  { label: 'Home', path: '/home/ubuntu' },
  { label: 'Apps', path: '/home/ubuntu/apps' },
  { label: 'WordPress', path: '/home/ubuntu/wordpress' },
  { label: 'K-Panel', path: '/home/ubuntu/kpanel-clean' },
  { label: 'Backups', path: '/home/ubuntu/backups' },
  { label: 'System Logs', path: '/var/log' },
];

function formatBytes(bytes: number, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatDate(isoString: string) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

export default function FileManagerPage() {
  const [currentPath, setCurrentPath] = useState<string>('/home/ubuntu');
  const [parentPath, setParentPath] = useState<string>('/home');
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Search, Filters & View Mode
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [pathInput, setPathInput] = useState<string>('/home/ubuntu');
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);

  // Modals & Drawers
  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [activeFile, setActiveFile] = useState<{ path: string; name: string; content: string; originalContent: string; size: number; modifiedAt: string } | null>(null);
  const [savingFile, setSavingFile] = useState<boolean>(false);
  const [editorFullscreen, setEditorFullscreen] = useState<boolean>(false);

  const [newModalType, setNewModalType] = useState<'file' | 'folder' | null>(null);
  const [newItemName, setNewItemName] = useState<string>('');
  const [creatingItem, setCreatingItem] = useState<boolean>(false);

  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [copiedPath, setCopiedPath] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Fetch Directory
  const loadDirectory = useCallback(async (targetPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(targetPath)}`);
      const data: DirectoryResponse = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to read directory');
      }

      setCurrentPath(data.currentPath);
      setPathInput(data.currentPath);
      setParentPath(data.parentPath || '/');
      setItems(data.items || []);
    } catch (err: any) {
      setError(err.message || 'Error loading directory');
      showToast(err.message || 'Directory access error', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDirectory(currentPath);
  }, []);

  // Open file in editor
  const handleOpenFile = async (item: FileItem) => {
    const isDir = Boolean(item.isDirectory || item.isDir);
    if (isDir) {
      loadDirectory(item.path);
      return;
    }

    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(item.path)}`);
      const data = await res.json();
      if (data.isDirectory) {
        loadDirectory(data.path || item.path);
        return;
      }
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Could not load file content');
      }

      setActiveFile({
        path: data.path || item.path,
        name: data.name || item.name,
        content: data.content ?? '',
        originalContent: data.content ?? '',
        size: data.size ?? item.size,
        modifiedAt: data.modifiedAt || item.modifiedAt || item.modified || new Date().toISOString(),
      });
      setEditorOpen(true);
    } catch (err: any) {
      showToast(err.message || 'Failed to open file', 'error');
    }
  };

  // Save File content
  const handleSaveFile = async () => {
    if (!activeFile) return;
    setSavingFile(true);
    try {
      const res = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeFile.path,
          content: activeFile.content,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Save failed');
      }

      setActiveFile((prev) => (prev ? { ...prev, originalContent: prev.content, modifiedAt: data.modifiedAt, size: data.size } : null));
      showToast('File saved successfully!');
      loadDirectory(currentPath);
    } catch (err: any) {
      showToast(err.message || 'Error saving file', 'error');
    } finally {
      setSavingFile(false);
    }
  };

  // Keyboard shortcut Ctrl+S / Cmd+S in Editor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        if (editorOpen && activeFile) {
          e.preventDefault();
          handleSaveFile();
        }
      }
      if (e.key === 'Escape' && editorOpen) {
        if (activeFile && activeFile.content !== activeFile.originalContent) {
          if (confirm('You have unsaved changes. Are you sure you want to close?')) {
            setEditorOpen(false);
          }
        } else {
          setEditorOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorOpen, activeFile]);

  // Create File or Folder
  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemName.trim() || !newModalType) return;
    setCreatingItem(true);
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: currentPath,
          name: newItemName.trim(),
          type: newModalType,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed to create ${newModalType}`);
      }

      showToast(`Created ${newModalType} '${newItemName.trim()}'`);
      setNewModalType(null);
      setNewItemName('');
      loadDirectory(currentPath);

      // If created a file, open editor immediately
      if (newModalType === 'file' && data.path) {
        handleOpenFile({
          name: data.name,
          path: data.path,
          isDirectory: false,
          size: 0,
          modifiedAt: new Date().toISOString(),
          extension: data.name.split('.').pop() || '',
          isHidden: data.name.startsWith('.'),
          isEditable: true,
          isImage: false,
          isArchive: false,
        });
      }
    } catch (err: any) {
      showToast(err.message || 'Creation failed', 'error');
    } finally {
      setCreatingItem(false);
    }
  };

  // Delete File / Folder
  const handleDeleteItem = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: deleteTarget.path }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to delete');
      }

      showToast(`Deleted '${deleteTarget.name}'`);
      setDeleteTarget(null);
      loadDirectory(currentPath);
    } catch (err: any) {
      showToast(err.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  // Handle Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const isText = file.type.startsWith('text/') || file.name.match(/\.(js|ts|tsx|jsx|json|yml|yaml|md|txt|sh|py|php|css|html|env|sql)$/i);
        let content: string;
        let encoding: 'utf-8' | 'base64' = 'utf-8';

        if (isText && typeof reader.result === 'string') {
          content = reader.result;
        } else {
          // binary
          const arrayBuffer = reader.result as ArrayBuffer;
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          content = btoa(binary);
          encoding = 'base64';
        }

        const res = await fetch('/api/files/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetDir: currentPath,
            name: file.name,
            content,
            encoding,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Upload failed');
        }

        showToast(`Uploaded '${file.name}' successfully!`);
        loadDirectory(currentPath);
      } catch (err: any) {
        showToast(err.message || 'File upload error', 'error');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };

    if (file.type.startsWith('text/') || file.name.match(/\.(js|ts|tsx|jsx|json|yml|yaml|md|txt|sh|py|php|css|html|env|sql)$/i)) {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  };

  // Copy current path
  const handleCopyPath = (path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedPath(true);
    showToast('Path copied to clipboard');
    setTimeout(() => setCopiedPath(false), 2000);
  };

  // Filter Items
  const filteredItems = items.filter((item) => {
    if (!showHidden && item.isHidden) return false;
    if (searchQuery.trim()) {
      return item.name.toLowerCase().includes(searchQuery.toLowerCase());
    }
    return true;
  });

  const folderCount = items.filter((i) => Boolean(i.isDirectory || i.isDir)).length;
  const fileCount = items.filter((i) => !Boolean(i.isDirectory || i.isDir)).length;
  const totalSizeBytes = items.reduce((acc, i) => acc + (Boolean(i.isDirectory || i.isDir) ? 0 : i.size), 0);

  // Breadcrumb Segments
  const pathSegments = currentPath.split('/').filter(Boolean);

  const getFileIcon = (item: FileItem) => {
    const isDir = Boolean(item.isDirectory || item.isDir);
    if (isDir) {
      return <Folder className="w-5 h-5 text-amber-400 fill-amber-400/20" />;
    }
    if (item.isImage) {
      return <ImageIcon className="w-5 h-5 text-purple-400" />;
    }
    if (item.isArchive) {
      return <FileArchive className="w-5 h-5 text-yellow-400" />;
    }
    if (item.isEditable || item.extension === 'json' || item.extension === 'yml' || item.extension === 'env') {
      return <FileCode className="w-5 h-5 text-emerald-400" />;
    }
    return <FileText className="w-5 h-5 text-blue-400" />;
  };

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
          <h1 className="text-3xl font-bold tracking-tight">File Manager</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Browse directory structures, inspect logs, manage configs, and edit code live on your VPS.
          </p>
        </div>

        {/* Global Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors shadow-sm"
          >
            <Upload className="w-3.5 h-3.5 mr-1.5 text-primary" />
            Upload
          </button>

          <button
            onClick={() => {
              setNewItemName('');
              setNewModalType('folder');
            }}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors shadow-sm"
          >
            <FolderPlus className="w-3.5 h-3.5 mr-1.5 text-amber-400" />
            New Folder
          </button>

          <button
            onClick={() => {
              setNewItemName('');
              setNewModalType('file');
            }}
            className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-3.5 py-2 text-xs font-medium transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            New File
          </button>

          <button
            onClick={() => loadDirectory(currentPath)}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-lg border border-input bg-card p-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shadow-sm"
            title="Refresh Directory"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-primary' : ''}`} />
          </button>
        </div>
      </div>

      {/* Bookmarks Bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
        <span className="text-muted-foreground font-medium flex items-center gap-1 shrink-0">
          <HardDrive className="w-3.5 h-3.5 text-primary" /> Bookmarks:
        </span>
        {QUICK_BOOKMARKS.map((bm) => (
          <button
            key={bm.path}
            onClick={() => loadDirectory(bm.path)}
            className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors shrink-0 ${
              currentPath === bm.path
                ? 'bg-primary/15 border-primary/40 text-primary'
                : 'bg-card/60 border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {bm.label}
          </button>
        ))}
      </div>

      {/* Breadcrumb Navigation Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center flex-1 min-w-0 gap-2">
          <button
            onClick={() => loadDirectory('/home/ubuntu')}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-primary transition-colors shrink-0"
            title="Jump to /home/ubuntu"
          >
            <Home className="w-4 h-4" />
          </button>

          {currentPath !== '/' && (
            <button
              onClick={() => loadDirectory(parentPath)}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
              title="Go Up One Directory"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}

          {/* Breadcrumb segments or direct edit bar */}
          {isEditingPath ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setIsEditingPath(false);
                loadDirectory(pathInput.trim() || '/home/ubuntu');
              }}
              className="flex-1 flex items-center gap-2"
            >
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                autoFocus
                onBlur={() => setIsEditingPath(false)}
                className="w-full bg-background border border-primary px-3 py-1 text-xs rounded-md font-mono focus:outline-none"
              />
            </form>
          ) : (
            <div
              onClick={() => setIsEditingPath(true)}
              className="flex items-center flex-wrap gap-1 text-xs font-mono bg-muted/40 hover:bg-muted/70 px-3 py-1.5 rounded-lg cursor-pointer transition-colors flex-1 overflow-x-auto min-w-0"
              title="Click to edit path directly"
            >
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  loadDirectory('/');
                }}
                className="text-muted-foreground hover:text-primary transition-colors font-semibold"
              >
                /
              </span>
              {pathSegments.map((seg, idx) => {
                const segPath = '/' + pathSegments.slice(0, idx + 1).join('/');
                const isLast = idx === pathSegments.length - 1;
                return (
                  <React.Fragment key={segPath}>
                    <ChevronRight className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        loadDirectory(segPath);
                      }}
                      className={`hover:text-primary transition-colors ${
                        isLast ? 'font-semibold text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {seg}
                    </span>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>

        {/* Path action buttons */}
        <div className="flex items-center gap-1.5 shrink-0 justify-end">
          <button
            onClick={() => handleCopyPath(currentPath)}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-xs flex items-center gap-1"
            title="Copy Directory Path"
          >
            {copiedPath ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Directory Summary & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Search Input */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search current folder..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-xs shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filter Controls & Stats */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground justify-between sm:justify-end">
          <span className="hidden md:inline">
            {folderCount} folders, {fileCount} files ({formatBytes(totalSizeBytes)})
          </span>

          <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 bg-background"
            />
            <span>Show hidden (.{''})</span>
          </label>

          <div className="flex items-center rounded-lg border border-input bg-card p-0.5">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1 rounded-md transition-colors ${
                viewMode === 'list' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="List View"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded-md transition-colors ${
                viewMode === 'grid' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Grid View"
            >
              <Grid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="flex flex-col items-center justify-center h-64 border rounded-xl bg-card/40 text-muted-foreground gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          <span className="text-sm">Reading directory structure...</span>
        </div>
      ) : error ? (
        <div className="p-8 border border-red-500/30 rounded-xl bg-red-950/20 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
          <h3 className="text-base font-semibold text-red-200">Unable to access directory</h3>
          <p className="text-xs text-red-300 font-mono">{error}</p>
          <button
            onClick={() => loadDirectory('/home/ubuntu')}
            className="inline-flex items-center px-3.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium"
          >
            Return to /home/ubuntu
          </button>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-dashed rounded-xl bg-card/20 text-muted-foreground gap-3">
          <FolderOpen className="w-10 h-10 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">
              {searchQuery ? 'No matching files or folders found' : 'This folder is empty'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {searchQuery ? 'Try adjusting your search filter' : 'Create a new file or upload content to get started'}
            </p>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        /* TABLE LIST VIEW */
        <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40 border-b border-border text-muted-foreground font-medium uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4 w-28">Size</th>
                  <th className="py-3 px-4 w-32">Type</th>
                  <th className="py-3 px-4 w-44">Modified</th>
                  <th className="py-3 px-4 w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-mono text-xs">
                {filteredItems.map((item) => (
                  <tr
                    key={item.path}
                    className="hover:bg-muted/30 transition-colors group cursor-pointer"
                    onClick={() => handleOpenFile(item)}
                  >
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-3">
                        <div className="shrink-0">{getFileIcon(item)}</div>
                        <div className="truncate font-sans font-medium text-foreground group-hover:text-primary transition-colors max-w-md">
                          {item.name}
                        </div>
                        {item.isHidden && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground font-sans">
                            hidden
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground">
                      {Boolean(item.isDirectory || item.isDir) ? '—' : formatBytes(item.size)}
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground capitalize font-sans">
                      {Boolean(item.isDirectory || item.isDir)
                        ? 'Directory'
                        : item.extension
                        ? item.extension.toUpperCase()
                        : 'File'}
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground font-sans">
                      {formatDate(item.modifiedAt || item.modified || '')}
                    </td>
                    <td className="py-2.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {!Boolean(item.isDirectory || item.isDir) && (
                          <button
                            onClick={() => handleOpenFile(item)}
                            title="Edit File"
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => handleCopyPath(item.path)}
                          title="Copy Full Path"
                          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(item)}
                          title="Delete"
                          className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-950/30 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* GRID TILES VIEW */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {filteredItems.map((item) => (
            <Card
              key={item.path}
              onClick={() => handleOpenFile(item)}
              className="group cursor-pointer hover:border-primary/50 transition-all duration-150 flex flex-col justify-between p-3 bg-card/60 hover:bg-card relative"
            >
              <div className="flex items-start justify-between gap-1 mb-2">
                <div className="p-2 rounded-lg bg-muted/60 group-hover:bg-primary/10 transition-colors">
                  {getFileIcon(item)}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(item);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-950/30 transition-all"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="mt-1">
                <p className="text-xs font-medium text-foreground truncate group-hover:text-primary transition-colors" title={item.name}>
                  {item.name}
                </p>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
                  <span>{Boolean(item.isDirectory || item.isDir) ? 'Dir' : formatBytes(item.size)}</span>
                  <span>{item.extension ? item.extension.toUpperCase() : ''}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ========================================================================= */}
      {/* FILE EDITOR MODAL / DRAWER */}
      {/* ========================================================================= */}
      {editorOpen && activeFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className={`relative flex flex-col rounded-xl border border-border bg-[#0d1117] text-gray-100 shadow-2xl overflow-hidden transition-all duration-200 ${
              editorFullscreen ? 'w-full h-full rounded-none' : 'w-full max-w-5xl h-[88vh]'
            }`}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 bg-[#161b22]">
              <div className="flex items-center space-x-3 min-w-0">
                <FileCode className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate text-white">{activeFile.name}</span>
                    {activeFile.content !== activeFile.originalContent && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        Unsaved Changes
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-gray-400 truncate">{activeFile.path}</p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const blob = new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = activeFile.name;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                  title="Export / Download File"
                >
                  <Download className="w-4 h-4" />
                </button>

                <button
                  onClick={() => setEditorFullscreen(!editorFullscreen)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                  title={editorFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                >
                  {editorFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>

                <button
                  onClick={handleSaveFile}
                  disabled={savingFile}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
                  title="Save changes (Ctrl+S)"
                >
                  <Save className={`w-3.5 h-3.5 ${savingFile ? 'animate-spin' : ''}`} />
                  {savingFile ? 'Saving...' : 'Save File'}
                </button>

                <button
                  onClick={() => {
                    if (activeFile.content !== activeFile.originalContent) {
                      if (confirm('Discard unsaved changes?')) setEditorOpen(false);
                    } else {
                      setEditorOpen(false);
                    }
                  }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors ml-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Editor Body */}
            <div className="flex-1 flex flex-col min-h-0 bg-[#0d1117]">
              <textarea
                ref={editorTextareaRef}
                value={activeFile.content}
                onChange={(e) => setActiveFile({ ...activeFile, content: e.target.value })}
                spellCheck={false}
                className="w-full h-full p-4 bg-transparent font-mono text-xs text-gray-200 resize-none focus:outline-none leading-relaxed selection:bg-primary/30"
                placeholder="Empty file content..."
              />
            </div>

            {/* Editor Footer */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border/40 bg-[#161b22] text-[11px] text-gray-400 font-mono">
              <div className="flex items-center gap-4">
                <span>Lines: {activeFile.content.split('\n').length}</span>
                <span>Length: {activeFile.content.length} chars</span>
                <span>Size: {formatBytes(activeFile.size)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span>Shortcut: Ctrl + S to save</span>
                <span>•</span>
                <span>UTF-8</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* NEW FILE / FOLDER MODAL */}
      {/* ========================================================================= */}
      {newModalType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {newModalType === 'folder' ? (
                  <FolderPlus className="w-5 h-5 text-amber-400" />
                ) : (
                  <FileCode className="w-5 h-5 text-primary" />
                )}
                <h3 className="text-lg font-semibold text-foreground">
                  Create New {newModalType === 'folder' ? 'Folder' : 'File'}
                </h3>
              </div>
              <button
                onClick={() => setNewModalType(null)}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-muted-foreground">
              Will be created inside: <code className="font-mono text-foreground">{currentPath}</code>
            </p>

            <form onSubmit={handleCreateItem} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {newModalType === 'folder' ? 'Folder Name' : 'File Name (with extension, e.g. config.json)'}
                </label>
                <input
                  type="text"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  placeholder={newModalType === 'folder' ? 'my-new-folder' : 'script.js'}
                  autoFocus
                  required
                  className="w-full h-9 rounded-lg border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNewModalType(null)}
                  className="px-3.5 py-2 rounded-lg border border-input text-xs font-medium text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingItem || !newItemName.trim()}
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {creatingItem ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                  Create {newModalType === 'folder' ? 'Folder' : 'File'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* DELETE CONFIRMATION MODAL */}
      {/* ========================================================================= */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-xl border border-destructive/30 bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-start space-x-3">
              <div className="p-2 rounded-lg bg-destructive/10 text-destructive">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-foreground">
                  Confirm Deletion
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Are you sure you want to permanently delete{' '}
                  <span className="font-semibold text-foreground font-mono">{deleteTarget.name}</span>?
                  {deleteTarget.isDirectory && (
                    <span className="block text-red-400 mt-1 font-medium">
                      ⚠️ This is a directory. All containing files and subdirectories will be removed!
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-muted/40 text-[11px] font-mono text-muted-foreground break-all">
              {deleteTarget.path}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-3.5 py-2 rounded-lg border border-input text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteItem}
                disabled={deleting}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleting ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1.5" />}
                {deleting ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}