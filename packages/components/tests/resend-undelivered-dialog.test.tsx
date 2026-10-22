// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider as JotaiProvider, createStore } from 'jotai';
import {
  getSessionRoomId,
  type MachineId,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { MessageRowView } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { buildResendInputBlocks } from '../src/lib/undelivered-user-turn';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'session-not-delivered-dialog' as SessionId;
const missingTurnId = 'user-turn-missing-dialog';

const markerMeta = {
  id: sessionId,
  machineId: 'machine-1' as MachineId,
  userId: 'user-1',
  createdAt: '2026-08-19T09:00:00.000Z',
  cliType: 'builtin',
  agentType: 'codex',
  status: { type: 'idle' as const },
  latestUserMsgId: missingTurnId,
  lastMissingHistoryUserMsgId: missingTurnId,
} satisfies SessionMeta;

const undeliveredMessage = {
  id: missingTurnId,
  role: 'user',
  userId: 'user-1',
  timestamp: '2026-08-19T09:00:00.000Z',
  read: false,
  status: 'pending',
  items: [{ type: 'text', text: 'resend me from the dialog' }],
  inputConfig: {
    prompt: 'resend me from the dialog',
    inputBlocks: [{ type: 'text', text: 'resend me from the dialog' }],
  },
} as unknown as SessionHistoryParsed;

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const queryBodyButton = (text: string): HTMLButtonElement => {
  const button = [...document.body.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) {
    throw new Error(`No button containing "${text}" rendered`);
  }
  return button;
};

describe('UserMessageRowView undelivered resend dialog', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  const renderRow = async (
    onResendUndelivered: (userTurnId: string, inputBlocks: unknown) => Promise<boolean>,
    message = undeliveredMessage
  ) => {
    const store = createStore();
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: markerMeta });
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          { store },
          createElement(MessageRowView, {
            message,
            sessionId,
            onResendUndelivered,
          })
        )
      );
    });
  };

  it('opens a confirmation dialog from the label and resends the exact content on confirm', async () => {
    const onResendUndelivered = vi.fn(async () => true);
    await renderRow(onResendUndelivered);

    await click(queryBodyButton('Not delivered'));
    expect(document.body.textContent).toContain('Message not delivered');
    expect(document.body.textContent).toContain('did not run');

    await click(queryBodyButton('Resend message'));
    expect(onResendUndelivered).toHaveBeenCalledTimes(1);
    expect(onResendUndelivered).toHaveBeenCalledWith(
      missingTurnId,
      buildResendInputBlocks(undeliveredMessage)
    );
    // The dialog closed after the action.
    expect(document.body.textContent).not.toContain('did not run');
  });

  it('cancels without resending', async () => {
    const onResendUndelivered = vi.fn(async () => true);
    await renderRow(onResendUndelivered);

    await click(queryBodyButton('Not delivered'));
    expect(document.body.textContent).toContain('Message not delivered');

    await click(queryBodyButton('Cancel'));
    expect(onResendUndelivered).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('did not run');
  });

  it.each([
    ['en', 'Outcome unknown', 'may already have acted', 'Cancel', 'Resend message'],
    ['zh_CN', '执行结果未知', '可能已经执行', '取消', '重新发送上一条消息'],
  ] as const)('confirms unknown ordinary-turn resend in %s', async (locale, label, warning, cancel, resend) => {
    await initI18n(locale);
    const submissions: unknown[] = [];
    await renderRow(async (id, blocks) => {
      submissions.push({ id, blocks });
      return true;
    }, { ...undeliveredMessage, status: 'delivery_unknown', read: true });
    await click(queryBodyButton(label));
    expect(document.body.textContent).toContain(warning);
    expect(document.body.textContent).not.toContain('did not run');
    expect(submissions).toEqual([]);
    await click(queryBodyButton(cancel));
    expect(submissions).toEqual([]);
    await click(queryBodyButton(label));
    await click(queryBodyButton(resend));
    expect(submissions).toEqual([{ id: missingTurnId, blocks: buildResendInputBlocks(undeliveredMessage) }]);
    expect(document.body.textContent).not.toContain(warning);
  });

  it.each([
    ['en', 'Previous attempt ended; outcome unknown', 'Failed before the agent could start'],
    ['zh_CN', '上次尝试已结束，执行结果未知', 'Agent 启动前失败'],
  ] as const)('renders accurate restart notice in %s', async (locale, title, falseTitle) => {
    await initI18n(locale);
    await renderRow(async () => false, {
      id: 'interrupted-notice', role: 'system', timestamp: '2026-10-23T00:00:00Z',
      items: [{ type: 'system_notice', name: 'chat_failed', meta: {
        reason: 'turn_outcome_unknown', message: 'Work may already have happened; sending it again could repeat work.',
      } }],
    } as SessionHistoryParsed);
    expect(container?.textContent).toContain(title);
    expect(container?.textContent).toContain('could repeat work');
    expect(container?.textContent).not.toContain(falseTitle);
  });

  it('keeps the label non-interactive without a resend handler', async () => {
    const store = createStore();
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: markerMeta });
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          { store },
          createElement(MessageRowView, { message: undeliveredMessage, sessionId })
        )
      );
    });

    const labelButton = [...document.body.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Not delivered')
    );
    expect(labelButton).toBeUndefined();
    expect(container?.textContent).toContain('Not delivered');
  });
});
