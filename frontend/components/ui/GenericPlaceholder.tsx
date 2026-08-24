import React from 'react';

export default function GenericPlaceholderPage({ title, description }: { title: string, description: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-2">{description}</p>
      </div>
      <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg bg-muted/10">
        <div className="text-center">
          <p className="text-muted-foreground font-medium">UI Mockup Pending</p>
          <p className="text-xs text-muted-foreground mt-1">This module will be fully implemented in the next phase.</p>
        </div>
      </div>
    </div>
  );
}