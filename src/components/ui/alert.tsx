import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'border-destructive/40 bg-destructive/5 text-destructive [&>svg]:text-destructive',
        success: 'border-emerald-600/30 bg-emerald-50 text-emerald-900 [&>svg]:text-emerald-700',
        warning: 'border-amber-600/30 bg-amber-50 text-amber-900 [&>svg]:text-amber-700',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('font-medium leading-tight tracking-tight', className)}
      {...props}
    />
  );
}

export function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn('mt-1 text-sm leading-relaxed [&_p]:leading-relaxed', className)}
      {...props}
    />
  );
}
