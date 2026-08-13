import * as React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function PageHeader({ title, subtitle, children }: { title: string, subtitle?: string, children?: React.ReactNode }) {
  return (
    <div 
      className="flex items-center justify-between"
      style={{ 
        padding: '24px 32px 20px', 
        borderBottom: '1px solid var(--border)', 
        margin: '0 -32px 24px -32px' 
      }}
    >
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2, margin: 0 }}>{title}</h1>
        {subtitle && <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>{subtitle}</p>}
      </div>
      {children && (
        <div className="flex items-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}


export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive', size?: 'default' | 'sm' | 'lg' | 'icon' }>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    const variants = {
      default: 'bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] shadow-[var(--shadow-sm)] border border-transparent',
      secondary: 'bg-[var(--surface-alt)] text-[var(--text-primary)] hover:bg-[var(--primary-light)] hover:text-[var(--primary)] border border-transparent',
      outline: 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-alt)] hover:text-[var(--primary)]',
      ghost: 'hover:bg-[var(--surface-alt)] hover:text-[var(--primary)] text-[var(--text-primary)] border border-transparent',
      destructive: 'bg-[var(--surface)] text-[var(--status-red)] border border-[var(--status-red)] hover:bg-red-50 shadow-[var(--shadow-sm)]',
    };
    const sizes = {
      default: 'h-[36px] px-[16px] py-[0px] text-[13px]',
      sm: 'h-[32px] px-[12px] text-[12px]',
      lg: 'h-[40px] px-[24px] text-[14px]',
      icon: 'h-[36px] w-[36px]',
    };
    return (
      <button ref={ref} className={cn('inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:pointer-events-none disabled:opacity-50 normal-case', variants[variant], sizes[size], className)} {...props} />
    );
  }
);
Button.displayName = 'Button';

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]', className)} {...props} />
);
export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1 p-[20px] pb-[16px]', className)} {...props} />
);
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-[15px] font-semibold leading-none tracking-tight', className)} {...props} />
);
export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-[20px] pt-0', className)} {...props} />
);

export const Badge = ({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'secondary' | 'outline' | 'destructive' }) => {
  const variants = {
    default: 'border-transparent bg-[var(--primary-light)] text-[var(--primary)]',
    secondary: 'border-transparent bg-[var(--surface-alt)] text-[var(--text-secondary)]',
    outline: 'text-[var(--text-secondary)] border-[var(--border)]',
    destructive: 'border-transparent bg-red-100 text-[var(--status-red)]',
  };
  return (
    <div className={cn('inline-flex items-center rounded-full border px-[8px] py-[4px] text-[11px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--primary)] focus:ring-offset-2', variants[variant], className)} {...props} />
  );
};

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => (
  <input type={type} className={cn('flex h-[36px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[12px] py-[8px] text-[13px] shadow-sm transition-colors file:border-0 file:bg-transparent file:text-[13px] file:font-medium placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50', className)} ref={ref} {...props} />
));
Input.displayName = 'Input';

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn('text-[11px] uppercase tracking-wider font-medium text-[var(--text-muted)] leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)} {...props} />
));
Label.displayName = 'Label';
