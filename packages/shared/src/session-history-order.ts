type HistoryOrderEntry = { id: string; role: unknown; userTurnId?: unknown };

const historyOrderEntry = (value: unknown): HistoryOrderEntry | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  return typeof (value as { id?: unknown }).id === 'string'
    ? (value as HistoryOrderEntry)
    : undefined;
};

export function sessionHistoryUserTurnId(value: unknown): string | undefined {
  const entry = historyOrderEntry(value);
  if (!entry || entry.role === 'user') return undefined;
  return typeof entry.userTurnId === 'string'
    ? entry.userTurnId
    : entry.role === 'assistant' && entry.id.startsWith('assistant:')
      ? entry.id.slice('assistant:'.length)
      : undefined;
}

export function orderSessionHistory<T>(history: T[]): T[] {
  const users = new Map<string, number>();
  history.forEach((value, index) => {
    const entry = historyOrderEntry(value);
    if (entry?.role === 'user' && !users.has(entry.id)) users.set(entry.id, index);
  });
  const after = new Map<number, number[]>();
  const moved = new Set<number>();
  history.forEach((value, index) => {
    const entry = historyOrderEntry(value);
    if (!entry || entry.role === 'user') return;
    const userTurnId = sessionHistoryUserTurnId(entry);
    const userIndex = userTurnId === undefined ? undefined : users.get(userTurnId);
    if (userIndex === undefined || userIndex <= index) return;
    const indices = after.get(userIndex) ?? [];
    indices.push(index);
    after.set(userIndex, indices);
    moved.add(index);
  });
  if (moved.size === 0) return history;
  const ordered: T[] = [];
  history.forEach((entry, index) => {
    if (!moved.has(index)) ordered.push(entry);
    for (const assistantIndex of after.get(index) ?? []) {
      const assistant = history[assistantIndex];
      if (assistant) ordered.push(assistant);
    }
  });
  return ordered;
}
