import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { MessageRowView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';

const sessionId = 'synthetic-restart-recovery' as SessionId;
const input: SessionHistoryParsed = {
  id: 'synthetic-interrupted-input',
  role: 'user',
  timestamp: '2026-10-23T00:00:00Z',
  status: 'delivery_unknown',
  items: [{ type: 'text', text: 'Create the synthetic result file.' }],
};

function Recovery({ before = false, unsubmitted = false }: { before?: boolean; unsubmitted?: boolean }) {
  const prePrompt = before || unsubmitted;
  const notice: SessionHistoryParsed = {
    id: 'synthetic-recovery-notice',
    role: 'system',
    timestamp: '2026-10-23T00:00:01Z',
    items: [{
      type: 'system_notice', name: 'chat_failed', meta: {
        reason: prePrompt ? 'turn_pre_prompt_failed' : 'turn_outcome_unknown',
        message: prePrompt
          ? 'This message was not started because an earlier attempt to run it already ended. Lody does not replay messages automatically; send it again to retry.'
          : 'The earlier attempt reached prompt submission and ended before its result was recorded. Work may already have happened. Lody will not replay it automatically; sending it again could repeat work.',
      },
    }],
  };
  return (
    <div className="w-[720px] max-w-[100vw] bg-background py-4">
      <ConversationColumn>
        <MessageRowView message={{ ...input, status: prePrompt ? 'failed' : 'delivery_unknown' }} sessionId={sessionId} onResendUndelivered={async () => true} />
        <MessageRowView message={notice} sessionId={sessionId} />
      </ConversationColumn>
    </div>
  );
}

const meta = {
  title: 'Sessions/InterruptedTurnRecovery',
  component: Recovery,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Recovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PersistedBeforeFix: Story = { args: { before: true } };
export const RecoveredOutcomeUnknown: Story = { args: {} };
export const ProvenPrePromptFailure: Story = { args: { unsubmitted: true } };
