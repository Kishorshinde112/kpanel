"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Terminal as TerminalIcon, Play, Trash2, Copy, Check, RefreshCw, Sparkles } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

const QUICK_COMMANDS = [
  'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"',
  'free -h',
  'df -h /',
  'uptime',
  'docker system df',
  'netstat -tlpn 2>/dev/null || ss -tlpn'
];

export default function TerminalPage() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<any>(null);
  const fitAddonInstance = useRef<any>(null);

  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [currentInput, setCurrentInput] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let term: any = null;
    let fitAddon: any = null;

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      if (!terminalRef.current) return;

      term = new Terminal({
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          black: '#484f58',
          red: '#ff7b72',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#b1bac4',
        },
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        convertEol: true,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);
      fitAddon.fit();

      termInstance.current = term;
      fitAddonInstance.current = fitAddon;

      // Welcome Banner
      term.writeln('\x1B[1;34m╭─────────────────────────────────────────────────────────────╮\x1B[0m');
      term.writeln('\x1B[1;34m│\x1B[0m  \x1B[1;32mK-Panel Interactive Web Terminal\x1B[0m (Connected to Ubuntu Server)  \x1B[1;34m│\x1B[0m');
      term.writeln('\x1B[1;34m│\x1B[0m  Type any command or use the quick chips below to run.      \x1B[1;34m│\x1B[0m');
      term.writeln('\x1B[1;34m╰─────────────────────────────────────────────────────────────╯\x1B[0m');
      term.write('\r\n\x1B[1;32mubuntu@kpanel\x1B[0m:\x1B[1;34m~\x1B[0m$ ');

      let buffer = '';

      term.onData(async (data: string) => {
        const code = data.charCodeAt(0);

        if (code === 13) { // Enter Key
          term.write('\r\n');
          const cmd = buffer.trim();
          buffer = '';

          if (cmd) {
            setHistory(prev => [...prev, cmd]);
            if (cmd === 'clear') {
              term.clear();
              term.write('\x1B[1;32mubuntu@kpanel\x1B[0m:\x1B[1;34m~\x1B[0m$ ');
              return;
            }

            try {
              const res = await fetch('/api/terminal/exec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              });
              const resData = await res.json();

              if (resData.output) {
                const formatted = resData.output.replace(/\n/g, '\r\n');
                term.writeln(formatted);
              }
              if (resData.exitCode !== 0 && !resData.output) {
                term.writeln(`\x1B[1;31mCommand exited with code ${resData.exitCode}\x1B[0m`);
              }
            } catch (err: any) {
              term.writeln(`\x1B[1;31mError: ${err.message}\x1B[0m`);
            }
          }

          term.write('\x1B[1;32mubuntu@kpanel\x1B[0m:\x1B[1;34m~\x1B[0m$ ');
        } else if (code === 127) { // Backspace
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            term.write('\b \b');
          }
        } else if (code === 27) { // Escape sequences (arrows, etc.)
          // Handle arrow keys if needed
        } else if (code >= 32) { // Printable characters
          buffer += data;
          term.write(data);
        }
      });

      const handleResize = () => {
        try { fitAddon.fit(); } catch {}
      };
      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        term?.dispose();
      };
    };

    initTerminal();
  }, []);

  const runQuickCommand = async (cmd: string) => {
    if (!termInstance.current) return;
    const term = termInstance.current;

    term.write(cmd + '\r\n');
    try {
      const res = await fetch('/api/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      const data = await res.json();
      if (data.output) {
        term.writeln(data.output.replace(/\n/g, '\r\n'));
      }
    } catch (err: any) {
      term.writeln(`\x1B[1;31mError: ${err.message}\x1B[0m`);
    }
    term.write('\x1B[1;32mubuntu@kpanel\x1B[0m:\x1B[1;34m~\x1B[0m$ ');
  };

  const handleClear = () => {
    if (!termInstance.current) return;
    termInstance.current.clear();
    termInstance.current.write('\x1B[1;32mubuntu@kpanel\x1B[0m:\x1B[1;34m~\x1B[0m$ ');
  };

  return (
    <div className="space-y-4 h-[calc(100vh-8rem)] flex flex-col animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Web Terminal</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Direct authenticated shell access to your VPS environment.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleClear}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </div>

      {/* Terminal Card */}
      <Card className="flex-1 flex flex-col min-h-0 border-border shadow-xl overflow-hidden">
        
        {/* Terminal Header */}
        <CardHeader className="py-3 px-4 border-b border-border/50 bg-[#161b22] flex flex-row items-center justify-between">
           <div className="flex items-center space-x-2">
              <div className="flex space-x-1.5 mr-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
              </div>
              <TerminalIcon className="w-4 h-4 text-primary" />
              <span className="text-xs font-mono text-muted-foreground">ubuntu@oracle-arm (bash)</span>
           </div>

           <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
             Session Active
           </span>
        </CardHeader>

        {/* XTerm Container */}
        <CardContent className="flex-1 p-0 bg-[#0d1117] overflow-hidden">
           <div ref={terminalRef} className="h-full w-full p-3" />
        </CardContent>

        {/* Quick Commands Toolbar */}
        <div className="px-4 py-2.5 bg-[#161b22] border-t border-border/40 flex items-center gap-2 overflow-x-auto">
          <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1 whitespace-nowrap">
            <Sparkles className="w-3.5 h-3.5 text-primary" /> Quick Run:
          </span>
          {QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              onClick={() => runQuickCommand(cmd)}
              className="whitespace-nowrap font-mono text-[11px] px-2.5 py-1 rounded-md bg-[#0d1117] hover:bg-muted text-gray-300 hover:text-white border border-border/50 transition-colors"
            >
              {cmd.split(' ')[0]} {cmd.split(' ')[1] || ''}
            </button>
          ))}
        </div>

      </Card>
    </div>
  );
}