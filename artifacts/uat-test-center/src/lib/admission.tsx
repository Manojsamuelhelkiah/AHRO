import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import {
  exitUatSession,
  getUatAdmission,
  pinOrganizationIdForPage,
  setApiResponseObserver,
  type UatAdmission,
} from '@workspace/api-client-react';

export type AdmissionStatus =
  | { kind: 'checking' }
  | { kind: 'none'; notice?: string }
  | { kind: 'admitted'; admission: UatAdmission }
  | { kind: 'error'; message: string };

type Host = {
  status: AdmissionStatus;
  admit: (admission: UatAdmission) => void;
  /** Immediately unmounts protected UI; optionally revokes the UAT admission only. */
  end: (notice?: string, revoke?: boolean) => void;
  recheck: () => void;
};

const HostContext = createContext<Host | null>(null);
const AdmissionContext = createContext<UatAdmission | null>(null);
const WORKSPACE_KEY = 'hro.uat.workspace';
const EXITED_KEY = 'hro.uat.exited';
function savedWorkspace() {
  try { return sessionStorage.getItem(WORKSPACE_KEY); } catch { return null; }
}
function rememberWorkspace(value: string | null) {
  try {
    if (value) sessionStorage.setItem(WORKSPACE_KEY, value);
    else sessionStorage.removeItem(WORKSPACE_KEY);
  } catch { /* Persistence is convenience only, never admission. */ }
}
function wasExited() {
  try { return Boolean(sessionStorage.getItem(EXITED_KEY)); } catch { return false; }
}
function rememberExit(exited: boolean) {
  try {
    if (exited) sessionStorage.setItem(EXITED_KEY, '1');
    else sessionStorage.removeItem(EXITED_KEY);
  } catch { /* Denial marker is not authorization; live server proof is still required. */ }
}

export function useAdmissionHost(): Host {
  const host = useContext(HostContext);
  if (!host) throw new Error('AdmissionHost is missing');
  return host;
}

export function useAdmission(): UatAdmission {
  const admission = useContext(AdmissionContext);
  if (!admission) throw new Error('Protected UAT content mounted without server admission');
  return admission;
}

/** Only accepts in-app absolute paths; never the auth screens. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/^\/(sign-in|verify)(\/|\?|$)/.test(value)) return '/';
  return value;
}

export function AdmissionHost({ children }: { children: ReactNode }) {
  const { isLoaded, userId, sessionId } = useAuth();
  const [status, setStatus] = useState<AdmissionStatus>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    const epoch = ++generation.current;
    const controller = new AbortController();
    // A per-tab selector is not proof: every restoration is server verified.
    pinOrganizationIdForPage(savedWorkspace());
    setStatus({ kind: 'checking' });
    if (!userId || !sessionId || wasExited()) {
      setStatus({ kind: 'none' });
      return () => controller.abort();
    }
    getUatAdmission({ signal: controller.signal })
      .then((admission) => {
        if (controller.signal.aborted || epoch !== generation.current) return;
        pinOrganizationIdForPage(admission.organizationId);
        rememberWorkspace(admission.organizationId);
        setStatus({ kind: 'admitted', admission });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || epoch !== generation.current) return;
        const code = (caught as { status?: number } | null)?.status;
        if (code === 401 || code === 403 || code === 404 || code === 409 || code === 410) {
          setStatus((current) => (current.kind === 'admitted' ? current : { kind: 'none' }));
          return;
        }
        setStatus({ kind: 'error', message: 'Could not reach the UAT admission service.' });
      });
    return () => controller.abort();
  }, [attempt, isLoaded, userId, sessionId]);

  const admit = useCallback((admission: UatAdmission) => {
    ++generation.current;
    rememberExit(false);
    rememberWorkspace(admission.organizationId);
    pinOrganizationIdForPage(admission.organizationId);
    setStatus({ kind: 'admitted', admission });
  }, []);

  const end = useCallback((notice?: string, revoke = true) => {
    ++generation.current;
    rememberWorkspace(null);
    rememberExit(true);
    pinOrganizationIdForPage(null);
    setStatus({ kind: 'none', notice });
    if (revoke) {
      channel.current?.postMessage('exit');
      void exitUatSession({ keepalive: true }).catch(() => {
        setStatus((current) =>
          current.kind === 'none'
            ? { kind: 'none', notice: `${notice ? `${notice} ` : ''}The server could not confirm revocation; sign in again to replace it.` }
            : current,
        );
      });
    }
  }, []);

  useEffect(() => {
    setApiResponseObserver((response) => {
      if (response.headers.get('x-uat-admission')) end('UAT access is no longer valid. Sign in again.', false);
    });
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('hro-uat-admission');
      channel.current.onmessage = () => end('UAT was exited in another tab. Sign in again.', false);
    }
    return () => {
      setApiResponseObserver(null);
      channel.current?.close();
      channel.current = null;
    };
  }, [end]);

  const recheck = useCallback(() => setAttempt((value) => value + 1), []);
  const value = useMemo(() => ({ status, admit, end, recheck }), [status, admit, end, recheck]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

const POLL_MS = 20_000;
const MAX_TIMEOUT = 2_147_000_000;

/**
 * Mounts protected content only for one server-validated admission. It owns a
 * separate QueryClient, polls live validity, and fails closed on any change.
 */
export function AdmittedBoundary({ admission, children }: { admission: UatAdmission; children: ReactNode }) {
  const { end } = useAdmissionHost();
  const { isLoaded, userId, sessionId } = useAuth();
  const endRef = useRef(end);
  endRef.current = end;
  const [client] = useState(() => {
    pinOrganizationIdForPage(admission.organizationId);
    return new QueryClient();
  });

  useEffect(() => () => {
    void client.cancelQueries();
    client.clear();
  }, [client]);

  useEffect(() => {
    let active = true;
    const lost = (message: string) => {
      if (!active) return;
      active = false;
      void client.cancelQueries();
      client.clear();
      endRef.current(message, false);
    };
    const check = () => {
      getUatAdmission()
        .then((live) => {
          if (live.organizationId !== admission.organizationId || live.userId !== admission.userId || live.sessionId !== admission.sessionId) {
            lost('Your UAT identity or workspace changed. Sign in again.');
          }
        })
        .catch(() => lost('Your UAT admission could not be confirmed and was closed. Sign in again.'));
    };
    const interval = window.setInterval(check, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    const remaining = new Date(admission.expiresAt).getTime() - Date.now();
    const timeout = window.setTimeout(
      () => lost('Your 30-minute UAT admission expired. Sign in again.'),
      Number.isFinite(remaining) ? Math.min(Math.max(remaining, 0), MAX_TIMEOUT) : 0,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [admission, client]);

  useEffect(() => {
    if (isLoaded && (userId !== admission.userId || sessionId !== admission.sessionId)) {
      void client.cancelQueries();
      client.clear();
      endRef.current('The signed-in identity changed. Sign in again.', false);
    }
  }, [isLoaded, userId, sessionId, admission.userId, admission.sessionId, client]);

  return (
    <AdmissionContext.Provider value={admission}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AdmissionContext.Provider>
  );
}
