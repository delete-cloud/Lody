import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import componentPackage from './package.json' with { type: 'json' };
import config from './playwright.config.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const scripts = componentPackage.scripts;
const webServer = config.webServer;
assert.ok(webServer && !Array.isArray(webServer));
const toolSource = `
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
async function main() {
  const [tool, ...args] = process.argv.slice(2);
  if (tool === 'pnpm' && args[0] === 'build-storybook') {
    fs.writeFileSync('build-attempt', 'started');
    if (process.env.FAIL_STORYBOOK_BUILD === '1') process.exit(23);
    fs.writeFileSync('storybook-static/iframe.html', 'fresh compiled story');
    return;
  }
  if (tool === 'playwright' && args[0] === 'test') {
    const html = fs.readFileSync('storybook-static/iframe.html', 'utf8');
    if (html !== 'fresh compiled story') throw new Error('Browser received stale or unbuilt stories');
    fs.writeFileSync('browser-receipt.json', JSON.stringify({ html, args }));
    return;
  }
  if (tool === 'pnpm' && args.slice(0, 3).join(' ') === 'exec vite preview') {
    const filename = args[args.indexOf('--config') + 1];
    const { default: preview } = await import(pathToFileURL(path.resolve(filename)));
    const html = fs.readFileSync(path.join(preview.build.outDir, 'iframe.html'), 'utf8');
    fs.writeFileSync('preview-receipt.json', JSON.stringify({ html, host: preview.preview.host, strictPort: preview.preview.strictPort }));
    return;
  }
  throw new Error('Unexpected external command: ' + tool + ' ' + args.join(' '));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'lody-storybook-preparation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  mkdirSync(join(directory, 'storybook-static'));
  writeFileSync(join(directory, 'storybook-static/iframe.html'), 'stale compiled story');
  const toolFile = join(bin, 'tool.cjs');
  writeFileSync(toolFile, toolSource);
  for (const name of ['pnpm', 'playwright']) {
    if (process.platform === 'win32') {
      writeFileSync(
        join(bin, name + '.cmd'),
        `@"${process.execPath}" "${toolFile}" ${name} %*\r\n`
      );
    } else {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\nexec "${process.execPath}" "${toolFile}" ${name} "$@"\n`,
        { mode: 0o755 }
      );
    }
  }
  return {
    directory,
    run(command: string, extraEnv: NodeJS.ProcessEnv = {}) {
      return spawnSync(command, {
        cwd: directory,
        shell: true,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PATH: bin + delimiter + process.env.PATH, ...extraEnv },
      });
    },
    receipt(name: string): unknown {
      return JSON.parse(readFileSync(join(directory, name), 'utf8'));
    },
  };
}

for (const name of ['test:e2e', 'test:e2e:ui']) {
  void test(`${name} replaces a stale build before passing stories to the browser`, (t) => {
    const target = fixture(t);
    const result = target.run(scripts[name]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(target.receipt('browser-receipt.json'), {
      html: 'fresh compiled story',
      args: name === 'test:e2e:ui' ? ['test', '--ui'] : ['test'],
    });
  });
}

void test('a failed build prevents a browser run even when old static files exist', (t) => {
  const target = fixture(t);
  const result = target.run(scripts['test:e2e'], { FAIL_STORYBOOK_BUILD: '1' });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(
    readFileSync(join(target.directory, 'storybook-static/iframe.html'), 'utf8'),
    'stale compiled story'
  );
  assert.equal(existsSync(join(target.directory, 'browser-receipt.json')), false);
});

void test('the managed server serves the compiled directory without reusing a dev server', (t) => {
  const target = fixture(t);
  const previewConfig = join(packageRoot, 'storybook-preview.config.mjs');
  if (existsSync(previewConfig))
    copyFileSync(previewConfig, join(target.directory, 'storybook-preview.config.mjs'));
  const result = target.run(webServer.command);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(target.receipt('preview-receipt.json'), {
    html: 'stale compiled story',
    host: '127.0.0.1',
    strictPort: true,
  });
  assert.equal(webServer.reuseExistingServer, false);
});
