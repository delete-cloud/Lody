import { join } from 'node:path';
import { updateTestHistory } from './history-port-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { createSessionMirror, type HistoryWriter } from '@lody/shared';
import { createLoroSessionData, readSessionHistory } from '@lody/shared/session-data';

const readSessionHistoryFromReplica = (doc: LoroDoc, writer: HistoryWriter) => {
  const data = createLoroSessionData({ doc, sessionId: 'read-replica' as SessionId, writer });
  try {
    return readSessionHistory(data.history);
  } finally {
    data.dispose();
  }
};
import { toSessionTranscriptEntries } from '../src/commands/session';
import { buildSessionArtifacts } from '../src/lib/session-export';

import type {
  ACPSessionId,
  AcpSessionNotification,
  SessionHistoryInput,
  SessionId,
  WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionDispatchSource } from '../src/session/session-execution-service';
import { DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS } from '../src/session/turn-history-gate';
import type { Logger } from '../src/utils/logger';
import { loadEnv } from '../src/utils/const';
import { createTestCloudPort } from './test-cloud-port';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type {
  UploadedSessionFile,
  ValidatedUploadFile,
} from '../src/lib/session-attachment-transfer';
import type { AgentClient, AgentSessionWarning } from '../src/agent/agent-client';
import type {
  AcpSessionConfigTarget,
  AcpSessionRunConfig,
} from '../src/session/acp-session-config-applier';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

type MessageHandlerHost = {
  applyAcpModeAndModel(
    session: AcpSessionConfigTarget,
    config: AcpSessionRunConfig,
    context: { sessionDoc: SessionDocument }
  ): Promise<void>;
  recordChatFailure(
    sessionDoc: SessionDocument,
    reason: 'agent_disconnected',
    message?: string
  ): Promise<void>;
  handleSessionFileUpload(
    message: { type: 'session/file-upload'; sessionId: SessionId; paths: string[] },
    context: { source: 'local'; send(response: unknown): void }
  ): Promise<void>;
  appendAssistantFileBlocksToActiveTurn(...args: unknown[]): Promise<boolean>;
  resolveSessionWorkspaceRoot(sessionId: SessionId): string | null;
  validateSessionFileUploadPath(...args: unknown[]): Promise<ValidatedUploadFile>;
  uploadValidatedSessionFile(...args: unknown[]): Promise<UploadedSessionFile>;
  createAssistantImageGroupEntry(args: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
  }): Promise<string>;
  recordAgentWarning(sessionId: SessionId, warning: AgentSessionWarning): Promise<void>;
  appendACPUpdatesToAssistantEntry(...args: unknown[]): Promise<void>;
  flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
  handleAgentPermissionRequest(
    sessionId: SessionId,
    requestId: string,
    request: RequestPermissionRequest,
    model: undefined,
    client: Pick<AgentClient, 'getAutomaticToolPermissionOutcome' | 'subscribeConfigOptions'>
  ): Promise<RequestPermissionResponse>;
  beginConversationTurn(
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: { dispatchSource?: SessionDispatchSource; sessionDoc: SessionDocument }
  ): string;
  enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
  store: { clearTurnState(sessionId: SessionId): void };
  createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: undefined,
    userTurnId?: string
  ): Promise<void>;
};

// loro-repo resolves create()/destroy() on the real clock (native async), not the
// timers vitest fakes — run repo setup/teardown on real timers (same pattern as
// message-handler-acp-batching.test.ts).
const destroyRepoOnRealTimers = async (repo: LoroRepo) => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

const createHandlerHarness = async (sessionId: SessionId) => {
  const logger = createSilentLogger();
  const fakeTimersActive = vi.isFakeTimers();
  if (fakeTimersActive) {
    vi.useRealTimers();
  }
  const repo = await LoroRepo.create({});
  const doc = new SessionDocument(repo, sessionId, async () => {});
  await doc.initOffline();
  if (fakeTimersActive) {
    vi.useFakeTimers();
  }

  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    registerMachine: vi.fn(),
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({
        meta: { needToArchiveSessions: {}, needToDeleteSessions: {} },
      })),
    },
    getOrCreateSessionDoc: vi.fn(async () => doc),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => null),
  };

  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    logger,
    {
      token: 't',
      workspaceId: 'ws-1' as WorkspaceId,
      userId: 'u-1',
      machineId: 'm-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );

  return { repo, doc, handler: handler as unknown as MessageHandlerHost };
};

