import { describe, expect, it } from 'vitest';

import {
  getBuiltinAgentByAgentType,
  getBuiltinDefaultModelId,
  getManagedBuiltinRuntimeByAgentType,
  getStaticBuiltinAcpCapabilities,
  isBuiltinAgentType,
  isManagedBuiltinAgentType,
} from '../src/ai';
import { supportsBuiltinAuthentication } from '../src/agent-authentication';

describe('builtin DeepSeek Harness shared contract', () => {
  it('is builtin without being a managed-download runtime', () => {
    expect(isBuiltinAgentType('deepseek')).toBe(true);
    expect(isManagedBuiltinAgentType('deepseek')).toBe(false);
    expect(getManagedBuiltinRuntimeByAgentType('deepseek')).toBeUndefined();
    expect(getBuiltinAgentByAgentType('deepseek')).toEqual({
      agentType: 'deepseek',
      displayName: 'DeepSeek Harness',
    });
  });

  it('prefers deepseek-v4-pro as the official default when the catalog offers it', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'deepseek');
    const modelOption = capabilities?.configOptions.find((option) => option.category === 'model');

    expect(getBuiltinDefaultModelId('builtin', 'deepseek')).toBe('deepseek-v4-pro');
    expect(getBuiltinDefaultModelId('builtin', 'codex')).toBeUndefined();
    expect(getBuiltinDefaultModelId('registry', 'deepseek')).toBeUndefined();
    expect(modelOption).toMatchObject({
      id: 'model',
      type: 'select',
      currentValue: 'deepseek-v4-pro',
    });
    expect(modelOption?.options.map((option) => option.value)).toContain('deepseek-v4-pro');
    expect(capabilities?.models.map((model) => model.modelId)).toContain('deepseek-v4-pro');
  });

  it('uses environment credentials instead of managed interactive authentication', () => {
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'deepseek',
        env: { DEEPSEEK_API_KEY: 'test-key' },
      })
    ).toBe(false);
  });
});
