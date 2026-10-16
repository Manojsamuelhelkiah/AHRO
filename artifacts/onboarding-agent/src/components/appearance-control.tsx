import { Palette } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from './ui/dropdown-menu';
import { THEMES, setTheme, useAppearance, isTheme } from '@/lib/appearance';

const labels = { classic: 'Classic', vibrant: 'Vibrant', midnight: 'Midnight' };
const previews = {
  classic: ['#f8f9fc', '#ffffff', '#4c42ee'],
  vibrant: ['#eae6ff', '#6640d8', '#0b837e'],
  midnight: ['#0b1324', '#162238', '#aaa4ff'],
};

export function AppearanceControl() {
  const theme = useAppearance();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Appearance: ${labels[theme]}`}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]">
          <Palette className="h-4 w-4" aria-hidden />
          <span>Appearance</span>
          <span className="hidden xl:inline text-[var(--text-muted)]">· {labels[theme]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 max-w-[calc(100vw-24px)]">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => { if (isTheme(value)) setTheme(value); }}>
          {THEMES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}
              className="min-h-12 gap-3 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground">
              <span aria-hidden className="flex overflow-hidden rounded border border-[var(--border)]">
                {previews[value].map((color) => <span key={color} style={{ backgroundColor: color }} className="h-6 w-5" />)}
              </span>
              <span className="font-medium">{labels[value]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