const userEntry = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  timestamp: '2026-10-16T00:00:00.000Z',
  read: false,
  userId: 'u-1',
  fileDiff: [],
  items: [{ type: 'text', text: 'hi agent' }] as unknown as SessionHistoryInput['items'],
});

const agentChunk = (sessionId: SessionId, text: string): AcpSessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  },
});

describe('MessageHandler turn history gate (RPC fast path ordering)', () => {
  it.each(['codex', 'claude'])(
    'persists a rejected %s model as a GUI notice after the driving user turn',
    async (agentType) => {
      const sessionId = `model-rejection-${agentType}` as SessionId;
      const { repo, doc, handler } = await createHandlerHarness(sessionId);
      try {
        await updateTestHistory(doc, () => [userEntry('user-model-selection')]);
        handler.beginConversationTurn(sessionId, 'user-model-selection', { sessionDoc: doc });
        const recordWarning = handler.recordAgentWarning.bind(handler);
        let noticeWrite: Promise<void> | undefined;
        vi.spyOn(handler, 'recordAgentWarning').mockImplementation((...args) => {
          noticeWrite = recordWarning(...args);
          return noticeWrite;
        });

        await handler.applyAcpModeAndModel(
          {
            sessionId,
            acpSessionId: 'acp-model-rejection' as ACPSessionId,
            agentClient: {
              isCreated: () => true,
              getConfigOptions: () => [
                { id: 'model', category: 'model', type: 'select', currentValue: 'active-model' },
              ],
              unstable_setSessionModel: async () => {
                throw new Error('Requested model is unavailable');
              },
            } as unknown as AgentClient,
          },
          { agentType, modelId: 'requested-model' },
          { sessionDoc: doc }
        );
        expect(noticeWrite).toBeDefined();
        await noticeWrite;

        const history = await doc.sessionData.history.readAll();
        expect(history[0]?.id).toBe('user-model-selection');
        const notice = history.find((entry) => entry.role === 'system');
        expect(notice?.items).toEqual([
          expect.objectContaining({
            type: 'system_notice',
            name: 'agent_warning',
            meta: {
              source: 'configWarning',
              message: expect.stringContaining('model="requested-model"'),
            },
          }),
        ]);
      } finally {
        await destroyRepoOnRealTimers(repo);
      }
    }
  );

  it.each([false, true, 'write-failure', 'new-turn'] as const)(
    'drains text before a permission tool (buffered tool: %s)',
    async (includeTool) => {
      // This path exercises real LoroRepo writes. Native async completion does
      // not use Vitest's fake clock and can be starved on a loaded CI runner.
      vi.useRealTimers();
      const sessionId = 'permission-order' as SessionId;
      const { repo, doc, handler } = await createHandlerHarness(sessionId);
      try {
        await updateTestHistory(doc, () => [userEntry('user-permission')]);
        const turnId = handler.beginConversationTurn(sessionId, 'user-permission');
        await handler.createAssistantEntryForTurn(
          sessionId,
          doc,
          turnId,
          undefined,
          'user-permission'
        );
        handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'The first '));
        await handler.flushACPUpdatesNow(sessionId);
        handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'sentence.'));
        const failedWrite =
          includeTool === 'write-failure'
            ? vi
                .spyOn(handler, 'appendACPUpdatesToAssistantEntry')
                .mockRejectedValue(new Error('storage unavailable'))
            : undefined;
        const toolCall = {
          toolCallId: 'read-1',
          title: 'Read',
          kind: 'read' as const,
          status: 'pending' as const,
        };
        if (includeTool && includeTool !== 'new-turn')
          handler.enqueueACPUpdate(sessionId, {
            sessionId,
            update: { sessionUpdate: 'tool_call', ...toolCall },
          });
        if (includeTool === 'new-turn') {
          const drain = handler.flushACPUpdatesNow.bind(handler);
          vi.spyOn(handler, 'flushACPUpdatesNow').mockImplementationOnce(async (id) => {
            await drain(id);
            await updateTestHistory(doc, (history) => [...history, userEntry('next-user')]);
            const next = handler.beginConversationTurn(sessionId, 'next-user');
            await handler.createAssistantEntryForTurn(sessionId, doc, next, undefined, 'next-user');
          });
        }
        const outcome = { outcome: 'selected' as const, optionId: 'allow' };
        const result = await handler.handleAgentPermissionRequest(
          sessionId,
          'permission-1',
          {
            sessionId,
            toolCall,
            options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }],
          },
          undefined,
          {
            getAutomaticToolPermissionOutcome: () => outcome,
            subscribeConfigOptions: () => () => {},
          }
        );
        if (includeTool === 'new-turn') {
          expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
          const history = await doc.sessionData.history.readAll();
          expect(history.at(-1)?.items).toEqual([]);
          expect(history[1]?.items).toEqual([{ type: 'text', text: 'The first sentence.' }]);
          return;
        }
        if (failedWrite) {
          expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
          const beforeRetry = await doc.sessionData.history.readAll();
          expect(beforeRetry[1]?.items).toEqual([{ type: 'text', text: 'The first ' }]);
          failedWrite.mockRestore();
          await handler.flushACPUpdatesNow(sessionId);
          const afterRetry = await doc.sessionData.history.readAll();
          expect(afterRetry[1]?.items).toMatchObject([
            { type: 'text', text: 'The first sentence.' },
            { type: 'tool_call', toolCallId: 'read-1' },
          ]);
          return;
        }
        expect(result).toEqual({ outcome });
        handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'A separate answer.'));
        await handler.flushACPUpdatesNow(sessionId);
        const history = await doc.sessionData.history.readAll();
        expect(history[1]?.items).toMatchObject([
          { type: 'text', text: 'The first sentence.' },
          {
            type: 'tool_call',
            toolCallId: 'read-1',
            permissionRequest: { requestId: 'permission-1', outcome },
          },
          { type: 'text', text: 'A separate answer.' },
        ]);
      } finally {
        await destroyRepoOnRealTimers(repo);
      }
    }
  );

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it('holds RPC-turn output until the user entry syncs, then orders it after the user entry', async () => {
    const sessionId = 's-gate-1' as SessionId;
    const userTurnId = 'user-turn-1';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      expect(turnId).toBe(`assistant:${userTurnId}`);

      // The eager assistant-entry creation (execution service does this before
      // the prompt) must defer while the user entry is missing locally.
      await handler.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      expect(await doc.sessionData.history.readAll()).toHaveLength(0);

      // Streamed output arrives and the batch window elapses — still nothing
      // may be persisted ahead of the user entry.
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'hello'));
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, ' world'));
      await vi.advanceTimersByTimeAsync(200);
      expect(await doc.sessionData.history.readAll()).toHaveLength(0);

      // The user entry syncs in (as the web client's CRDT write would land).
      await updateTestHistory(doc, (history) => [...history, userEntry(userTurnId)]);
      await vi.advanceTimersByTimeAsync(200);

      const history = await doc.sessionData.history.readAll();
      expect(history.map((entry) => [entry.role, entry.id])).toEqual([
        ['user', userTurnId],
        ['assistant', turnId],
      ]);
      const items = history[1]?.items as unknown as Array<{ type: string; text: string }>;
      expect(items).toEqual([{ type: 'text', text: 'hello world' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('releases output after the gate timeout when the user entry never syncs', async () => {
    const sessionId = 's-gate-2' as SessionId;
    const userTurnId = 'user-turn-2';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'stalled sync'));
      await vi.advanceTimersByTimeAsync(200);
      expect(await doc.sessionData.history.readAll()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS);

      const history = await doc.sessionData.history.readAll();
      expect(history.map((entry) => [entry.role, entry.id])).toEqual([['assistant', turnId]]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it.each([
    'stream',
    'restart',
    'chat-failed',
    'agent-warning',
    'file',
    'image',
    'dispose',
    'dispose-notice',
    'dispose-warning',
    'supersede',
    'file-restart',
  ] as const)('repairs late replica sync for %s', async (path) => {
    const clearTurn = path === 'restart';
    const sessionId = `s-gate-replicas-${path}` as SessionId;
    const userTurnId = 'late-user';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);
    const daemon = doc.handle?.doc;
    if (!daemon) throw new Error('Missing real session document');
    daemon.setPeerId('1');
    const client = new LoroDoc();
    client.import(daemon.export({ mode: 'snapshot' }));
    client.setPeerId('2');
    const clientMirror = createSessionMirror({ doc: client, initialState: {} });
    const storedIds = (replica: LoroDoc) =>
      replica
        .getList('history')
        .toJSON()
        .map((entry: { id: string }) => entry.id);
    try {
      clientMirror.historyWriter.append(userEntry(userTurnId));
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      const pendingNotice =
        path === 'dispose-notice'
          ? handler.recordChatFailure(doc, 'agent_disconnected', 'synthetic failure')
          : path === 'dispose-warning'
            ? handler.recordAgentWarning(sessionId, { message: 'synthetic warning' })
            : undefined;
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'before sync'));
      if (['dispose', 'dispose-notice', 'dispose-warning', 'supersede'].includes(path)) {
        if (path === 'supersede') handler.beginConversationTurn(sessionId, 'next-user');
        else handler.store.clearTurnState(sessionId);
        await vi.advanceTimersByTimeAsync(200);
        await pendingNotice;
      } else {
        await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS + 200);
      }
      if (path === 'chat-failed')
        await handler.recordChatFailure(doc, 'agent_disconnected', 'synthetic failure');
      if (path === 'agent-warning')
        await handler.recordAgentWarning(sessionId, { message: 'synthetic warning' });
      if (path === 'image')
        await handler.createAssistantImageGroupEntry({ sessionId, sessionDoc: doc });
      if (path === 'file' || path === 'file-restart') {
        const workspaceRoot = process.cwd();
        const filePath = join(workspaceRoot, 'result.txt');
        vi.spyOn(handler, 'appendAssistantFileBlocksToActiveTurn').mockResolvedValue(false);
        vi.spyOn(handler, 'resolveSessionWorkspaceRoot').mockReturnValue(workspaceRoot);
        vi.spyOn(handler, 'validateSessionFileUploadPath').mockResolvedValue({
          absolutePath: filePath,
          fileName: 'result.txt',
          mimeType: 'text/plain',
          sizeBytes: 1,
          sha256: 'a'.repeat(64),
          textPreview: true,
        });
        vi.spyOn(handler, 'uploadValidatedSessionFile').mockImplementation(async () => {
          if (path === 'file-restart') handler.beginConversationTurn(sessionId, 'next-user');
          return {
            type: 'file',
            fileId: 'uploaded-file',
            fileName: 'result.txt',
            mimeType: 'text/plain',
            sizeBytes: 1,
            sha256: 'a'.repeat(64),
            textPreview: true,
            transport: 'r2',
            uploadedAt: Date.parse('2026-10-16T00:00:00.000Z'),
            downloadUrl: 'https://example.test/result.txt',
          };
        });
        const responses: unknown[] = [];
        await handler.handleSessionFileUpload(
          { type: 'session/file-upload', sessionId, paths: [filePath] },
          {
            source: 'local',
            send: (response) => responses.push(response),
          }
        );
        expect(responses).toEqual([
          expect.objectContaining({ success: true, attachedTo: 'new_entry' }),
        ]);
      }
      const beforeSync = doc.sessionData.writer.readStored();
      const associatedRows = beforeSync.filter((row) => row.id !== turnId);
      if (
        [
          'chat-failed',
          'agent-warning',
          'file',
          'file-restart',
          'image',
          'dispose-notice',
          'dispose-warning',
        ].includes(path)
      ) {
        expect(associatedRows).toHaveLength(1);
        expect(associatedRows[0]?.userTurnId).toBe(userTurnId);
      }
      expect(storedIds(daemon)).toContain(turnId);
      const expected = [userTurnId, ...storedIds(daemon)];
      const clientUserContainer = client.getList('history').get(0) as LoroMap;
      if (clearTurn) {
        handler.store.clearTurnState(sessionId);
        handler.beginConversationTurn(sessionId, userTurnId, {
          dispatchSource: 'rpc',
          sessionDoc: doc,
        });
      }
      client.import(daemon.export({ mode: 'snapshot' }));
      expect(storedIds(client)).toEqual([...expected.slice(1), userTurnId]);
      expect(
        readSessionHistoryFromReplica(client, clientMirror.historyWriter).map((row) => row.id)
      ).toEqual(expected);
      daemon.import(client.export({ mode: 'snapshot' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(storedIds(daemon)).toEqual(expected);
      expect(
        doc.sessionData.writer
          .readStored()
          .filter((row) => row.id !== userTurnId && row.id !== turnId)
      ).toEqual(associatedRows);
      expect((daemon.getList('history').get(0) as LoroMap).id).toBe(clientUserContainer.id);
      clientUserContainer.set('inputConfig', { modelId: 'concurrent-model' });
      client.commit();
      client.import(daemon.export({ mode: 'snapshot' }));
      daemon.import(client.export({ mode: 'snapshot' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(storedIds(client)).toEqual(expected);
      expect(storedIds(daemon)).toEqual(storedIds(client));
      expect(readSessionHistory(doc.sessionData.history)[0]?.inputConfig?.modelId).toBe(
        'concurrent-model'
      );
      expect(
        readSessionHistory(doc.sessionData.history).find((row) => row.id === turnId)?.items
      ).toEqual([{ type: 'text', text: 'before sync' }]);
      if (
        ['dispose', 'dispose-notice', 'dispose-warning', 'supersede', 'file-restart'].includes(path)
      )
        handler.beginConversationTurn(sessionId, userTurnId);
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, ' after repair'));
      await vi.advanceTimersByTimeAsync(200);
      handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      await vi.advanceTimersByTimeAsync(0);
      await handler.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, ' after restart'));
      await vi.advanceTimersByTimeAsync(200);
      client.import(daemon.export({ mode: 'snapshot' }));
      expect(storedIds(client)).toEqual(expected);
      expect(
        readSessionHistory(doc.sessionData.history).find((row) => row.id === turnId)?.items
      ).toEqual([{ type: 'text', text: 'before sync after repair after restart' }]);
    } finally {
      handler.store.clearTurnState(sessionId);
      clientMirror.dispose();
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('releases document-owned repair on disposal without changing late imported entries', async () => {
    const sessionId = 's-gate-doc-dispose' as SessionId;
    const { repo, doc, handler } = await createHandlerHarness(sessionId);
    const daemon = doc.handle?.doc;
    if (!daemon) throw new Error('Missing real session document');
    daemon.setPeerId('1');
    const client = new LoroDoc();
    client.import(daemon.export({ mode: 'snapshot' }));
    client.setPeerId('2');
    const clientMirror = createSessionMirror({ doc: client, initialState: {} });
    try {
      clientMirror.historyWriter.append(userEntry('disposed-user'));
      handler.beginConversationTurn(sessionId, 'disposed-user', {
        dispatchSource: 'rpc',
        sessionDoc: doc,
      });
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'retained reply'));
      await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS + 200);
      handler.store.clearTurnState(sessionId);
      await doc.destroy({ preserveStatus: true });
      daemon.import(client.export({ mode: 'snapshot' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(
        daemon
          .getList('history')
          .toJSON()
          .map((entry: { id: string }) => entry.id)
      ).toEqual(['assistant:disposed-user', 'disposed-user']);
      expect(daemon.getList('history').toJSON()[0]?.items).toEqual([
        { type: 'text', text: 'retained reply' },
      ]);
    } finally {
      handler.store.clearTurnState(sessionId);
      clientMirror.dispose();
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('keeps repairing after a late user arrives while a permission response is pending', async () => {
    const sessionId = 's-gate-permission' as SessionId;
    const userTurnId = 'permission-user';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);
    const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
      dispatchSource: 'rpc',
      sessionDoc: doc,
    });
    try {
      await vi.advanceTimersByTimeAsync(DEFAULT_TURN_HISTORY_GATE_TIMEOUT_MS);
      await updateTestHistory(doc, (history) => {
        const assistant = history.find((row) => row.id === turnId);
        if (!assistant) throw new Error('Missing timeout assistant');
        assistant.items = [
          {
            type: 'tool_call',
            toolCallId: 'tool',
            status: 'pending',
            permissionRequest: {
              requestId: 'request',
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
            },
          },
        ];
        return [...history, userEntry(userTurnId)];
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(doc.sessionData.writer.readStored().map((row) => row.id)).toEqual([
        turnId,
        userTurnId,
      ]);
      expect(readSessionHistory(doc.sessionData.history).map((row) => row.id)).toEqual([
        userTurnId,
        turnId,
      ]);
      doc.sessionData.writer.respondPermission('request', {
        outcome: 'selected',
        optionId: 'allow',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(doc.sessionData.writer.readStored().map((row) => row.id)).toEqual([
        userTurnId,
        turnId,
      ]);
      expect(readSessionHistory(doc.sessionData.history)[1]?.items[0]).toMatchObject({
        permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
    } finally {
      handler.store.clearTurnState(sessionId);
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('reads a historical inversion in causal order through the CLI/MCP transcript boundary', async () => {
    const sessionId = 's-gate-historical' as SessionId;
    const { repo, doc } = await createHandlerHarness(sessionId);
    const userTurnId = 'historical-user';
    const turnId = `assistant:${userTurnId}`;
    try {
      await updateTestHistory(doc, () => [
        { ...userEntry(turnId), role: 'assistant', items: [{ type: 'text', text: 'reply' }] },
        userEntry(userTurnId),
      ]);
      expect(doc.sessionData.writer.readStored().map((entry) => entry.id)).toEqual([
        turnId,
        userTurnId,
      ]);
      const history = readSessionHistory(doc.sessionData.history);
      expect(buildSessionArtifacts(history).transcript.map((entry) => entry.turnId)).toEqual([
        userTurnId,
        turnId,
      ]);
      expect(toSessionTranscriptEntries(history).map((entry) => entry.id)).toEqual([
        userTurnId,
        turnId,
      ]);
      expect(doc.sessionData.writer.readStored().map((entry) => entry.id)).toEqual([
        turnId,
        userTurnId,
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('does not gate turns dispatched from local history (crdt source)', async () => {
    const sessionId = 's-gate-3' as SessionId;
    const userTurnId = 'user-turn-3';
    const { repo, doc, handler } = await createHandlerHarness(sessionId);

    try {
      await updateTestHistory(doc, (history) => [...history, userEntry(userTurnId)]);
      const turnId = handler.beginConversationTurn(sessionId, userTurnId, {
        dispatchSource: 'crdt',
        sessionDoc: doc,
      });
      await handler.createAssistantEntryForTurn(sessionId, doc, turnId, undefined, userTurnId);
      handler.enqueueACPUpdate(sessionId, agentChunk(sessionId, 'immediate'));
      await vi.advanceTimersByTimeAsync(20);

      const history = await doc.sessionData.history.readAll();
      expect(history.map((entry) => [entry.role, entry.id])).toEqual([
        ['user', userTurnId],
        ['assistant', turnId],
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });
});
