// Vite aliases this module only in the isolated NODE_ENV=test harness.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
type Identity = { userId?: string; sessionId?: string };
const Context = createContext<{ identity: Identity; loaded: boolean }>({ identity: {}, loaded: false });
export function ClerkProvider({ children }: { children: ReactNode; [key: string]: unknown }) {
  const [identity, setIdentity] = useState<Identity>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void fetch('/uat/api/test/uat-identity').then(r => r.json()).then(setIdentity).finally(() => setLoaded(true));
  }, []);
  return <Context.Provider value={{ identity, loaded }}>{children}</Context.Provider>;
}
export function useAuth() {
  const { identity, loaded } = useContext(Context);
  return { isLoaded: loaded, isSignedIn: Boolean(identity.userId), userId: identity.userId ?? null, sessionId: identity.sessionId ?? null };
}
export function useClerk() {
  return { signOut: async ({ redirectUrl }: { redirectUrl: string }) => {
    await fetch('/uat/api/test/auth/logout', { method: 'POST' });
    window.location.assign(redirectUrl);
  } };
}
export function SignIn({ forceRedirectUrl }: { forceRedirectUrl: string; [key: string]: unknown }) {
  const [error, setError] = useState('');
  return <section><h2 className="text-xl font-semibold">Isolated credential adapter</h2>
    <p>Only the external Clerk provider is replaced in this disposable test.</p>
    <button className="mt-4 rounded-lg bg-indigo-600 p-4 text-white" onClick={() => {
      void fetch('/uat/api/test/uat-credential', { method: 'POST' }).then(response => {
        if (!response.ok) throw new Error('Test credential rejected');
        window.location.assign(forceRedirectUrl);
      }).catch(() => setError('Test credential failed'));
    }}>Complete test credential</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
export const publishableKeyFromHost = () => 'pk_test_YnJvd3Nlci5jbGVyay5hY2NvdW50cy5kZXYk';
