import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";

export const testWindow = new Window({
  url: "https://onboarding.test/settings/members",
});

const channels: NodeMessageChannel[] = [];

class TestMessageChannel extends NodeMessageChannel {
  constructor() {
    super();
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
  Element: testWindow.Element,
  SVGElement: testWindow.SVGElement,
  Document: testWindow.Document,
  DocumentFragment: testWindow.DocumentFragment,
  Text: testWindow.Text,
  MutationObserver: testWindow.MutationObserver,
  Event: testWindow.Event,
  MouseEvent: testWindow.MouseEvent,
  FocusEvent: testWindow.FocusEvent,
  KeyboardEvent: testWindow.KeyboardEvent,
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

export async function disposeOrganizationMembersDom() {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  await testWindow.happyDOM.close();
}