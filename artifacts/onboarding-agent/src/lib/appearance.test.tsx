import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { act, useState } from 'react';
import { APPEARANCE_KEY, currentTheme, isTheme, setTheme, useAppearance } from './appearance';

const startup = readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
function initialize(saved: string | null, pathname = '/', blocked = false, base = '/') {
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  let key: string | undefined;
  vm.runInNewContext(startup.replace('%BASE_URL%', base), {
    location: { pathname },
    document: { documentElement: { dataset, style } },
    localStorage: { getItem(k: string) { key = k; if (blocked) throw new Error('denied'); return saved; } },
  });
  return { dataset, style, key };
}

test('pre-paint startup defaults safely and uses only the artifact preference', () => {
  for (const saved of [null, '', 'dark', 'MIDNIGHT', '__proto__']) {
    assert.equal(initialize(saved).dataset.controlTowerTheme, 'classic');
  }
  assert.equal(initialize('midnight', '/', true).dataset.controlTowerTheme, 'classic');
  for (const theme of ['classic', 'vibrant', 'midnight']) {
    const result = initialize(theme, '/cases/123');
    assert.equal(result.dataset.controlTowerTheme, theme);
    assert.equal(result.key, APPEARANCE_KEY);
    assert.equal(result.style.colorScheme, theme === 'midnight' ? 'dark' : 'light');
  }
});

test('candidate presentation does not read or inherit staff appearance, including a base path', () => {
  for (const [pathname, base] of [['/candidate', '/'], ['/tower/candidate', '/tower/']]) {
    const result = initialize('midnight', pathname, false, base);
    assert.equal(result.dataset.controlTowerTheme, undefined);
    assert.equal(result.key, undefined);
    assert.equal(result.style.colorScheme, undefined);
  }
});

test('switching only changes appearance, preserves mounted edits and handles denied storage', async () => {
  const window = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window, document: window.document, localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  function BusinessPage() {
    const theme = useAppearance();
    const [draft, update] = useState('unsubmitted draft');
    return <><output>{theme}</output><button onClick={() => update('edited draft')}>{draft}</button></>;
  }
  try {
    window.document.documentElement.dataset.controlTowerTheme = 'classic';
    window.localStorage.setItem('activeOrganizationId', 'untouched-client');
    window.localStorage.setItem('other-artifact:theme', 'untouched-theme');
    await act(async () => root.render(<BusinessPage />));
    const button = host.querySelector('button')!;
    await act(async () => button.click());
    await act(async () => setTheme('midnight'));
    assert.equal(host.querySelector('button'), button);
    assert.equal(button.textContent, 'edited draft');
    assert.equal(host.querySelector('output')?.textContent, 'midnight');
    assert.equal(window.localStorage.getItem(APPEARANCE_KEY), 'midnight');
    assert.equal(window.localStorage.getItem('activeOrganizationId'), 'untouched-client');
    assert.equal(window.localStorage.getItem('other-artifact:theme'), 'untouched-theme');
    assert.equal(window.document.documentElement.style.colorScheme, 'dark');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    await act(async () => setTheme('vibrant'));
    assert.equal(currentTheme(), 'vibrant');
    assert.equal(host.querySelector('output')?.textContent, 'vibrant');
    window.document.documentElement.removeAttribute('data-control-tower-theme');
    await act(async () => setTheme('midnight'));
    assert.equal(window.document.documentElement.hasAttribute('data-control-tower-theme'), false);
    assert.equal(isTheme('invalid'), false);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
