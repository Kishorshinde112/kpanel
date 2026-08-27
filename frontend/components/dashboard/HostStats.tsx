import React from 'react';
import { HostStatsProps } from '../../types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';
import { Cpu, HardDrive, MemoryStick } from 'lucide-react';

export const HostStats: React.FC<HostStatsProps> = ({ cpuUsage, ramUsage, diskUsage, loading }) => {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Server Resources</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-4 border rounded-lg bg-card animate-pulse space-y-3">
              <div className="h-4 w-24 bg-muted rounded"></div>
              <div className="h-8 w-16 bg-muted rounded"></div>
              <div className="h-2 w-full bg-muted rounded"></div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  const ramPercent = ramUsage.total > 0 ? Math.min(100, Math.round((ramUsage.used / ramUsage.total) * 100)) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center space-x-2">
           Server Resources
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">

        {/* CPU Stats */}
        <div className="flex flex-col space-y-2 p-4 border rounded-lg bg-card">
          <div className="flex items-center text-muted-foreground space-x-2">
            <Cpu className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium">CPU Usage</span>
          </div>
          <div className="text-2xl font-bold">
            {cpuUsage}%
          </div>
          <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
            <div
              className={`h-2.5 rounded-full transition-all duration-500 ${cpuUsage > 80 ? 'bg-red-500' : cpuUsage > 50 ? 'bg-yellow-500' : 'bg-primary'}`}
              style={{ width: `${Math.min(100, Math.max(2, cpuUsage))}%` }}
            ></div>
          </div>
        </div>

        {/* RAM Stats */}
        <div className="flex flex-col space-y-2 p-4 border rounded-lg bg-card">
          <div className="flex items-center text-muted-foreground space-x-2">
            <MemoryStick className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium">RAM Usage</span>
          </div>
          <div className="text-2xl font-bold">
            {ramUsage.used.toFixed(1)} GB <span className="text-sm text-muted-foreground font-normal">/ {ramUsage.total.toFixed(1)} GB</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
            <div
              className={`h-2.5 rounded-full transition-all duration-500 ${ramPercent > 85 ? 'bg-red-500' : ramPercent > 70 ? 'bg-yellow-500' : 'bg-primary'}`}
              style={{ width: `${Math.min(100, Math.max(2, ramPercent))}%` }}
            ></div>
          </div>
        </div>

        {/* Disk Stats */}
        <div className="flex flex-col space-y-2 p-4 border rounded-lg bg-card">
          <div className="flex items-center text-muted-foreground space-x-2">
            <HardDrive className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium">Disk Usage</span>
          </div>
          <div className="text-2xl font-bold">
            {diskUsage}% <span className="text-sm text-muted-foreground font-normal">Used</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
            <div
              className={`h-2.5 rounded-full transition-all duration-500 ${diskUsage > 85 ? 'bg-red-500' : 'bg-primary'}`}
              style={{ width: `${Math.min(100, Math.max(2, diskUsage))}%` }}
            ></div>
          </div>
        </div>

      </CardContent>
    </Card>
  );
};