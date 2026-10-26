# Compile Storybook before browser regression

Status: implemented
Translation: current

[中文](2026-10-27-static-storybook-browser-regression.zh.md)

## Abstract

The conversation browser regression exhausted its 30-second case deadline while
Storybook's development server was still loading the story module graph. The real
3000-turn view had not reached its readiness marker or Open action, so the failure
did not measure the intended mount and scroll behavior. Browser regression now
builds static Storybook before Playwright and serves that output through an
isolated Vite preview configuration. Build failures stop preparation; case
deadlines, fixtures and UI assertions remain unchanged. Real-browser validation
of this preparation change is still required.

## Evidence and decision

Original baseline and history-fix traces both show `sb-show-preparing-story`
before the readiness expectation, without the story's readiness or Open nodes.
The story id exists in both actual index resources. The iframe contains hidden
No Preview/error templates; their text is not evidence of a visible story error.
Navigation consumed approximately16–18 seconds of the30-second case deadline,
and some story dependencies had no recorded response completion when the case
ended. This supports separating compilation from behavioral testing, without
attributing the failure to the history reader or claiming a particular Vite bug.

Use the existing `build-storybook` command and Vite dependency. CI builds in an
explicit step before its existing Playwright invocation. Package `test:e2e` and
`test:e2e:ui` also build first and stop on build failure, including when stale
output exists. Direct Playwright invocations require an explicit fresh build.
The managed server uses a small preview-only configuration so the application
Vite plugins cannot turn it into a development compiler. Port conflicts fail
instead of reusing an unrelated server. The existing server-start and case
deadlines are unchanged.

A module-preparation fixture was considered. It would need its own readiness
signal, error handling and ownership for the development optimizer; merely
warming the story or waiting longer could still hide module errors. Static
output provides a simpler existing preparation boundary. It exercises a
production bundle rather than React development mode, so previous dev-server
timings are not interchangeable performance baselines. Interactive Storybook
development remains available separately.

This decision complements the [Storybook environment correction](../bug-fix/2026-09-26-storybook-dev-node-env.md).
It does not alter the [onboarding final-action decision](2026-10-14-e2e-onboarding-final-action.md).
One instrumented intro success cannot establish a repair for an earlier stock
timeout; no intro product or harness change belongs to this patch.

## Verification and limits

Pure Node command-contract tests execute the actual package scripts and managed
server command with synthetic external tools. They observe replacement of stale
compiled content before a browser consumer, failure preventing consumption of
old content, UI argument preservation and selection of the preview directory.
All four fail on the old entrypoints and pass after the preparation change.
These tests do not launch a browser or prove the real view renders.

The unchanged static build first failed because the isolated dependency copy had
not built ACP core and DSH's exported JavaScript. Their pinned builds supply those
workspace prerequisites; the failed build log is retained rather than treated as
a product regression. Static Storybook compilation then passed. Related checks and VM acceptance are
reported separately in the implementation handoff. Browser/Electron execution
is restricted to the designated VM; no local UI acceptance is claimed.
