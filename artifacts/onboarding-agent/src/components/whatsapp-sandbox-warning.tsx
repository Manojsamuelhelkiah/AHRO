import React, { useState } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, X } from 'lucide-react';
import {
  latestInboundWhatsApp,
  sandboxSessionExpired,
  sandboxDismissKey,
  sandboxJoinInstruction,
  type CommLike,
} from '../lib/sandbox-session';

function readDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Warns HR when a hire's Twilio WhatsApp sandbox session has likely expired
 * (no inbound WhatsApp message in the last 72 hours, or none at all).
 * Dismissible per case; the dismissal is keyed to the latest inbound message
 * so the warning returns if the session goes stale again later.
 */
export function WhatsAppSandboxWarning({
  caseId,
  channelPreference,
  comms,
  sandbox,
}: {
  caseId: number;
  channelPreference?: string;
  comms?: CommLike[];
  sandbox?: { sandboxNumber?: string | null; sandboxJoinKeyword?: string | null };
}) {
  const lastInbound = latestInboundWhatsApp(comms);
  const expired = sandboxSessionExpired({ channelPreference, comms });
  const dismissKey = sandboxDismissKey(caseId, lastInbound?.id ?? null);

  const [dismissed, setDismissed] = useState(() => readDismissed(dismissKey));
  // Re-read when the key changes (e.g. a newer inbound message arrived).
  const [prevKey, setPrevKey] = useState(dismissKey);
  if (prevKey !== dismissKey) {
    setPrevKey(dismissKey);
    setDismissed(readDismissed(dismissKey));
  }

  if (!expired || dismissed) return null;

  const { joinText, number, keywordKnown } = sandboxJoinInstruction(sandbox);

  const handleDismiss = () => {
    try {
      localStorage.setItem(dismissKey, '1');
    } catch {
      // localStorage unavailable — dismiss for this render only
    }
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      className="flex items-start gap-3 p-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 shadow-sm"
    >
      <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-bold">WhatsApp sandbox session may be expired</p>
        <p className="text-sm mt-1 leading-relaxed">
          {lastInbound
            ? <>The hire last messaged on WhatsApp {format(new Date(lastInbound.createdAt), 'MMM d, HH:mm')} — more than 72 hours ago. </>
            : <>No inbound WhatsApp message from the hire has been received. </>}
          Twilio sandbox sessions expire after 72 hours of inactivity, so outbound WhatsApp messages may silently queue or fail until the hire re-joins.
        </p>
        <p className="text-sm mt-2 font-medium">
          Ask the hire to send{' '}
          <code className="bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5 font-mono text-xs">{joinText}</code>{' '}
          to <span className="font-mono">{number}</span> to re-activate the session.
          {!keywordKnown && (
            <span className="font-normal text-amber-800"> The join keyword is shown in your Twilio Console under Messaging → Try it out → WhatsApp sandbox.</span>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss sandbox warning"
        className="p-1 rounded-md hover:bg-amber-100 text-amber-700 transition-colors shrink-0"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
