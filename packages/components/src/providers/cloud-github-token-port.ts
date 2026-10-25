import { api } from '@lody/cloud-api';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference, OptionalRestArgs } from 'convex/server';
import type { GitHubTokenPort, GitHubTokenErrorResult } from '@/lib/github-token-port';
import { getRegisteredAuthClient } from '@/lib/auth-client-singleton';
import { requestCurrentConvexJwt } from '@/lib/convex-jwt';
import { convexClient } from './convex-provider';

async function mintFreshConvexJwt(): Promise<string | null> {
  const authClient = getRegisteredAuthClient();
  return authClient ? await requestCurrentConvexJwt(authClient) : null;
}

async function runActionWithUnauthorizedRetry<
  Action extends FunctionReference<'action'> & {
    _returnType: { success: true } | GitHubTokenErrorResult;
  },
>(action: Action, ...args: OptionalRestArgs<Action>): Promise<Action['_returnType']> {
  const result = (await convexClient.action(action, ...args)) as Action['_returnType'];
  if (result.success || result.errorCode !== 'unauthorized') {
    return result;
  }
  const fresh = await mintFreshConvexJwt();
  if (!fresh) return result;
  const deploymentUrl = convexClient.url || import.meta.env.VITE_CONVEX_DEPLOY_URL;
  if (!deploymentUrl) return result;
  const httpClient = new ConvexHttpClient(deploymentUrl);
  httpClient.setAuth(fresh);
  try {
    return (await httpClient.action(action, ...args)) as Action['_returnType'];
  } catch {
    return result;
  }
}

export const cloudGitHubTokenPort: GitHubTokenPort = {
  getRepoToken: (input) =>
    runActionWithUnauthorizedRetry(api.github.getAccessTokenByRepoNameForClient, input),
  getOperationToken: (input) =>
    runActionWithUnauthorizedRetry(api.github.getOperationAccessTokenByRepoNameForClient, input),
};
