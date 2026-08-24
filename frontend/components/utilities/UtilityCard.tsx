import React from 'react';
import { UtilityCardProps } from '../../types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '../ui/Card';
import { CheckCircle2, AlertCircle, XCircle, HelpCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

export const UtilityCard: React.FC<UtilityCardProps> = ({
  title,
  description,
  icon,
  actionText,
  onAction,
  status
}) => {

  const StatusIcon = () => {
    switch(status) {
      case 'healthy':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case 'warning':
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
      case 'error':
        return <XCircle className="w-5 h-5 text-red-500" />;
      case 'inactive':
        return <HelpCircle className="w-5 h-5 text-muted-foreground" />;
      default:
        return null;
    }
  };

  return (
    <Card className="flex flex-col h-full hover:border-primary/50 transition-colors">
      <CardHeader className="flex flex-row items-start justify-between pb-2">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-primary/10 rounded-lg text-primary">
            {icon}
          </div>
          <CardTitle className="text-base font-medium">{title}</CardTitle>
        </div>
        {status && <StatusIcon />}
      </CardHeader>
      <CardContent className="flex-1 pb-4">
        <CardDescription className="text-sm mt-2">{description}</CardDescription>
      </CardContent>
      {actionText && (
        <CardFooter className="pt-0 mt-auto">
          <button
            onClick={onAction}
            className="w-full inline-flex justify-center items-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 h-9 px-4 py-2"
          >
            {actionText}
          </button>
        </CardFooter>
      )}
    </Card>
  );
};