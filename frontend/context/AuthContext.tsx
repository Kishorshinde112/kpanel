"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

export interface AuthContextType {
  isAuthenticated: boolean | null; // null = verifying, true = logged in, false = unauthenticated
  isConfigured: boolean;
  error: string | null;
  loading: boolean;
  checkAuth: () => Promise<boolean>;
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<{ success: boolean; error?: string }>;
  safeReturnPath: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Validates and sanitizes a return path query parameter to prevent open redirect attacks.
 * Rejects external URLs, protocol-relative URLs, and non-relative paths.
 */
export function getSafeReturnPath(path: string | null): string {
  if (!path || typeof path !== 'string') return '/';
  const trimmed = path.trim();
  if (
    trimmed.startsWith('/') &&
    !trimmed.startsWith('//') &&
    !trimmed.includes('://') &&
    !trimmed.includes('\\') &&
    !trimmed.toLowerCase().startsWith('/login')
  ) {
    return trimmed;
  }
  return '/';
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [isConfigured, setIsConfigured] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const safeReturnPath = getSafeReturnPath(searchParams?.get('returnTo') || null);

  const checkAuth = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/status');
      if (!res.ok) {
        setIsAuthenticated(false);
        return false;
      }
      const data = await res.json().catch(() => ({}));
      const authed = Boolean(data.authenticated);
      setIsAuthenticated(authed);
      if (data.configured !== undefined) {
        setIsConfigured(Boolean(data.configured));
      }
      setError(null);
      return authed;
    } catch (err: any) {
      setIsAuthenticated(false);
      setError('Cannot connect to K-Panel backend service. Verify that the server is online.');
      return false;
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (password: string): Promise<{ success: boolean; error?: string }> => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        const errMsg =
          data.error ||
          (res.status === 401 ? 'Invalid master password. Please try again.' : 'Login failed. Please check credentials.');
        setError(errMsg);
        return { success: false, error: errMsg };
      }

      setIsAuthenticated(true);
      setIsConfigured(true);
      setError(null);

      // Navigate to safe return path
      router.push(safeReturnPath);
      return { success: true };
    } catch (err: any) {
      const networkErrMsg = 'Cannot reach K-Panel server. Please ensure the backend container is running.';
      setError(networkErrMsg);
      return { success: false, error: networkErrMsg };
    } finally {
      setLoading(false);
    }
  };

  const logout = async (): Promise<{ success: boolean; error?: string }> => {
    setLoading(true);
    let networkError: string | null = null;
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        networkError = 'Server returned error during session invalidation.';
      }
    } catch (err: any) {
      networkError = 'Network failure: Unable to contact server for session revocation.';
    }

    setIsAuthenticated(false);
    setLoading(false);

    if (networkError) {
      setError(networkError);
      router.push('/login?logoutError=true');
      return { success: false, error: networkError };
    }

    router.push('/login');
    return { success: true };
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isConfigured,
        error,
        loading,
        checkAuth,
        login,
        logout,
        safeReturnPath,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
