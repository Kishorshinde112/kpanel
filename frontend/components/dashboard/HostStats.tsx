import React from 'react';
import { HostStatsProps } from '../../types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';
import { Cpu, HardDrive, MemoryStick } from 'lucide-react';

export const HostStats: React.FC<HostStatsProps> = ({ cpuUsage, ramUsage, diskUsage, loading }) => {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Host Statistics</CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center items-center h-24">
          <div className="animate-pulse flex space-x-4">
            <div className="h-4 w-3/4 bg-muted rounded"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

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
          <div className="w-full bg-muted rounded-full h-2.5">
            <div className="bg-primary h-2.5 rounded-full" style={{ width: `${cpuUsage}%` }}></div>
          </div>
        </div>

        {/* RAM Stats */}
        <div className="flex flex-col space-y-2 p-4 border rounded-lg bg-card">
          <div className="flex items-center text-muted-foreground space-x-2">
            <MemoryStick className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium">RAM Usage</span>
          </div>
          <div className="text-2xl font-bold">
            {ramUsage.used.toFixed(1)} GB <span className="text-sm text-muted-foreground font-normal">/ {ramUsage.total} GB</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2.5">
            <div className="bg-primary h-2.5 rounded-full" style={{ width: `${(ramUsage.used / ramUsage.total) * 100}%` }}></div>
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
          <div className="w-full bg-muted rounded-full h-2.5">
            <div className="bg-primary h-2.5 rounded-full" style={{ width: `${diskUsage}%` }}></div>
          </div>
        </div>

      </CardContent>
    </Card>
  );
};