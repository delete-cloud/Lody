// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import type { PlatformE2eeWorkspaces, PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceAdmissionGate } from '../src/components/workspace-admission-gate';
import { userAtom } from '../src/atoms';
import { developerModeEnabledAtom, e2eeWorkspaceCreationEnabledAtom } from '../src/atoms/settings';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import {
  workspaceModeAdmissionRetryAtom,
  workspaceRuntimeInitFailureAtom,
  type WorkspaceRuntimeInitFailure,
} from '../src/atoms/runtime';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const platform: PlatformProvider = {
  ...TEST_CLOUD_PLATFORM,
  e2eeWorkspaces: {} as PlatformE2eeWorkspaces,
};

describe('WorkspaceAdmissionGate', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;

  const render = () =>
    act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <WorkspaceAdmissionGate workspaceName="alpha">
              <div>workspace content</div>
            </WorkspaceAdmissionGate>
          </Provider>
        </PlatformContext.Provider>
      );
    });
  const fail = (failure: Omit<WorkspaceRuntimeInitFailure, 'workspaceSlug'>) =>
    store.set(workspaceRuntimeInitFailureAtom, { workspaceSlug: 'alpha', ...failure });
  const text = () => container.textContent ?? '';

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await initI18n('en');
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
    store.set(userAtom, { id: 'account' } as never);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders an ordinary workspace under a provisional verdict without mentioning encryption', async () => {
    store.set(workspaceContentModeAtom, {
      accountId: 'account',
      workspaceSlug: 'alpha',
      workspaceId: null,
      descriptor: null,
    });
    await render();
    expect(text()).toBe('workspace content');
  });

  it('waits with the ordinary loading copy while the verdict is unknown', async () => {
    await render();
    expect(text()).toContain('Loading workspace');
    expect(text()).not.toMatch(/encrypt|mode/i);
  });

  it.each([
    ['a mode failure of an ordinary workspace', { modeAdmission: { knownEncrypted: false } }],
    ['a runtime failure unrelated to mode', {}],
  ] as const)('shows the ordinary open failure for %s', async (_case, extra) => {
    fail({ errorType: 'WorkspaceModeAdmissionTimeoutError', ...extra });
    await render();
    expect(text()).toContain('Unable to open workspace');
    expect(text()).not.toMatch(/encrypt|mode/i);
  });

  it('explains a mode failure for a workspace known to be encrypted', async () => {
    fail({
      errorType: 'WorkspaceModeAdmissionTimeoutError',
      modeAdmission: { knownEncrypted: true },
    });
    await render();
    expect(text()).toContain('Workspace mode could not be verified');
  });

  it('explains mode failures only to a developer who enabled encrypted creation', async () => {
    store.set(developerModeEnabledAtom, true);
    store.set(e2eeWorkspaceCreationEnabledAtom, true);
    fail({ errorType: 'Error', modeAdmission: { knownEncrypted: false } });
    await render();
    expect(text()).toContain('Workspace mode could not be verified');

    // A rejected shutdown of the previous runtime is not a mode failure.
    await act(async () => fail({ errorType: 'Error' }));
    expect(text()).toContain('Unable to open workspace');
  });

  it('retries in place from the failure screen', async () => {
    fail({ errorType: 'Error', modeAdmission: { knownEncrypted: false } });
    await render();
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    );
    await act(async () => retry?.click());
    expect(store.get(workspaceModeAdmissionRetryAtom)).toBe(1);
  });
});
