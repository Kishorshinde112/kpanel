"use client";

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../../components/ui/Card';
import { Box, Plus, Settings } from 'lucide-react';

const apps = [
  { id: 1, name: 'my-wordpress-site', type: 'WordPress', domain: 'example.com', status: 'running' },
  { id: 2, name: 'api-backend', type: 'Node.js', domain: 'api.example.com', status: 'running' },
];

export default function ApplicationsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Applications</h1>
          <p className="text-muted-foreground mt-2">
            Manage and deploy your web applications via 1-Click Blueprints.
          </p>
        </div>
        <button className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">
          <Plus className="w-4 h-4 mr-2" />
          Deploy New App
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {apps.map(app => (
          <Card key={app.id} className="flex flex-col">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-start">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-primary/10 rounded-lg text-primary">
                    <Box className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{app.name}</CardTitle>
                    <CardDescription className="text-xs">{app.type}</CardDescription>
                  </div>
                </div>
                <div className="flex items-center space-x-1">
                   <span className="relative flex h-2.5 w-2.5 mr-1">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                   </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 pb-4">
              <div className="text-sm">
                <span className="text-muted-foreground">Domain: </span>
                <a href={`https://${app.domain}`} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                  {app.domain}
                </a>
              </div>
            </CardContent>
            <CardFooter className="pt-0 border-t border-border/50 bg-muted/20 px-6 py-3 mt-auto">
              <button className="w-full inline-flex items-center justify-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                <Settings className="w-4 h-4 mr-2" /> Manage Configuration
              </button>
            </CardFooter>
          </Card>
        ))}

        {/* 1-Click Installer UI Card */}
        <Card className="flex flex-col border-dashed border-2 bg-transparent hover:bg-muted/10 cursor-pointer transition-colors justify-center items-center h-48">
           <Plus className="w-8 h-8 text-muted-foreground mb-2" />
           <span className="font-medium text-muted-foreground">Browse App Blueprints</span>
        </Card>
      </div>
    </div>
  );
}