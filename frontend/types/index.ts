import React from 'react';

export interface HostStatsProps {
  cpuUsage: number;
  ramUsage: {
    used: number; // in GB
    total: number; // in GB
  };
  diskUsage: number; // percentage (e.g. 65)
  loading?: boolean;
}

export interface UtilityCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  actionText?: string;
  onAction?: () => void;
  status?: 'healthy' | 'warning' | 'error' | 'inactive';
}

export interface NavItem {
  name: string;
  href: string;
  icon: React.ReactNode;
  current?: boolean;
}