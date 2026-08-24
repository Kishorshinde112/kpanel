"use client";

import React, { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Terminal as TerminalIcon } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPage() {
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Dynamic import to avoid SSR issues with xterm
    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      if (!terminalRef.current) return;

      const term = new Terminal({
        theme: {
          background: '#0a0a0a',
          foreground: '#f3f4f6',
          cursor: '#3b82f6',
        },
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 14,
        cursorBlink: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);
      fitAddon.fit();

      term.writeln('Welcome to K-Panel Web Terminal \x1B[1;3;31m(beta)\x1B[0m');
      term.writeln('Connecting to root@localhost...');
      setTimeout(() => {
        term.writeln('\x1B[1;32mConnected successfully.\x1B[0m');
        term.write('\r\nroot@kpanel:~# ');
      }, 1000);

      // Simple mock echo interaction
      let input = '';
      term.onData((data) => {
        const code = data.charCodeAt(0);
        if (code === 13) { // Enter
          term.write('\r\n');
          term.writeln(`bash: ${input}: command not found (mock environment)`);
          input = '';
          term.write('root@kpanel:~# ');
        } else if (code === 127) { // Backspace
          if (input.length > 0) {
            term.write('\b \b');
            input = input.substring(0, input.length - 1);
          }
        } else {
          input += data;
          term.write(data);
        }
      });

      // Handle window resize
      const handleResize = () => {
        fitAddon.fit();
      };
      window.addEventListener('resize', handleResize);

      return () => {
        term.dispose();
        window.removeEventListener('resize', handleResize);
      };
    };

    initTerminal();
  }, []);

  return (
    <div className="space-y-6 h-[calc(100vh-10rem)] flex flex-col">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Web Terminal</h1>
        <p className="text-muted-foreground mt-2">
          Direct SSH access to your server via the browser.
        </p>
      </div>

      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader className="py-4 border-b bg-muted/30">
           <CardTitle className="text-lg flex items-center space-x-2">
              <TerminalIcon className="w-5 h-5" />
              <span>root@localhost</span>
           </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-0 bg-[#0a0a0a] rounded-b-lg overflow-hidden">
           <div ref={terminalRef} className="h-full w-full p-4" />
        </CardContent>
      </Card>
    </div>
  );
}