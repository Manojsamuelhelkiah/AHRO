import { Button } from '@/components/ui/button';
import { StatusScreen } from '@/components/vault-ui';
import type { ErrorFallbackProps } from '@/components/error-boundary';

export function Crash({ resetError }: ErrorFallbackProps) {
  return (
    <StatusScreen
      code="UNEXPECTED"
      title="Something slipped on our side."
      body="Your documents and consent decisions are stored safely on the server and were not affected. Try again, and if it persists, reload the page."
      actions={<Button onClick={resetError} data-testid="button-retry">Try again</Button>}
    />
  );
}
