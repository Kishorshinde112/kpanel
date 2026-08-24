"use client";

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { Globe, Plus, Trash2, Edit2 } from 'lucide-react';

const mockDnsRecords = [
  { id: 1, type: 'A', name: '@', content: '192.168.1.100', ttl: 'Auto' },
  { id: 2, type: 'CNAME', name: 'www', content: 'example.com', ttl: 'Auto' },
  { id: 3, type: 'MX', name: '@', content: 'mail.example.com', ttl: '14400' },
  { id: 4, type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none;', ttl: 'Auto' },
];

export default function DomainsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Domains & DNS</h1>
          <p className="text-muted-foreground mt-2">
            Manage your registered domains and DNS zone records.
          </p>
        </div>
        <button className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">
          <Globe className="w-4 h-4 mr-2" />
          Add Domain
        </button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-xl">example.com</CardTitle>
            <CardDescription>DNS Zone Editor</CardDescription>
          </div>
          <button className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">
            <Plus className="w-4 h-4 mr-2" /> Add Record
          </button>
        </CardHeader>
        <CardContent>
          <div className="relative w-full overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b border-border/50">
                <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                  <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Type</th>
                  <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Name</th>
                  <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Content</th>
                  <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">TTL</th>
                  <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {mockDnsRecords.map(record => (
                  <tr key={record.id} className="border-b border-border/50 transition-colors hover:bg-muted/50">
                    <td className="p-4 align-middle font-semibold">{record.type}</td>
                    <td className="p-4 align-middle">{record.name}</td>
                    <td className="p-4 align-middle font-mono text-xs">{record.content}</td>
                    <td className="p-4 align-middle">{record.ttl}</td>
                    <td className="p-4 align-middle text-right space-x-2">
                      <button className="inline-flex p-2 hover:bg-muted rounded-md transition-colors text-muted-foreground hover:text-primary">
                         <Edit2 className="w-4 h-4" />
                      </button>
                      <button className="inline-flex p-2 hover:bg-red-500/10 rounded-md transition-colors text-muted-foreground hover:text-red-500">
                         <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}