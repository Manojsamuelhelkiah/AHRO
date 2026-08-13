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
        padding: 'var(--space-lg) var(--space-xl) var(--space-md)', 
        borderBottom: '1px solid var(--border)', 
        margin: '0 calc(var(--space-xl) * -1) var(--space-lg) calc(var(--space-xl) * -1)' 
      }}
    >
      <div>
        <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2, margin: 0, letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: '4px', marginBottom: 0 }}>{subtitle}</p>}
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
      secondary: 'bg-[var(--surface-alt)] text-[var(--text-primary)] hover:bg-[var(--surface-soft)] hover:text-[var(--primary)] border border-[var(--border)]',
      outline: 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-alt)] hover:text-[var(--primary)]',
      ghost: 'hover:bg-[var(--surface-alt)] hover:text-[var(--primary)] text-[var(--text-primary)] border border-transparent',
      destructive: 'bg-[var(--surface)] text-[var(--status-red)] border border-[var(--status-red)] hover:bg-[var(--status-red)] hover:text-white shadow-[var(--shadow-sm)]',
    };
    const sizes = {
      default: 'h-[32px] px-[12px] py-[0px] text-[var(--text-sm)]',
      sm: 'h-[28px] px-[10px] text-[var(--text-xs)]',
      lg: 'h-[36px] px-[16px] text-[var(--text-base)]',
      icon: 'h-[32px] w-[32px]',
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
  <div className={cn('flex flex-col space-y-1 p-[var(--space-lg)] pb-[var(--space-sm)]', className)} {...props} />
);
export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-[var(--text-lg)] font-semibold leading-none tracking-tight', className)} {...props} />
);
export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-[var(--space-lg)] pt-0', className)} {...props} />
);

export function SectionHeading({ icon: Icon, title, description }: { icon?: React.ComponentType<{ className?: string }>, title: string, description?: string }) {
  return (
    <div className="border-b pb-2" style={{ borderColor: 'var(--border)' }}>
      <h2 className="text-[var(--text-sm)] font-semibold flex items-center gap-2 text-[var(--text-primary)] m-0">
        {Icon && <Icon className="w-4 h-4 text-[var(--primary)]" />} {title}
      </h2>
      {description && <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5 mb-0">{description}</p>}
    </div>
  );
}

export function IconTile({ icon: Icon, className }: { icon: React.ComponentType<{ className?: string }>, className?: string }) {
  return (
    <div className={cn('p-2 rounded-[var(--radius-md)] flex items-center justify-center shrink-0 border', className)}>
      <Icon className="w-4 h-4" />
    </div>
  );
}

export function LoadingBlock({ children, className }: { children: React.ReactNode, className?: string }) {
  return (
    <div className={cn('py-6 px-4 text-center text-[var(--text-sm)] text-[var(--text-muted)] border border-dashed rounded-[var(--radius-lg)]', className)}>
      {children}
    </div>
  );
}

export const Badge = ({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'secondary' | 'outline' | 'destructive' }) => {
  const variants = {
    default: 'border-transparent bg-[var(--primary-light)] text-[var(--primary)]',
    secondary: 'border-transparent bg-[var(--surface-alt)] text-[var(--text-secondary)]',
    outline: 'text-[var(--text-secondary)] border-[var(--border)] bg-[var(--surface)]',
    destructive: 'border-[var(--status-red)] bg-transparent text-[var(--status-red)]',
  };
  return (
    <div className={cn('inline-flex items-center rounded-full border px-[8px] py-[2px] text-[var(--text-xs)] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--primary)] focus:ring-offset-2', variants[variant], className)} {...props} />
  );
};

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => (
  <input type={type} className={cn('flex h-[32px] w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[6px] text-[var(--text-sm)] shadow-sm transition-colors file:border-0 file:bg-transparent file:text-[var(--text-sm)] file:font-medium placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:border-[var(--primary)] focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50', className)} ref={ref} {...props} />
));
Input.displayName = 'Input';

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn('text-[var(--text-xs)] uppercase tracking-wider font-semibold text-[var(--text-muted)] leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)} {...props} />
));
Label.displayName = 'Label';
