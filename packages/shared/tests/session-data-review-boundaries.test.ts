import { it, expect, vi } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { createLoroSessionData, type SessionDataChange } from '../src/session-data';
import { createHistoryWriter } from '../src/history-writer';
import type { SessionId } from '../src/ids';
const sessionId = 'review-boundaries' as SessionId;
const turn = (id: string) => ({
  id,
  role: 'user' as const,
  timestamp: 'synthetic',
  items: [{ type: 'text' as const, text: id }],
  status: 'pending' as const,
});
it('inline legacy rows remain writable without changing their opaque data or siblings', async () => {
  const doc = new LoroDoc(),
    list = doc.getList('history');
  list.insert(0, {
    ...turn('old'),
    items: [{ type: 'future_item', payload: 'keep' }],
    future: { x: 1 },
  });
  list.insert(1, turn('other'));
  doc.commit();
  const writer = createHistoryWriter(doc),
    data = createLoroSessionData({ doc, sessionId, writer });
  const sibling = list.get(1);
  await data.commands.applyHistoryAction({
    kind: 'user-status',
    turnId: 'old',
    status: 'processing',
  });
  expect(list.get(0)).toMatchObject({
    status: 'processing',
    read: true,
    items: [{ type: 'future_item', payload: 'keep' }],
    future: { x: 1 },
  });
  writer.setField('old', 'read', undefined);
  expect(list.get(0)).not.toHaveProperty('read');
  writer.replace('old', { ...writer.read('old')!, status: 'handled' });
  expect(list.get(0)).toMatchObject({ status: 'handled' });
  writer.update((rows) => {
    rows[0]!.status = 'seen';
    return rows;
  });
  expect(list.get(0)).toMatchObject({ status: 'seen' });
  expect(list.get(1)).toEqual(sibling);
  const before = doc.toJSON();
  expect(() => writer.updateEntry('old', (row) => ({ ...row, status: 'bad' as never }))).toThrow();
  expect(doc.toJSON()).toEqual(before);
  const reopened = new LoroDoc();
  reopened.import(doc.export({ mode: 'snapshot' }));
  expect(reopened.toJSON()).toEqual(before);
});
it('body reads reuse a shallow ID index and follow duplicate, renamed and shifted IDs', async () => {
  const doc = new LoroDoc(),
    writer = createHistoryWriter(doc);
  for (let n = 0; n < 128; n++) writer.append(turn(`t${n}`));
  const data = createLoroSessionData({ doc, sessionId, writer });
  await data.history.readTurn('t0');
  const get = vi.spyOn(LoroList.prototype, 'get');
  try {
    for (let n = 0; n < 128; n++) {
      const read = await data.history.readTurn(`t${n}`);
      expect(read).toMatchObject({ state: 'ready', turn: { id: `t${n}` } });
    }
    expect(get.mock.calls.length).toBeLessThan(512);
  } finally {
    get.mockRestore();
  }
  const list = doc.getList('history');
  list.insert(0, turn('head'));
  doc.commit();
  expect(await data.history.readTurn('t0')).toMatchObject({ state: 'ready', turn: { id: 't0' } });
  const map = list.get(1) as LoroMap;
  map.set('id', 'renamed');
  doc.commit();
  expect(await data.history.readTurn('t0')).toEqual({ state: 'missing' });
  expect(await data.history.readTurn('renamed')).toMatchObject({ state: 'ready' });
  list.insert(list.length, { ...turn('head'), items: [{ type: 'text', text: 'newest' }] });
  doc.commit();
  expect(await data.history.readTurn('head')).toMatchObject({
    state: 'ready',
    turn: { items: [{ text: 'newest' }] },
  });
  list.delete(list.length - 1, 1);
  doc.commit();
  expect(await data.history.readTurn('head')).toMatchObject({
    state: 'ready',
    turn: { items: [{ text: 'head' }] },
  });
  data.dispose();
});
it('unknown failure after tail replacement reaches the indeterminate phase', async () => {
  const doc = new LoroDoc(),
    writer = createHistoryWriter(doc);
  writer.append(turn('u'));
  const error = new Error('commit outcome unknown');
  const real = writer.updateWithRollback;
  writer.updateWithRollback = (update) => {
    real(update);
    throw error;
  };
  const data = createLoroSessionData({ doc, sessionId, writer });
  expect(
    await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u',
      expectedForkTurnId: undefined,
      replacement: turn('replacement'),
    })
  ).toEqual({ status: 'indeterminate', cause: error });
  expect(writer.read('replacement')).toBeDefined();
});

