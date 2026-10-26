# Shared components

`@lody/components` contains shared product UI and Storybook examples. Add coverage
for new presentational components and meaningful states using the real components.

## Browser regression

Build stories before starting browser tests:

```sh
pnpm --filter @lody/components test:e2e tests/e2e/conversation-scroll-engine.spec.ts --workers=1
```

`test:e2e` and `test:e2e:ui` first run `build-storybook`; a failed build prevents
Playwright from starting, including when old output exists. For several selections
against the same source revision, build once and invoke Playwright directly:

```sh
pnpm --filter @lody/components build-storybook
pnpm --filter @lody/components exec playwright test tests/e2e/conversation-scroll-engine.spec.ts --workers=1
```

The managed server serves `storybook-static` through Vite preview with an isolated
configuration. It does not compile modules on the first test navigation or reuse
another server. Keep the default port free, or set `LODY_STORYBOOK_URL` to a free
loopback URL such as `http://127.0.0.1:6016` for both commands. A missing build or
occupied port fails preparation. Rebuild whenever the tested source changes.

Build time is separate from the browser case deadline. Story initialization,
opening the real view and its scroll, bottom-position and blank-frame assertions
retain their existing deadlines. Static output uses Storybook's production build;
interactive development remains available through `pnpm storybook`.

The preparation command contracts can be checked without a browser:

```sh
node --test packages/components/playwright.config.test.ts
```

See the [preparation decision](../../.agents/notes/implemented/testing/2026-10-27-static-storybook-browser-regression.md)
for the observed cold-start failure and validation limits.
