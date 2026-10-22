"use client";

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Lock,
  Eye,
  EyeOff,
  Shield,
  ShieldAlert,
  AlertCircle,
  RefreshCw,
  Server,
  ArrowRight,
  CheckCircle2,
  KeyRound
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, isConfigured, error: authError, loading, login, safeReturnPath } = useAuth();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isExpired = searchParams?.get('expired') === 'true';
  const isLogoutError = searchParams?.get('logoutError') === 'true';

  // If already authenticated, redirect to the safe return path
  useEffect(() => {
    if (isAuthenticated === true) {
      router.replace(safeReturnPath);
    }
  }, [isAuthenticated, router, safeReturnPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const trimmed = password.trim();
    if (!trimmed) {
      setLocalError('Please enter your master admin password.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await login(trimmed);
      if (!result.success) {
        setLocalError(result.error || 'Authentication failed. Please verify your credentials.');
      }
    } catch (err: any) {
      setLocalError(err.message || 'Unexpected connection error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeError = localError || authError;

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-background relative overflow-hidden">
      {/* Background ambient gradient glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/3 -translate-x-1/2 w-80 h-80 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-md">
        {/* Main Login Card */}
        <div className="bg-card/80 backdrop-blur-xl border border-border/80 rounded-2xl shadow-2xl p-6 sm:p-8 space-y-6">

          {/* Header & Logo */}
          <div className="text-center space-y-2">
            <div className="inline-flex p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-inner mb-1">
              <Server className="w-8 h-8" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground via-foreground/90 to-muted-foreground bg-clip-text text-transparent">
                K-Panel
              </h1>
              <p className="text-xs text-muted-foreground mt-1">
                Cloud & VPS Server Management Platform
              </p>
            </div>
          </div>

          {/* Missing Password Configuration Banner */}
          {!isConfigured && (
            <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs flex items-start gap-2.5">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold block text-amber-300">Server Authentication Unconfigured</span>
                <p className="text-[11px] text-amber-200/80 mt-0.5">
                  The <code className="bg-amber-950/60 px-1 py-0.5 rounded font-mono">K_PANEL_PASSWORD</code> environment variable is not configured. Access is locked down.
                </p>
              </div>
            </div>
          )}

          {/* Session Expired Notice */}
          {isExpired && !activeError && (
            <div className="p-3 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-200 text-xs flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Your session has expired. Please sign in again to continue.</span>
            </div>
          )}

          {/* Logout Incomplete Notice (Network failure during logout) */}
          {isLogoutError && !activeError && (
            <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs flex items-start gap-2.5">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold block text-amber-300">Server Logout Incomplete</span>
                <p className="text-[11px] text-amber-200/80 mt-0.5">
                  A network issue prevented server session revocation. Your local dashboard state was cleared, but the backend server could not confirm session destruction.
                </p>
              </div>
            </div>
          )}

          {/* Active Error Notice */}
          {activeError && (
            <div
              role="alert"
              className="p-3.5 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive-foreground text-xs flex items-start gap-2.5 animate-in fade-in duration-200"
            >
              <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 font-medium text-red-300">
                {activeError}
              </div>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="admin-password"
                className="text-xs font-semibold text-foreground flex items-center justify-between"
              >
                <span>Master Admin Password</span>
              </label>

              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  id="admin-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Enter administrator password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (localError) setLocalError(null);
                  }}
                  disabled={isSubmitting || loading}
                  className="w-full pl-9 pr-10 py-2.5 text-xs rounded-xl bg-muted/40 border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary text-foreground placeholder:text-muted-foreground transition-all duration-150 disabled:opacity-50"
                  required
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting || loading || !password.trim()}
              className="w-full inline-flex items-center justify-center rounded-xl bg-primary text-primary-foreground py-2.5 text-xs font-semibold hover:bg-primary/90 active:scale-[0.99] transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none shadow-md gap-2"
            >
              {isSubmitting || loading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Verifying Credentials...</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Sign In to Dashboard</span>
                  <ArrowRight className="w-3.5 h-3.5 opacity-60" />
                </>
              )}
            </button>
          </form>

          {/* Security Perimeter Footer */}
          <div className="pt-2 border-t border-border/40 text-center">
            <p className="text-[11px] text-muted-foreground flex items-center justify-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              <span>Protected by K-Panel Session Guard & Traefik SSL</span>
            </p>
          </div>
        </div>

        {/* Bottom subtle copyright / host info */}
        <div className="text-center mt-4">
          <p className="text-[11px] text-muted-foreground/60">
            K-Panel Self-Hosted Server Control • Ubuntu / Oracle Cloud ARM64
          </p>
        </div>
      </div>
    </div>
  );
}