it('reuses pending reads while observing uncommitted replacement, duplicates and renames', () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  for (let i = 0; i < 100; i++) writer.append(turn(`t${i}`));
  const data = createLoroSessionData({ doc, sessionId, writer });
  const list = doc.getList('history');
  const read = (id: string) => data.history.readTurn(id);
  const originalFrontiers = doc.frontiers();
  try {
    doc.getMap('session').set('id', 'pending');
    const pending = doc.getPendingTxnLength();
    expect(pending).toBeGreaterThan(0);
    expect(read('t99')).toMatchObject({ state: 'ready', turn: { id: 't99' } });
    const get = vi.spyOn(LoroList.prototype, 'get');
    try {
      for (let i = 0; i < 10; i++)
        expect(read(`t${i}`)).toMatchObject({ state: 'ready', turn: { id: `t${i}` } });
      expect(get.mock.calls.length).toBeLessThan(100);
      expect(doc.getPendingTxnLength()).toBe(pending);
    } finally {
      get.mockRestore();
    }
    list.delete(99, 1);
    list.insert(99, { ...turn('t0'), items: [{ type: 'text', text: 'newest' }] });
    expect(read('t99')).toEqual({ state: 'missing' });
    expect(read('t0')).toMatchObject({ turn: { items: [{ text: 'newest' }] } });
    list.delete(99, 1);
    expect(read('t0')).toMatchObject({ turn: { items: [{ text: 't0' }] } });
    const first = list.get(0) as LoroMap;
    first.set('id', 'renamed');
    expect(read('t0')).toEqual({ state: 'missing' });
    expect(read('renamed')).toMatchObject({ state: 'ready' });
    doc.commit();
    first.set('id', 'next');
    expect(read('next')).toMatchObject({ state: 'ready' });
    doc.commit();
    first.set('id', 'last');
    expect(read('next')).toEqual({ state: 'missing' });
    expect(read('last')).toMatchObject({ state: 'ready' });
    doc.commit();
    // Checkout changes state without reducing oplog opCount.
    doc.checkout(originalFrontiers);
    expect(read('last')).toEqual({ state: 'missing' });
    expect(read('t99')).toMatchObject({ state: 'ready' });
    doc.attach();
    expect(read('last')).toMatchObject({ state: 'ready' });
    const peer = doc.fork();
    try {
      (peer.getList('history').get(0) as LoroMap).set('id', 'remote');
      doc.import(peer.export({ mode: 'update' }));
      expect(read('last')).toEqual({ state: 'missing' });
      expect(read('remote')).toMatchObject({ state: 'ready' });
    } finally {
      peer.free();
    }
  } finally {
    data.dispose();
    doc.free();
  }
});

it('distinguishes turn identity edits from nested IDs and ordinary content changes', async () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  writer.append(turn('first'));
  writer.append(turn('second'));
  const data = createLoroSessionData({ doc, sessionId, writer });
  const changes: SessionDataChange[] = [];
  const observation = data.history.observe((change) => changes.push(change));
  await observation.initial;
  try {
    const map = doc.getList('history').get(1) as LoroMap;
    const nested = map.setContainer('future', new LoroMap());
    nested.set('id', 'nested');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'changed', ids: ['second'] }]);
    nested.set('id', 'nested-renamed');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'changed', ids: ['second'] }]);
    map.set('status', 'seen');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'changed', ids: ['second'] }]);
    map.set('id', 'renamed');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'structure', from: 1, to: 2 }]);
    map.delete('id');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'structure', from: 1, to: 2 }]);
    map.set('id', 'restored');
    doc.commit();
    expect(changes.splice(0)).toEqual([{ kind: 'structure', from: 1, to: 2 }]);
    expect(data.history.readTurn('restored')).toMatchObject({ turn: { id: 'restored' } });
  } finally {
    observation.unsubscribe();
    data.dispose();
    doc.free();
  }
});

