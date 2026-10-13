import { useClerk } from "@clerk/react";
import { useState } from "react";
import { sessionAccessGuidance } from "@/lib/session-access";

export function SessionAccessNotice({ error }: { error: unknown }) {
  const clerk = useClerk();
  const guidance = sessionAccessGuidance(error);
  const [logoutError, setLogoutError] = useState("");
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return <div role="alert" data-testid="session-access-explanation"
    className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
    <p>{guidance.message}</p>
    <div className="flex flex-wrap gap-3">
      {guidance.renew && <a className="underline" href="#private-admin-session">Administrator verification controls</a>}
      <button type="button" className="underline" onClick={async () => {
        // End both the proof and provider session via the existing logout path.
        setLogoutError("");
        try {
          const response = await fetch(`${base}/api/onboarding/demo-login/logout`, { method: "POST", credentials: "include" });
          if (!response.ok) throw new Error("Sign-out could not be confirmed. Use End session above or try sign-out again.");
          await clerk.signOut({ redirectUrl: base || "/" });
        } catch { setLogoutError("Sign-out could not be confirmed. Use End session above or try sign-out again."); }
      }}>Sign out / sign in again</button>
    </div>
    {logoutError && <p role="alert">{logoutError}</p>}
  </div>;
}
