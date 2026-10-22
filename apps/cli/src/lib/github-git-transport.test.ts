import { EventEmitter } from 'node:events';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGitHubGitTransport } from './github-git-transport';
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-native-git-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
const findNativeGit = (): string => {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git'] : ['git'];
  for (const pathDirectory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!pathDirectory) continue;
    for (const name of names) {
      const candidate = path.join(pathDirectory, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        const source = fs.readFileSync(candidate, 'utf8').slice(0, 8192);
        if (
          (source.includes('const REAL_GIT = ') && source.includes('LODY_GIT_NATIVE')) ||
          (source.includes("const { spawn } = require('child_process');") &&
            source.includes('GIT_EXEC_PATH: __dirname') &&
            source.includes('LODY_GIT_NATIVE'))
        )
          continue;
      } catch {
        continue;
      }
      return candidate;
    }
  }
  throw new Error('Native Git executable was not found');
};
function harness(
  options: {
    owner?: boolean;
    personal?: boolean;
    offline?: boolean;
    command?: string;
    inheritedOperation?: string;
    helper?: string;
    readOnly?: boolean;
    denyPersonal?: boolean;
  } = {}
) {
  ensureGitHubGitTransport(directory, '/workspace/broker', 'git');
  const wrapper = fs.readFileSync(path.join(directory, 'git'), 'utf8');
  const throughWrapper = (command: string, env: Record<string, string>) => {
    let forwarded = env;
    vm.runInNewContext(wrapper, {
      __dirname: directory,
      require: (name: string) =>
        name === 'path'
          ? path
          : {
              spawn: (_git: string, _args: string[], init: { env: Record<string, string> }) => {
                forwarded = init.env;
                return new EventEmitter();
              },
            },
      process: { argv: ['node', 'git', command], env },
    });
    return forwarded;
  };
  const env = throughWrapper(
    options.helper ?? 'remote-https',
    throughWrapper(options.command ?? 'clone', {
      PATH: '/synthetic/bin',
      LODY_GIT_CRED_CONTEXT_TOKEN: 'frozen',
      ...(options.inheritedOperation === undefined
        ? {}
        : { LODY_GIT_OPERATION: options.inheritedOperation }),
    })
  );
  const source = fs
    .readFileSync(path.join(directory, 'git-remote-https'), 'utf8')
    .replace(/main\(\)\.catch[\s\S]*$/, 'globalThis.run = main;');
  const delegates: Array<{ args: string[]; env: Record<string, string> }> = [];
  const attempts: string[] = [];
  const sync = vi.fn(
    (_git: string, args: string[], init: { env: Record<string, string>; input?: string }) => {
      if (args[0] === 'credential')
        return { status: 0, stdout: 'username=owner\npassword=local-token\n' };
      if (args[0] === 'remote-https') {
        if (options.readOnly && init.input === 'list for-push\n\n') {
          return { status: 128, stderr: 'HTTP 403' };
        }
        const headers = init.env.GIT_CONFIG_PARAMETERS || '';
        attempts.push(headers);
        if (
          options.denyPersonal &&
          headers.includes(Buffer.from('x-access-token:personal-token').toString('base64'))
        )
          return { status: 128, stderr: 'HTTP 403' };
      }
      return { status: 0, stdout: '' };
    }
  );
  const context = vm.createContext({
    require: (name: string) =>
      name === 'path'
        ? path
        : name === 'child_process'
          ? {
              spawnSync: sync,
              spawn: (
                _git: string,
                args: string[],
                init: { env: Record<string, string>; input?: string }
              ) => {
                delegates.push({ args, env: init.env });
                return new EventEmitter();
              },
            }
          : {
              readFileSync: (file: string) =>
                JSON.stringify(
                  file.includes('.contexts/')
                    ? { version: 1, contextToken: 'frozen', allowLocalAuth: options.owner ?? true }
                    : { url: 'http://broker', token: 'fixture' }
                ),
            },
    process: {
      argv: ['node', 'adapter', 'origin', 'https://github.com/org/repo.git'],
      env,
    },
    fetch: async (_url: string, init: { body: string }) => {
      if (options.offline) throw Object.assign(new Error('SECRET'), { code: 'ECONNREFUSED' });
      const { source: identity } = JSON.parse(init.body);
      return Response.json(
        identity === 'personal' && !options.personal
          ? { available: false }
          : { token: identity + '-token', tokenSource: identity }
      );
    },
    console: { error: () => {} },
    URL,
    AbortSignal,
    Buffer,
  });
  vm.runInContext(source, context);
  return { run: () => (context.run as () => Promise<void>)(), delegates, attempts, sync };
}
describe('native Git credential adapter', () => {
  it.each(['clone', 'fetch', 'pull', 'ls-remote', 'submodule'])(
    '%s keeps read-only credentials through helper redispatch',
    async (command) => {
      const h = harness({ command, personal: true, readOnly: true });
      await h.run();
      expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
        Buffer.from('x-access-token:personal-token').toString('base64')
      );
    }
  );
  it('preserves read context through the HTTP helper', async () => {
    const h = harness({ helper: 'remote-http', personal: true, readOnly: true });
    await h.run();
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from('x-access-token:personal-token').toString('base64')
    );
  });
  it('classifies a new read independently of inherited write context', async () => {
    const h = harness({ inheritedOperation: 'write', personal: true, readOnly: true });
    await h.run();
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from('x-access-token:personal-token').toString('base64')
    );
  });
  it.each([
    ['push', 'read'],
    ['unknown-command', 'read'],
    ['remote-https', undefined],
    ['remote-http', 'invalid'],
    ['remote-https', 'write'],
  ])(
    'rejects read-only credentials for %s with inherited %s',
    async (command, inheritedOperation) => {
      const h = harness({ command, inheritedOperation, personal: true, readOnly: true });
      await expect(h.run()).rejects.toMatchObject({ code: 'credentials_exhausted' });
      expect(h.delegates).toEqual([]);
    }
  );
  it('delegates once using personal credentials and keeps standard remote URLs', async () => {
    const h = harness({ personal: true });
    await h.run();
    expect(h.delegates).toHaveLength(1);
    expect(h.delegates[0].args).toEqual([
      'remote-https',
      'origin',
      'https://github.com/org/repo.git',
    ]);
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from('x-access-token:personal-token').toString('base64')
    );
    expect(h.sync.mock.calls.some(([, args]) => args[0] === 'credential')).toBe(false);
  });
  it('falls through a denied native advertisement to machine identity before executing a write', async () => {
    const h = harness({ personal: true, denyPersonal: true, command: 'push' });
    await h.run();
    expect(h.attempts).toHaveLength(2);
    expect(h.delegates).toHaveLength(1);
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from('x-access-token:local-token').toString('base64')
    );
    expect(
      h.sync.mock.calls
        .filter(([, args]) => args[0] === 'remote-https')
        .every(([, , init]) => init.input === 'list for-push\n\n')
    ).toBe(true);
  });
  it('uses isolated anonymous reads after a cloud outage without borrowing nonowner credentials', async () => {
    const h = harness({ owner: false, offline: true });
    await h.run();
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain('.extraHeader=Authorization:');
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain('http.cookieFile=');
    expect(h.sync.mock.calls.some(([, args]) => args[0] === 'credential')).toBe(false);
  });
  it('does not execute an anonymous write when providers fail', async () => {
    const h = harness({ owner: false, offline: true, command: 'push' });
    await expect(h.run()).rejects.toMatchObject({ code: 'credentials_exhausted' });
    expect(h.delegates).toEqual([]);
  });
  it('native receive-pack advertisement leaves refs unchanged', () => {
    const bare = path.join(directory, 'remote.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    expect(spawnSync('git', ['ls-remote', '--upload-pack=git-receive-pack', bare]).status).toBe(0);
    expect(execFileSync('git', ['--git-dir', bare, 'for-each-ref'], { encoding: 'utf8' })).toBe('');
  });
  it('clones recursive native SSH submodules while cloud credentials fail', async () => {
    // Pre-push hooks and editors export Git/SSH state. None of it belongs to
    // these synthetic repositories or their native credential probes.
    vi.stubEnv('GIT_DIR', path.join(directory, 'not-a-repository'));
    vi.stubEnv('GIT_WORK_TREE', path.join(directory, 'unrelated-worktree'));
    vi.stubEnv('GIT_ASKPASS', path.join(directory, 'unrelated-askpass'));
    vi.stubEnv('SSH_ASKPASS', path.join(directory, 'unrelated-ssh-askpass'));
    vi.stubEnv('GIT_SSH_VARIANT', 'plink');
    const realGit = path.join(
      execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
      'git'
    );
    const fixtureEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(GIT_|SSH_|LODY_GIT_)/.test(key))
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    };
    const git = (args: string[]) =>
      execFileSync(realGit, args, { cwd: directory, env: fixtureEnv, stdio: 'ignore' });
    const dependency = path.join(directory, 'dependency');
    const project = path.join(directory, 'project');
    git(['init', dependency]);
    git(['-C', dependency, 'commit', '--allow-empty', '-m', 'dependency']);
    git(['init', project]);
    git([
      '-C',
      project,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      dependency,
      'dependency',
    ]);
    git([
      '-C',
      project,
      'config',
      '-f',
      '.gitmodules',
      'submodule.dependency.url',
      'git@github.com:org/dependency.git',
    ]);
    git(['-C', project, 'add', '.gitmodules']);
    git(['-C', project, 'commit', '-m', 'project']);
    const ssh = path.join(directory, 'ssh.cjs');
    const log = path.join(directory, 'ssh.log');
    fs.writeFileSync(
      ssh,
      `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2).join(' ');
if (process.argv.includes('-G')) process.exit(0);
const match = args.match(/(git-upload-pack|git-receive-pack).*?org\\/(project|dependency)\\.git/);
if (!match) process.exit(1);
// A read-only identity can advertise and fetch, but cannot receive pushes.
if (match[1] === 'git-receive-pack') process.exit(1);
fs.appendFileSync(${JSON.stringify(log)}, match[2] + '\\n');
const roots = ${JSON.stringify({ project, dependency })};
const child = spawnSync(${JSON.stringify(realGit)}, [match[1].replace('git-', ''), roots[match[2]]], { stdio: 'inherit' });
process.exit(child.status ?? 1);
`
    );
    const state = path.join(directory, 'broker.json');
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing broker port');
      fs.writeFileSync(
        state,
        JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: 'fixture' })
      );
      fs.mkdirSync(state + '.contexts');
      fs.writeFileSync(
        state + '.contexts/requester.json',
        JSON.stringify({ version: 1, contextToken: 'requester', allowLocalAuth: true })
      );
      const bin = path.join(directory, 'bin');
      fs.mkdirSync(bin);
      ensureGitHubGitTransport(bin, state, realGit);
      const checkout = path.join(directory, 'checkout');
      await promisify(execFile)(
        path.join(bin, 'git'),
        ['clone', '--recurse-submodules', 'git@github.com:org/project.git', checkout],
        {
          // Credential probes must not discover the checkout running this test.
          cwd: directory,
          env: {
            ...fixtureEnv,
            PATH: `${bin}:${process.env.PATH}`,
            GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(ssh)}`,
            GIT_SSH_VARIANT: 'ssh',
            LODY_GIT_CRED_CONTEXT_TOKEN: 'requester',
            LODY_GIT_LOCAL_CONFIG: '{}',
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
            GIT_CONFIG_VALUE_0: 'git@github.com:',
            GIT_CONFIG_KEY_1: 'protocol.ext.allow',
            GIT_CONFIG_VALUE_1: 'always',
          },
          timeout: 20_000,
        }
      );
      expect(fs.readFileSync(log, 'utf8').split('\n')).toEqual(
        expect.arrayContaining(['project', 'dependency'])
      );
      expect(
        execFileSync(realGit, ['-C', path.join(checkout, 'dependency'), 'rev-parse', 'HEAD'], {
          env: fixtureEnv,
          encoding: 'utf8',
        }).trim()
      ).toBe(
        execFileSync(realGit, ['-C', dependency, 'rev-parse', 'HEAD'], {
          env: fixtureEnv,
          encoding: 'utf8',
        }).trim()
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  describe('exec-path probe resilience', () => {
    const markerPath = () => path.join(directory, 'lody-git-transport.json');
    const realExecPath = () => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^GIT_EXEC_PATH$/i.test(key)) delete env[key];
      return execFileSync(findNativeGit(), ['--exec-path'], { encoding: 'utf8', env }).trim();
    };
    const spawnError = (code: string) =>
      Object.assign(new Error(`spawnSync git ${code}`), { code });
    const writeMarker = (marker: Record<string, unknown>) =>
      fs.writeFileSync(markerPath(), JSON.stringify(marker));
    const generatedShim = (filePath: string) =>
      fs.writeFileSync(
        filePath,
        '#!/usr/bin/env node\nconst REAL_GIT = "/native/git";\nconst native = process.env.LODY_GIT_NATIVE;\n',
        { mode: 0o755 }
      );

    const runGeneratedWrapper = (output = directory): string => {
      const wrapper = fs.readFileSync(path.join(output, 'git'), 'utf8');
      let nativeGit = '';
      vm.runInNewContext(wrapper, {
        __dirname: output,
        require: (name: string) =>
          name === 'child_process'
            ? {
                spawn: (filePath: string) => {
                  nativeGit = filePath;
                  return new EventEmitter();
                },
              }
            : path,
        process: { argv: ['node', path.join(directory, 'git'), 'status'], env: { PATH: '/bin' } },
      });
      return nativeGit;
    };

    it('records the resolved layout in a marker after materialization', () => {
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit());
      const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
      expect(marker).toMatchObject({
        version: 1,
        realGit: findNativeGit(),
        statePath: '/workspace/broker',
      });
      expect(fs.existsSync(marker.execPath)).toBe(true);
      expect(fs.existsSync(marker.nativeGit)).toBe(true);
    });

    it('skips the probe entirely when the recorded layout matches', () => {
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit());
      fs.rmSync(path.join(directory, 'package.json'));
      const probe = vi.fn(() => {
        throw spawnError('EAGAIN');
      });
      expect(() =>
        ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
          probeExecPathOnce: probe,
        })
      ).not.toThrow();
      expect(probe).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(directory, 'package.json'))).toBe(true);
    });

    it('clears every GIT_EXEC_PATH spelling before probing and points the wrapper at native Git', () => {
      const nativeExecPath = realExecPath();
      const nativeGit = path.join(nativeExecPath, process.platform === 'win32' ? 'git.exe' : 'git');
      generatedShim(path.join(directory, 'git'));
      vi.stubEnv('GIT_EXEC_PATH', directory);
      vi.stubEnv('gIt_ExEc_PaTh', directory);
      let probeEnv: NodeJS.ProcessEnv | undefined;
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
        probeExecPathOnce: (_realGit, env) => {
          probeEnv = env;
          return nativeExecPath;
        },
      });
      expect(probeEnv).toBeDefined();
      expect(Object.keys(probeEnv ?? {}).filter((key) => /^GIT_EXEC_PATH$/i.test(key))).toEqual([]);
      expect(runGeneratedWrapper()).toBe(nativeGit);
      expect(runGeneratedWrapper()).not.toBe(path.join(directory, 'git'));
    });

    it('uses the real native probe to recover from an inherited wrapper exec path', () => {
      const nativeExecPath = realExecPath();
      generatedShim(path.join(directory, 'git'));
      vi.stubEnv('GIT_EXEC_PATH', directory);
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit());
      expect(JSON.parse(fs.readFileSync(markerPath(), 'utf8')).execPath).toBe(nativeExecPath);
      expect(runGeneratedWrapper()).toBe(
        path.join(nativeExecPath, process.platform === 'win32' ? 'git.exe' : 'git')
      );
      expect(process.env.GIT_EXEC_PATH).toBe(directory);
    });

    it.each([
      ['direct', (wrapper: string) => wrapper],
      [
        'symlink alias',
        (wrapper: string) => {
          const alias = path.join(directory, 'git-alias');
          fs.symlinkSync(wrapper, alias);
          return alias;
        },
      ],
    ])(
      'never probes a generated wrapper passed as realGit through a %s path',
      (_name, resolvePath) => {
        const wrapper = path.join(directory, 'git');
        generatedShim(wrapper);
        const probe = vi.fn(() => realExecPath());
        expect(() =>
          ensureGitHubGitTransport(directory, '/workspace/broker', resolvePath(wrapper), {
            probeExecPathOnce: probe,
          })
        ).toThrow(/not a safe native Git path/);
        expect(probe).not.toHaveBeenCalled();
      }
    );

    it('retries transient spawn failures before succeeding', () => {
      const safeExecPath = realExecPath();
      let calls = 0;
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
        probeExecPathOnce: () => {
          calls++;
          if (calls < 3) throw spawnError('EAGAIN');
          return safeExecPath;
        },
      });
      expect(calls).toBe(3);
      expect(fs.existsSync(path.join(directory, 'git'))).toBe(true);
    });

    it('does not retry a non-transient probe failure', () => {
      let calls = 0;
      expect(() =>
        ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
          probeExecPathOnce: () => {
            calls++;
            throw spawnError('ENOENT');
          },
        })
      ).toThrowError(spawnError('ENOENT'));
      expect(calls).toBe(1);
    });

    it('fails session preparation only when no recorded layout survives the probe failure', () => {
      let calls = 0;
      expect(() =>
        ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
          probeExecPathOnce: () => {
            calls++;
            throw spawnError('EAGAIN');
          },
        })
      ).toThrowError(spawnError('EAGAIN'));
      expect(calls).toBe(4);
    });

    it.each([
      [
        'self-referential',
        (_realPath: string) => ({ execPath: directory, nativeGit: path.join(directory, 'git') }),
      ],
      [
        'cross-workspace',
        (realPath: string) => {
          const other = path.join(directory, 'other');
          fs.mkdirSync(other);
          fs.writeFileSync(path.join(other, 'lody-git-transport.json'), '{}');
          return { execPath: other, nativeGit: path.join(realPath, 'git') };
        },
      ],
      [
        'bad-path',
        (_realPath: string) => ({
          execPath: path.join(directory, 'missing'),
          nativeGit: path.join(directory, 'missing', 'git'),
        }),
      ],
    ])('rejects a %s marker and probes a safe layout', (_name, paths) => {
      const nativeExecPath = realExecPath();
      const nativeGit = path.join(nativeExecPath, process.platform === 'win32' ? 'git.exe' : 'git');
      generatedShim(path.join(directory, 'git'));
      writeMarker({
        version: 1,
        realGit: findNativeGit(),
        statePath: '/workspace/broker',
        ...paths(nativeExecPath),
      });
      let probes = 0;
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
        probeExecPathOnce: () => {
          probes++;
          return nativeExecPath;
        },
      });
      expect(probes).toBe(1);
      expect(JSON.parse(fs.readFileSync(markerPath(), 'utf8')).nativeGit).toBe(nativeGit);
      expect(runGeneratedWrapper()).toBe(nativeGit);
    });

    it('rejects a marker whose native Git reaches a generated wrapper through a symlink', () => {
      const nativeExecPath = realExecPath();
      const nativeGit = path.join(nativeExecPath, process.platform === 'win32' ? 'git.exe' : 'git');
      generatedShim(path.join(directory, 'git'));
      const alias = path.join(directory, 'git-alias');
      fs.symlinkSync(path.join(directory, 'git'), alias);
      writeMarker({
        version: 1,
        realGit: findNativeGit(),
        statePath: '/workspace/broker',
        execPath: nativeExecPath,
        nativeGit: alias,
      });
      ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
        probeExecPathOnce: () => nativeExecPath,
      });
      expect(JSON.parse(fs.readFileSync(markerPath(), 'utf8')).nativeGit).toBe(nativeGit);
      expect(runGeneratedWrapper()).toBe(nativeGit);
    });

    it('does not reuse a mismatched marker when the probe fails', () => {
      const nativeExecPath = realExecPath();
      const nativeGit = path.join(nativeExecPath, process.platform === 'win32' ? 'git.exe' : 'git');
      writeMarker({
        version: 1,
        realGit: '/previous/git',
        statePath: '/workspace/broker',
        execPath: nativeExecPath,
        nativeGit,
      });
      expect(() =>
        ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
          probeExecPathOnce: () => {
            throw spawnError('ENOENT');
          },
        })
      ).toThrowError(spawnError('ENOENT'));
      expect(fs.existsSync(path.join(directory, 'git'))).toBe(false);
    });

    it('rejects its output directory even before a wrapper or marker exists', () => {
      expect(() =>
        ensureGitHubGitTransport(directory, '/workspace/broker', findNativeGit(), {
          probeExecPathOnce: () => directory,
        })
      ).toThrow(/unsafe exec path/);
      expect(fs.existsSync(path.join(directory, 'git'))).toBe(false);
    });

    it('rejects a renamed generated wrapper outside a marked layout', () => {
      const standalone = path.join(directory, 'standalone-wrapper');
      const output = path.join(directory, 'output');
      fs.mkdirSync(output);
      generatedShim(standalone);
      expect(() =>
        ensureGitHubGitTransport(output, '/workspace/broker', standalone, {
          probeExecPathOnce: () => realExecPath(),
        })
      ).toThrow(/not a safe native Git path/);
      expect(fs.existsSync(path.join(directory, 'git'))).toBe(false);
    });

    it('pins an absolute native target when relative Git has no exec-path core binary', () => {
      const output = path.join(directory, 'output');
      const coreless = path.join(directory, 'coreless');
      fs.mkdirSync(output);
      fs.mkdirSync(coreless);
      const native = findNativeGit();
      ensureGitHubGitTransport(output, '/workspace/broker', path.relative(process.cwd(), native), {
        probeExecPathOnce: () => coreless,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(output, 'lody-git-transport.json'), 'utf8')).nativeGit
      ).toBe(native);
      expect(runGeneratedWrapper(output)).toBe(native);
    });
  });
});
