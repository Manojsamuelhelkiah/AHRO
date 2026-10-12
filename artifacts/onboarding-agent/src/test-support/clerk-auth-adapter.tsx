import React, { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Browser-regression-only Clerk boundary.
 *
 * The production app always resolves @clerk/react from the Clerk package. The
 * e2e Vite command aliases that package to this adapter so the regression can
 * exercise the real pages and API router without requiring a Clerk secret,
 * device verification, or an external identity-provider session. The
 * server-side harness still authenticates every API request with an
 * HttpOnly, test-only session cookie and the real tenant/profile guards.
 */

type DemoProfile = "administrator" | "reviewer" | "offboarding-operator" | "offboarding-legal" | "offboarding-viewer";
type TestUser = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  primaryEmailAddress: { emailAddress: string };
  emailAddresses: Array<{ emailAddress: string }>;
};

type AuthContextValue = {
  profile: DemoProfile | null;
  user: TestUser | null;
  setProfile: (profile: DemoProfile | null) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY = "onboarding-e2e-demo-profile";

const PROFILE_DETAILS: Record<DemoProfile, Omit<TestUser, "id">> = {
  "offboarding-operator": { firstName: "Separation", lastName: "Test Operator", fullName: "Isolated Separation Test Operator", primaryEmailAddress: { emailAddress: "operator@example.invalid" }, emailAddresses: [{ emailAddress: "operator@example.invalid" }] },
  "offboarding-legal": { firstName: "Separation", lastName: "Test Legal", fullName: "Isolated Separation Test Legal", primaryEmailAddress: { emailAddress: "legal@example.invalid" }, emailAddresses: [{ emailAddress: "legal@example.invalid" }] },
  "offboarding-viewer": { firstName: "Separation", lastName: "Test Viewer", fullName: "Isolated Separation Test Viewer", primaryEmailAddress: { emailAddress: "viewer@example.invalid" }, emailAddresses: [{ emailAddress: "viewer@example.invalid" }] },
  administrator: {
    firstName: "Demo",
    lastName: "Administrator",
    fullName: "Demo Administrator",
    primaryEmailAddress: { emailAddress: "demo.admin@example.com" },
    emailAddresses: [{ emailAddress: "demo.admin@example.com" }],
  },
  reviewer: {
    firstName: "Demo",
    lastName: "Reviewer",
    fullName: "Demo Reviewer",
    primaryEmailAddress: { emailAddress: "demo.reviewer@example.com" },
    emailAddresses: [{ emailAddress: "demo.reviewer@example.com" }],
  },
};

function profileFromStorage(): DemoProfile | null {
  if (typeof window === "undefined") return null;
  const profile = window.localStorage.getItem(STORAGE_KEY);
  return profile && profile in PROFILE_DETAILS ? profile as DemoProfile : null;
}

function userFor(profile: DemoProfile | null): TestUser | null {
  if (!profile) return null;
  return {
    id: `browser-e2e-${profile}`,
    ...PROFILE_DETAILS[profile],
  };
}

function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("The e2e Clerk adapter must be used inside ClerkProvider.");
  return context;
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<DemoProfile | null>(profileFromStorage);
  const setProfile = (next: DemoProfile | null) => {
    setProfileState(next);
    if (typeof window === "undefined") return;
    if (next) window.localStorage.setItem(STORAGE_KEY, next);
    else window.localStorage.removeItem(STORAGE_KEY);
  };
  const value = useMemo(() => ({ profile, user: userFor(profile), setProfile }), [profile]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function Show({
  when,
  children,
}: {
  when: "signed-in" | "signed-out";
  children: ReactNode;
}) {
  const { profile } = useAuthContext();
  return (when === "signed-in" ? profile !== null : profile === null) ? <>{children}</> : null;
}

export function useUser() {
  const { user } = useAuthContext();
  return { isLoaded: true, isSignedIn: user !== null, user };
}

export function useAuth() {
  const { profile, user } = useAuthContext();
  return {
    isLoaded: true,
    isSignedIn: user !== null,
    userId: user?.id ?? null,
    getToken: async () => null,
    sessionId: profile ? `e2e-session-${profile}` : null,
  };
}

export function useClerk() {
  const { setProfile } = useAuthContext();
  return {
    openUserProfile: () => { throw new Error("Provider profile/MFA enrollment is not simulated by the browser-regression adapter."); },
    signOut: async () => {
      await fetch("/api/test/auth/logout", { method: "POST", credentials: "include" });
      setProfile(null);
    },
  };
}

export function useReverification<T extends (...args: any[]) => Promise<any>>(fetcher: T): T {
  // This harness cannot attest MFA. It must never convert a step-up request
  // into successful verification.
  return (async (...args: Parameters<T>) => {
    const result = await fetcher(...args);
    if (result?.clerk_error) throw new Error("Real provider MFA verification is required; this harness cannot satisfy it.");
    return result;
  }) as T;
}

type SignInApi = {
  status: "complete" | "needs_first_factor";
  ticket: (input: { ticket: string }) => Promise<{ error: null | Error }>;
  password: (input: { identifier: string; password: string }) => Promise<{ error: null | Error }>;
  finalize: () => Promise<{ error: null | Error }>;
};

export function useSignIn() {
  const { setProfile } = useAuthContext();
  const signIn = useMemo<SignInApi>(() => ({
    status: "needs_first_factor",
    ticket: async ({ ticket }) => {
      const response = await fetch("/api/test/auth/finalize", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (!response.ok) {
        return { error: new Error("Test authentication ticket was rejected.") };
      }
      const body = (await response.json()) as { profile?: DemoProfile };
      if (body.profile !== "administrator" && body.profile !== "reviewer") {
        return { error: new Error("Test authentication profile was rejected.") };
      }
      setProfile(body.profile);
      signIn.status = "complete";
      return { error: null };
    },
    password: async ({ identifier }) => {
      if (identifier.trim().toLowerCase() !== "demo.admin@example.com" &&
        identifier.trim().toLowerCase() !== "demo.reviewer@example.com") {
        return { error: new Error("Test adapter only supports the two demo accounts.") };
      }
      return { error: new Error("Use the demo account ticket flow.") };
    },
    finalize: async () => ({ error: null }),
  }), [setProfile]);
  return { isLoaded: true, signIn };
}

export function SignIn() {
  return null;
}

export function SignUp() {
  return null;
}

export function publishableKeyFromHost(_hostname: string, configuredKey?: string) {
  return configuredKey ?? "pk_test_browser_regression";
}