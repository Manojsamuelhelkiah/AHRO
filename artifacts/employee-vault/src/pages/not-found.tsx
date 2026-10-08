import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { StatusScreen } from '@/components/vault-ui';

export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      title="That page isn't in the vault."
      body="The link may be mistyped or out of date. Nothing of yours has been opened or changed."
      actions={<Button asChild data-testid="button-home"><Link href="/">Back to start</Link></Button>}
    />
  );
}
