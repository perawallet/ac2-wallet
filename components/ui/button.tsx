import * as React from 'react';
import { Pressable } from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { TextClassContext } from '@/components/ui/text';

const buttonVariants = cva('flex-row items-center justify-center gap-2 rounded-md', {
  variants: {
    variant: {
      default: 'bg-primary active:opacity-90',
      secondary: 'bg-secondary active:opacity-90',
      destructive: 'bg-destructive active:opacity-90',
      outline: 'border border-border bg-background active:bg-muted',
      ghost: 'active:bg-muted',
    },
    size: {
      default: 'h-12 px-5',
      sm: 'h-10 px-3',
      lg: 'h-14 px-8',
      icon: 'h-12 w-12',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

const buttonTextVariants = cva('text-base font-semibold', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      secondary: 'text-secondary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      ghost: 'text-foreground',
    },
    size: { default: '', sm: 'text-sm', lg: 'text-lg', icon: '' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

type ButtonProps = React.ComponentProps<typeof Pressable> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, disabled, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        className={cn(disabled && 'opacity-50', buttonVariants({ variant, size }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