it('reads display task summaries without materializing child bodies and loads one exact run on demand', () => {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  const body = 'SYNTHETIC_CHILD_BODY '.repeat(5000);
  writer.append({
    id: 'owner',
    role: 'assistant',
    timestamp: 'synthetic',
    items: ['a', 'b'].map((taskId) => ({
      type: 'subagent_task',
      taskId,
      status: 'in_progress',
      run: {
        sessionId: 'root',
        snapshot: {
          state: 'running',
          support: {
            stream: ['text', 'tool'],
            progress: false,
            cancel: false,
            outputRead: 'none',
          },
        },
        items: [
          {
            type: 'tool_call',
            toolCallId: taskId,
            status: 'completed',
            kind: 'edit',
            content: [{ type: 'diff', path: '/synthetic.txt', oldText: body, newText: body }],
          },
          { type: 'text', text: body + '\nLatest action' },
        ],
      },
    })),
  });
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId, writer });
  const version = doc.oplogVersion().encode();
  const owner = doc.getList('history').get(0) as LoroMap;
  const tasks = owner.get('items') as LoroList;
  const taskA = tasks.get(0) as LoroMap;
  const runA = taskA.get('run') as LoroMap;
  const runB = (tasks.get(1) as LoroMap).get('run') as LoroMap;
  const childrenA = runA.get('items') as LoroList;
  const childrenB = runB.get('items') as LoroList;
  const forbidden = new Set([owner.id, taskA.id, runA.id, runB.id]);
  const json = LoroMap.prototype.toJSON;
  const guard = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function (this: LoroMap) {
    if (forbidden.has(this.id)) throw new Error('eager subtree read');
    return json.call(this);
  });
  const get = LoroList.prototype.get;
  const listGuard = vi
    .spyOn(LoroList.prototype, 'get')
    .mockImplementation(function (this: LoroList, index) {
      if ((this.id === childrenA.id || this.id === childrenB.id) && index === 0)
        throw new Error('offscreen child body was read');
      return get.call(this, index);
    });
  try {
    const read = data.history.readTurnForDisplay('owner');
    expect(read.state).toBe('ready');
    if (read.state !== 'ready') throw new Error('missing display turn');
    expect(read.turn.items).toMatchObject([
      { taskId: 'a', run: { items: [{ type: 'text' }] } },
      { taskId: 'b', run: { items: [{ type: 'text' }] } },
    ]);
    const preview = JSON.stringify(read);
    expect(preview.length).toBeLessThan(3000);
    expect(preview).toContain('Latest action');
    expect(preview).not.toContain(body);
    expect(data.history.readSubagentRun('owner', 'other-root', 'a')).toBeUndefined();
    expect(data.history.readSubagentRun('other-owner', 'root', 'a')).toBeUndefined();
    forbidden.delete(runA.id);
    const run = data.history.readSubagentRun('owner', 'root', 'a');
    expect(run?.items).toHaveLength(2);
    expect(run?.items[1]).toEqual({ type: 'text', text: body + '\nLatest action' });
  } finally {
    guard.mockRestore();
    listGuard.mockRestore();
  }
  expect(data.history.readAll()[0]?.items).toHaveLength(2);
  expect(JSON.stringify(data.history.readAll())).toContain(body);
  expect(doc.oplogVersion().encode()).toEqual(version);
  data.dispose();
});

it('preserves stored extension keys that overlap Object prototype methods in display reads', () => {
  const doc = new LoroDoc();
  const row = doc.getList('history').insertContainer(0, new LoroMap());
  row.set('id', 'owner');
  row.set('role', 'assistant');
  row.set('timestamp', 'synthetic');
  row.set('toString', 'opaque-future-field');
  row.set('constructor', 'opaque-constructor');
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId });
  try {
    expect(data.history.readTurnForDisplay('owner')).toEqual(data.history.readTurn('owner'));
  } finally {
    data.dispose();
  }
});

