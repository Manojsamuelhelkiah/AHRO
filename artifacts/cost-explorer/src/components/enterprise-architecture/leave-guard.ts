export const LEAVE_WARNING = "This assessment has unsaved edits. Drafts are kept only in this open workspace, not stored in your browser. Leave and lose them?";

/** No draft content is persisted. Covers router navigation as well as reload/close. */
export function installLeaveGuard(target: Window, isDirty: () => boolean) {
  const history = target.history;
  const push = history.pushState;
  const replace = history.replaceState;
  let currentUrl = target.location.href;
  let currentState = history.state;
  const allowed = (url: string) =>
    url === currentUrl || !isDirty() || target.confirm(LEAVE_WARNING);
  const remember = () => {
    currentUrl = target.location.href;
    currentState = history.state;
  };
  const wrap = (original: History["pushState"]): History["pushState"] =>
    function (data, unused, url) {
      const destination = url == null ? currentUrl : new URL(url, currentUrl).href;
      if (!allowed(destination)) return;
      original.call(history, data, unused, url);
      remember();
    };
  const guardedPush = wrap(push);
  const guardedReplace = wrap(replace);
  history.pushState = guardedPush;
  history.replaceState = guardedReplace;

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const pop = (event: PopStateEvent) => {
    if (!allowed(target.location.href)) {
      // Capture runs before wouter's useSyncExternalStore listener, which can
      // synchronously unmount this provider (and remove the guard) otherwise.
      event.stopImmediatePropagation();
      push.call(history, currentState, "", currentUrl);
    } else remember();
  };
  target.addEventListener("beforeunload", beforeUnload);
  target.addEventListener("popstate", pop, true);
  return () => {
    if (history.pushState === guardedPush) history.pushState = push;
    if (history.replaceState === guardedReplace) history.replaceState = replace;
    target.removeEventListener("beforeunload", beforeUnload);
    target.removeEventListener("popstate", pop, true);
  };
}

// Install before React subscribes to history. A workspace-owned popstate
// listener can be removed by a synchronous router commit in the SAME event.
// Only the active workspace's check is registered; no draft content is held here.
const checks = new Set<() => boolean>();
const removeGuard = typeof window === "undefined" ? undefined
  : installLeaveGuard(window, () => [...checks].some(check => check()));
if (import.meta.hot) import.meta.hot.dispose(() => removeGuard?.());

export function registerLeaveProtection(check: () => boolean) {
  checks.add(check);
  return () => { checks.delete(check); };
}