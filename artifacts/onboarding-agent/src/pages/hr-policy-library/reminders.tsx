import { Link } from 'wouter';
import { usePolicyReminders } from '../../hooks/use-policies';

/** Mounted only while the current capabilities authorize maintenance. */
export function PolicyReminders() {
  const query = usePolicyReminders(true);
  return (
    <section aria-label="Policy date reminders" className="rounded-xl border border-[var(--border)] bg-white p-5">
      <h2 className="font-bold text-[var(--text-primary)]">Policy date reminders</h2>
      <p className="text-sm text-[var(--text-muted)] mt-1">
        Review and effective end dates within 30 days, including overdue sources.
        Prepare a successor and obtain independent review before publishing.
        Reminders stay in this app; they do not extend dates or send messages.
      </p>
      {query.isError ? (
        <div role="alert" className="mt-3 text-sm">
          Reminders could not be loaded. Your maintenance authority or source access may have changed.
          <button className="ml-2 underline" onClick={() => void query.refetch()}>Retry</button>
        </div>
      ) : query.isLoading ? (
        <p role="status" className="mt-3 text-sm">Loading reminders…</p>
      ) : query.data?.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-muted)]">No upcoming or overdue dates for published sources you can maintain.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {query.data?.map(reminder => (
            <li key={reminder.id} className="flex flex-wrap justify-between gap-3 rounded-lg border border-[var(--border)] p-3">
              <div>
                <p className="font-semibold">{reminder.title} · v{reminder.version}</p>
                <p className="text-sm">
                  {reminder.kind === 'review_due' ? 'Review due' : 'Effective end'}: {reminder.dueOn}
                  {' · '}{reminder.daysRemaining < 0
                    ? `Overdue by ${Math.abs(reminder.daysRemaining)} day(s) — unavailable for current answers`
                    : reminder.daysRemaining === 0 ? 'Due today' : `In ${reminder.daysRemaining} day(s)`}
                </p>
              </div>
              <Link className="text-sm font-semibold underline self-center" href={`/hr-policy-library/${reminder.policyId}`}>
                Review source and prepare successor
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}