it('reads causal positions without rewriting raw history and invalidates order on association edits', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ doc, sessionId });
  data.writer.append({ ...turn('assistant:late'), role: 'assistant', userTurnId: 'other' });
  data.writer.append(turn('late'));
  expect(data.history.readDirectory(0, 2).map((row) => row.turnId)).toEqual([
    'assistant:late',
    'late',
  ]);
  const changes: SessionDataChange[] = [];
  const observation = data.history.observe((change) => changes.push(change));
  await observation.initial;
  data.writer.updateEntry('assistant:late', (entry) => ({ ...entry, userTurnId: 'late' }));
  expect(data.history.readDirectory(0, 2).map((row) => [row.position, row.turnId])).toEqual([
    [0, 'late'],
    [1, 'assistant:late'],
  ]);
  expect(changes.at(-1)).toEqual({ kind: 'structure', from: 0, to: 2 });
  const ids = data.history
    .readRange(0, 2)
    .map((read) => (read.state === 'ready' ? read.turn.id : read.state));
  expect(ids).toEqual(['late', 'assistant:late']);
  expect(data.history.readAt(0)).toMatchObject({ state: 'ready', turn: { id: 'late' } });
  expect(data.history.readTurn('assistant:late')).toMatchObject({
    state: 'ready',
    turn: { id: 'assistant:late' },
  });
  expect(data.history.readAll().map((entry) => entry.id)).toEqual(ids);
  expect(data.history.readTurnOutput('late').map((entry) => entry.id)).toEqual(ids);
  expect(data.writer.readStored().map((entry) => entry.id)).toEqual(['assistant:late', 'late']);
  data.writer.updateEntry('assistant:late', (entry) => ({ ...entry, userTurnId: 'other' }));
  expect(data.history.readDirectory(0, 2).map((row) => row.turnId)).toEqual([
    'assistant:late',
    'late',
  ]);
  observation.unsubscribe();
  data.dispose();
  doc.free();
});

it('preserves invalid raw slots in canonical reads without rewriting storage', () => {
  const doc = new LoroDoc();
  const list = doc.getList('history');
  list.insert(0, null);
  list.insert(1, 7);
  list.insert(2, { ...turn('assistant:late'), role: 'assistant' });
  list.insert(3, turn('late'));
  doc.commit();
  const data = createLoroSessionData({ doc, sessionId });
  expect(
    data.history.readAll().map((entry) => (entry && typeof entry === 'object' ? entry.id : entry))
  ).toEqual([null, 7, 'late', 'assistant:late']);
  expect(data.history.readDirectory(0, 4).map((row) => row.turnId)).toEqual([
    undefined,
    undefined,
    'late',
    'assistant:late',
  ]);
  expect(data.history.readAt(0)).toEqual({ state: 'invalid' });
  expect(data.history.count()).toBe(4);
  expect(
    list
      .toJSON()
      .map((entry: unknown) =>
        entry && typeof entry === 'object' ? (entry as { id: string }).id : entry
      )
  ).toEqual([null, 7, 'assistant:late', 'late']);
  data.dispose();
  doc.free();
});

it('invalidates the former causal prefix for every observer when an association disappears', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ doc, sessionId });
  data.writer.append({ ...turn('assistant:late'), role: 'assistant' });
  data.writer.append(turn('late'));
  const changes: SessionDataChange[][] = [[], []];
  const observations = changes.map((events) => data.history.observe((event) => events.push(event)));
  await Promise.all(observations.map((observation) => observation.initial));
  data.writer.updateEntry('late', (entry) => ({ ...entry, role: 'system' }));
  for (const events of changes) expect(events).toEqual([{ kind: 'structure', from: 0, to: 2 }]);
  expect(data.history.readDirectory(0, 2).map((row) => row.turnId)).toEqual([
    'assistant:late',
    'late',
  ]);
  observations.forEach((observation) => observation.unsubscribe());
  data.dispose();
  doc.free();
});

it('reads legacy assistant output through the same id fallback as history ordering', () => {
  const doc = new LoroDoc(),
    writer = createHistoryWriter(doc);
  writer.append({ ...turn('assistant:u'), role: 'assistant' });
  writer.append(turn('u'));
  const data = createLoroSessionData({ doc, sessionId, writer });
  expect(data.history.readTurnOutput('u').map((row) => row.id)).toEqual(['u', 'assistant:u']);
  data.dispose();
});

