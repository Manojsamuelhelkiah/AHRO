import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";

const nodeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  const timer = nodeSetTimeout(handler, timeout, ...args);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}) as typeof setTimeout;

export const testWindow = new Window({
  url: "https://onboarding.test/cases",
});

const channels: NodeMessageChannel[] = [];

class TestMessageChannel extends NodeMessageChannel {
  constructor() {
    super();
    this.port1.unref();
    this.port2.unref();
    channels.push(this);
  }
}

const globals: Record<string, unknown> = {
  window: testWindow,
  document: testWindow.document,
  location: testWindow.location,
  history: testWindow.history,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  HTMLButtonElement: testWindow.HTMLButtonElement,
  HTMLFormElement: testWindow.HTMLFormElement,
  HTMLInputElement: testWindow.HTMLInputElement,
  HTMLSelectElement: testWindow.HTMLSelectElement,
  HTMLTextAreaElement: testWindow.HTMLTextAreaElement,
  Node: testWindow.Node,
  NodeFilter: testWindow.NodeFilter,
  Element: testWindow.Element,
  SVGElement: testWindow.SVGElement,
  Document: testWindow.Document,
  DocumentFragment: testWindow.DocumentFragment,
  Text: testWindow.Text,
  MutationObserver: testWindow.MutationObserver,
  Event: testWindow.Event,
  CustomEvent: testWindow.CustomEvent,
  MouseEvent: testWindow.MouseEvent,
  FocusEvent: testWindow.FocusEvent,
  KeyboardEvent: testWindow.KeyboardEvent,
  FormData: testWindow.FormData,
  File: testWindow.File,
  Blob: testWindow.Blob,
  MessageChannel: TestMessageChannel,
  getComputedStyle: testWindow.getComputedStyle.bind(testWindow),
  addEventListener: testWindow.addEventListener.bind(testWindow),
  removeEventListener: testWindow.removeEventListener.bind(testWindow),
  dispatchEvent: testWindow.dispatchEvent.bind(testWindow),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(testWindow.performance.now()), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
};

for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function eventually(
  assertion: () => void,
  message: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error(
    `${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function disposeCasesDom(): void {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  // Abort pending DOM tasks without waiting for a browser-page close. React's
  // passive effects can otherwise leave happy-dom's completion promise open.
  void testWindow.happyDOM.abort();
}