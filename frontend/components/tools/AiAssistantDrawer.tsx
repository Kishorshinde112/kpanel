"use client";

import React, { useState, useRef, useEffect } from 'react';
import { Bot, Send, X, Sparkles, RefreshCw, Terminal, CheckCircle2, Copy, Check, Server } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface AiAssistantDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const QUICK_PROMPTS = [
  '⚡ Check VPS health & bottleneck alerts',
  '🧹 How to clean Docker build cache & logs?',
  '📦 Generate Docker Compose for Redis & Cache',
  '🛡️ Troubleshoot high RAM or CPU load'
];

export const AiAssistantDrawer: React.FC<AiAssistantDrawerProps> = ({ isOpen, onClose }) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: `Hello! I am your **K-Panel AI VPS Assistant**.\n\nI have live visibility into your server resources (4 Cores, 24GB RAM, Docker containers, and Traefik routing). Ask me anything or choose a quick diagnostic below!`,
      timestamp: new Date().toLocaleTimeString()
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  if (!isOpen) return null;

  const handleSend = async (customText?: string) => {
    const textToSend = customText || input;
    if (!textToSend.trim() || loading) return;

    const userMsg: Message = {
      role: 'user',
      content: textToSend,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend,
          history: messages.slice(-6)
        })
      });

      const data = await res.json();
      const assistantMsg: Message = {
        role: 'assistant',
        content: data.reply || 'Analysis completed.',
        timestamp: new Date().toLocaleTimeString()
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `⚠️ Failed to query assistant: ${err.message}`,
          timestamp: new Date().toLocaleTimeString()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCode = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg h-full flex flex-col border-l border-border bg-card shadow-2xl overflow-hidden animate-in slide-in-from-right duration-300">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 bg-muted/20">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold flex items-center gap-2">
                K-Panel AI Assistant
                <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-primary/20 text-primary">Live</span>
              </h2>
              <p className="text-xs text-muted-foreground">Server diagnostics, Docker config & troubleshooting</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m, idx) => (
            <div
              key={idx}
              className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[90%] rounded-xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-none'
                    : 'bg-muted/60 text-foreground border border-border/50 rounded-bl-none'
                }`}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
              <span className="text-[10px] text-muted-foreground mt-1 px-1">{m.timestamp}</span>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground text-xs p-3 rounded-lg bg-muted/30 w-fit animate-pulse">
              <Sparkles className="w-4 h-4 text-primary animate-spin" />
              Analyzing server state & telemetry...
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts */}
        <div className="px-4 py-2 bg-muted/10 border-t border-border/30 overflow-x-auto flex gap-1.5">
          {QUICK_PROMPTS.map((p, i) => (
            <button
              key={i}
              onClick={() => handleSend(p)}
              className="whitespace-nowrap text-[11px] px-2.5 py-1 rounded-full bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground border border-border/40 transition-colors"
            >
              {p}
            </button>
          ))}
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-border/50 bg-card">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              placeholder="Ask anything about your server, logs, or Docker..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="flex-1 rounded-lg border border-input bg-background px-3.5 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>

      </div>
    </div>
  );
};