it.each([false, true])(
  'replaces an inverted editable tail and rolls back with interleaved prefix=%s',
  async (interleaved) => {
    const doc = new LoroDoc(),
      writer = createHistoryWriter(doc);
    const prefix = [
      turn('previous'),
      {
        ...turn('assistant:previous'),
        role: 'assistant' as const,
        userTurnId: 'previous',
        finished: true,
        acpTurnId: 'boundary',
      },
    ];
    const answer = {
      ...turn('assistant:u'),
      role: 'assistant' as const,
      userTurnId: 'u',
      finished: true,
      acpTurnId: 'wrong-boundary',
    };
    const rows = interleaved ? [answer, ...prefix, turn('u')] : [...prefix, answer, turn('u')];
    rows.forEach((row) => writer.append(row));
    const before = writer.readStored();
    const data = createLoroSessionData({ doc, sessionId, writer });
    const result = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u',
      expectedForkTurnId: 'boundary',
      replacement: turn('replacement'),
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('Expected accepted replacement');
    expect(writer.readStored().map((row) => row.id)).toEqual([
      'previous',
      'assistant:previous',
      'replacement',
    ]);
    expect(data.history.readAll().map((row) => row.id)).toEqual([
      'previous',
      'assistant:previous',
      'replacement',
    ]);
    await result.rollback();
    expect(writer.readStored()).toEqual(before);
    data.dispose();
  }
);

it('keeps remote tool edits and permission responses on the same containers during causal reads', () => {
  const daemon = new LoroDoc();
  const data = createLoroSessionData({ doc: daemon, sessionId });
  data.writer.append({
    ...turn('assistant:u'),
    role: 'assistant',
    userTurnId: 'u',
    items: [
      {
        type: 'tool_call',
        toolCallId: 'tool',
        status: 'pending',
        permissionRequest: {
          requestId: 'request',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
    ],
  });
  const peer = new LoroDoc();
  peer.import(daemon.export({ mode: 'snapshot' }));
  const remote = createLoroSessionData({ doc: peer, sessionId });
  const assistant = daemon.getList('history').get(0) as LoroMap;
  const identity = assistant.id;
  remote.writer.append(turn('u'));
  daemon.import(peer.export({ mode: 'snapshot' }));
  expect(data.history.readDirectory(0, 2).map((row) => row.turnId)).toEqual(['u', 'assistant:u']);
  data.writer.updateEntry('assistant:u', (row) => ({ ...row, finished: true }));
  expect(
    remote.writer.respondPermission('request', { outcome: 'selected', optionId: 'allow' })
  ).toBe(true);
  remote.writer.updateEntry('assistant:u', (row) => ({
    ...row,
    items: row.items.map((item) =>
      item.type === 'tool_call' ? { ...item, status: 'completed' as const } : item
    ),
  }));
  daemon.import(peer.export({ mode: 'snapshot' }));
  peer.import(daemon.export({ mode: 'snapshot' }));
  for (const reader of [data.history, remote.history]) {
    expect(reader.readRange(0, 1)).toMatchObject([{ turn: { id: 'u' } }]);
    expect(reader.readRange(1, 2)).toMatchObject([
      {
        turn: {
          id: 'assistant:u',
          finished: true,
          items: [{ status: 'completed', permissionRequest: { outcome: { optionId: 'allow' } } }],
        },
      },
    ]);
    expect(reader.readAll().map((row) => row.id)).toEqual(['u', 'assistant:u']);
  }
  expect((daemon.getList('history').get(0) as LoroMap).id).toBe(identity);
  expect((peer.getList('history').get(0) as LoroMap).id).toBe(identity);
  expect(data.writer.readStored()).toEqual(remote.writer.readStored());
  expect(data.writer.readStored().map((row) => row.id)).toEqual(['assistant:u', 'u']);
  data.dispose();
  remote.dispose();
  daemon.free();
  peer.free();
});

it('extends the causal index during ordinary tail appends without rescanning the prefix', async () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ doc, sessionId });
  const changes: SessionDataChange[] = [];
  const observation = data.history.observe((event) => changes.push(event));
  await observation.initial;
  const get = vi.spyOn(LoroList.prototype, 'get');
  try {
    for (let index = 0; index < 128; index++) data.writer.append(turn(`user-${index}`));
    expect(get.mock.calls.length).toBeLessThan(512);
  } finally {
    get.mockRestore();
  }
  expect(changes).toHaveLength(128);
  expect(data.history.readDirectory(0, 128).map((row) => row.turnId)).toEqual(
    Array.from({ length: 128 }, (_, index) => `user-${index}`)
  );
  data.writer.append({ ...turn('assistant:late'), role: 'assistant' });
  data.writer.append(turn('late'));
  expect(data.history.readDirectory(128, 130).map((row) => row.turnId)).toEqual([
    'late',
    'assistant:late',
  ]);
  expect(data.history.readTurn('user-0')).toMatchObject({ turn: { id: 'user-0' } });
  observation.unsubscribe();
  data.dispose();
  doc.free();
});

it.each([128, 1000])(
  'extends a permanently inverted %i-row prefix with suffix reads for two observers',
  async (prefixRows) => {
    const doc = new LoroDoc();
    const data = createLoroSessionData({ doc, sessionId });
    data.writer.append({ ...turn('assistant:u'), role: 'assistant', userTurnId: 'u' });
    data.writer.append(turn('u'));
    for (let index = 2; index < prefixRows; index++) data.writer.append(turn(`prefix-${index}`));
    const list = doc.getList('history');
    const originalContainer = (list.get(0) as LoroMap).id;
    const initialIds = [
      'u',
      'assistant:u',
      ...Array.from({ length: prefixRows - 2 }, (_, i) => `prefix-${i + 2}`),
    ];
    const directories: string[][] = [[], []];
    const notices: SessionDataChange[][] = [[], []];
    let consumer: number | undefined;
    const observations = directories.map((_directory, subscriber) =>
      data.history.observe((change) => {
        notices[subscriber]!.push(change);
        if (change.kind !== 'structure') return;
        consumer = subscriber;
        try {
          const suffix = data.history.readDirectory(change.from, change.to);
          directories[subscriber]!.splice(
            change.from,
            Infinity,
            ...suffix.map((row) => row.turnId!)
          );
        } finally {
          consumer = undefined;
        }
      })
    );
    for (const [index, observation] of observations.entries()) {
      directories[index] = (await observation.initial).map((row) => row.turnId!);
      expect(directories[index]).toEqual(initialIds);
    }
    let previousLength = prefixRows;
    let record = { internal: 0, consumers: [0, 0], prefixReads: 0 };
    const records: (typeof record)[] = [];
    const originalGet = LoroList.prototype.get;
    const get = vi.spyOn(LoroList.prototype, 'get').mockImplementation(function (index) {
      if (this.id === list.id) {
        if (consumer === undefined) record.internal++;
        else record.consumers[consumer]!++;
        if (index < previousLength) record.prefixReads++;
      }
      return originalGet.call(this, index);
    });
    try {
      for (let append = 0; append < 3; append++) {
        previousLength = prefixRows + append;
        record = { internal: 0, consumers: [0, 0], prefixReads: 0 };
        data.writer.append(turn(`suffix-${append}`));
        records.push(record);
      }
    } finally {
      get.mockRestore();
    }
    try {
      const expected = [...initialIds, 'suffix-0', 'suffix-1', 'suffix-2'];
      expect(directories).toEqual([expected, expected]);
      expect
        .soft(records)
        .toEqual(
          Array.from({ length: 3 }, () => ({ internal: 1, consumers: [1, 1], prefixReads: 0 }))
        );
      const suffixNotices = Array.from({ length: 3 }, (_, index) => ({
        kind: 'structure',
        from: prefixRows + index,
        to: prefixRows + index + 1,
      }));
      expect.soft(notices).toEqual([suffixNotices, suffixNotices]);
      expect(
        data.writer
          .readStored()
          .slice(0, 2)
          .map((row) => row.id)
      ).toEqual(['assistant:u', 'u']);
      expect((list.get(0) as LoroMap).id).toBe(originalContainer);
    } finally {
      for (const observation of observations) observation.unsubscribe();
      data.dispose();
      doc.free();
    }
  }
);

it.each([
  'late user',
  'middle insert',
  'middle delete',
  'identity',
  'mixed content append',
] as const)('invalidates a projected prefix after %s for both observers', async (mutation) => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ doc, sessionId });
  data.writer.append({ ...turn('assistant:u'), role: 'assistant', userTurnId: 'u' });
  data.writer.append(turn('u'));
  data.writer.append({ ...turn('assistant:late'), role: 'assistant', userTurnId: 'late' });
  data.writer.append(turn('other'));
  const cached: { id?: string; status?: unknown }[][] = [[], []];
  const changes: SessionDataChange[][] = [[], []];
  const observations = cached.map((_rows, subscriber) =>
    data.history.observe((change) => {
      changes[subscriber]!.push(change);
      if (change.kind === 'structure') {
        cached[subscriber]!.splice(
          change.from,
          Infinity,
          ...data.history
            .readDirectory(change.from, change.to)
            .map((row) => ({ id: row.turnId, status: row.scalars?.status }))
        );
      }
    })
  );
  for (const [index, observation] of observations.entries())
    cached[index] = (await observation.initial).map((row) => ({
      id: row.turnId,
      status: row.scalars?.status,
    }));
  try {
    data.writer.append(turn('ordinary'));
    const list = doc.getList('history');
    let expected: string[];
    switch (mutation) {
      case 'late user':
        data.writer.append(turn('late'));
        expected = ['u', 'assistant:u', 'other', 'ordinary', 'late', 'assistant:late'];
        break;
      case 'middle insert':
        list.insert(2, turn('middle'));
        doc.commit();
        expected = ['u', 'assistant:u', 'middle', 'assistant:late', 'other', 'ordinary'];
        break;
      case 'middle delete':
        list.delete(1, 1);
        doc.commit();
        expected = ['assistant:u', 'assistant:late', 'other', 'ordinary'];
        break;
      case 'identity':
        data.writer.updateEntry('assistant:u', (row) => ({ ...row, userTurnId: 'other' }));
        expected = ['u', 'assistant:late', 'other', 'assistant:u', 'ordinary'];
        break;
      case 'mixed content append':
        (list.get(1) as LoroMap).set('status', 'handled');
        data.writer.append(turn('mixed'));
        expected = ['u', 'assistant:u', 'assistant:late', 'other', 'ordinary', 'mixed'];
        break;
    }
    for (const [subscriber, rows] of cached.entries()) {
      expect(rows.map((row) => row.id)).toEqual(expected);
      expect(changes[subscriber]!.at(-1)).toEqual({
        kind: 'structure',
        from: 0,
        to: expected.length,
      });
      if (mutation === 'mixed content append') expect(rows[0]?.status).toBe('handled');
    }
    expect(data.history.readAll().map((row) => row.id)).toEqual(expected);
  } finally {
    for (const observation of observations) observation.unsubscribe();
    data.dispose();
    doc.free();
  }
});

it('reorders legacy text associations after an in-place remote-style edit', () => {
  const doc = new LoroDoc();
  const data = createLoroSessionData({ doc, sessionId });
  data.writer.append({ ...turn('custom-assistant'), role: 'assistant', userTurnId: 'first' });
  data.writer.append(turn('first'));
  data.writer.append(turn('second'));
  const row = doc.getList('history').get(0) as LoroMap;
  const owner = row.setContainer('userTurnId', new LoroText());
  owner.insert(0, 'second');
  doc.commit();
  expect(data.history.readDirectory(0, 3).map((entry) => entry.turnId)).toEqual([
    'first',
    'second',
    'custom-assistant',
  ]);
  owner.delete(0, owner.length);
  owner.insert(0, 'first');
  doc.commit();
  expect(data.history.readDirectory(0, 3).map((entry) => entry.turnId)).toEqual([
    'first',
    'custom-assistant',
    'second',
  ]);
  data.dispose();
  doc.free();
});
