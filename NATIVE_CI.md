# Native CI and browser-game testing

Flowstride runs `.flow` tests locally and in CI without a custom runner wrapper.

## Installation and execution

Use Node.js 22.12 or newer. Install Flowstride as a project dependency and commit the lockfile:

```sh
npm install --save-dev flowstride
npx flowstride install
npx flowstride run flows --ci
```

In CI, use `npm ci` before browser installation and test execution. Browser installation uses the Chromium version matching the installed Flowstride engine by default. See [native browser workflows](NATIVE_BROWSER.md) for Firefox, WebKit and browser configuration. Linux runners may require system browser dependencies; the generated GitHub workflow handles installation for its runner.

Cloud users authenticate using `npx flowstride login`. In CI, supply the developer token through the `FLOWSTRIDE_TOKEN` secret, never in committed files. Install project dependencies before login, then install the matching browser and run the tests. The Flowstride CLI uses compatible, authorized Cloud engine installations and falls back to the open-source engine when the Cloud engine is unavailable.

Generate a GitHub Actions workflow explicitly:

```sh
npx flowstride ci init github
```

The command requires an npm project with a committed lockfile and refuses to overwrite an existing workflow. It does not run automatically during installation.

## Configuration and reports

`flowstride.config.json` supports `testDir`, `baseUrl`, `timeout`, `device` (`desktop`, `phone`, `landscape`), optional `viewport`, `pluginsDir`, `artifactsDir`, `recordVideo` (boolean), `browserErrors` (`fail` or `record`), and `webServer` (`command`, local readiness `url`, optional `cwd` and `timeout`).

Malformed configuration and unsafe output paths fail before execution. Configuration, plugin, environment, upload, session and output paths must remain inside the project, including resolved symlinks.

Native CI is selected by `--ci` or a recognized CI environment. It runs headlessly without a dashboard server and returns nonzero for failed, incomplete, crashed or interrupted execution. JSON and JUnit reports are written at the configured artifact root, which defaults to `flowstride-artifacts`. Media and attachments use a unique run directory referenced by the summary.

Flow discovery is recursive. `.first.flow` files run before ordinary files. A failed scenario leaves its remaining steps untested and execution continues to later scenarios. `--bail` stops later work; the Cloud engine executes bail runs sequentially.

An optional configured local web server is started and stopped with the run. Flowstride rejects a readiness URL that is already serving.

Cloud reporting is disabled by default in native CI. Set `cloudSync: true` to enable authenticated reporting. Reporting and video status are recorded separately in the summary and `.flowstride/cloud-sync.json`; a reporting failure does not change a passed test into a failed test.

## Browser-game actions

Register the built-in alias:

```text
let game = "flowstride:game";
```

The built-in game API provides:

- `tap`: canvas selector and coordinates; relative coordinates by default, or `unit: "pixels"`.
- `drag` and `swipe`: canvas, start/end coordinates, optional duration and input type.
- `key`: key name and optional hold duration.
- `checkpoint`: named screenshot, optionally of one canvas.
- `snapshot` and `expectVisual`: canvas comparison with explicit change thresholds.
- `state` and `expectState`: exposed application state with optional dotted paths.
- `snapshotState` and `expectPreserved`: compare selected state across actions or reloads.
- `fixture`: a named fixture explicitly registered by the application in test mode.
- `select`: a stable object ID resolved by a game bridge, followed by real pointer input.

The package includes a small runnable example in `examples/native-game`. Its HTTP server serves the fixture application; it is not a custom test runner. Use your application's normal start command for your own game.

Visual checks measure pixel differences. Pair them with state or UI assertions to verify gameplay behavior. Mobile profiles emulate Chromium devices; physical device testing is a separate qualification. Touch dragging currently uses Chromium CDP.

## Application bridges

For a generic browser game, import `registerGame` from `flowstride/dist/game/bridge.js`. Supply `readState` and optional test-only fixtures.

For Three.js, import `registerThreeGame` from `flowstride/dist/game/three-bridge.js`. Register the live scene, camera, canvas, your application's `Vector3` and `Raycaster` constructors, and an optional map of stable object IDs. Alternatively, assign `userData.flowstrideId` to scene objects. Optional local pick points use `userData.flowstridePickPoint: [x, y, z]`.

The bridge projects and raycasts the live scene. Hidden, occluded, off-screen, covered or non-pickable objects fail explicitly. It creates no renderer or animation loop. Dispose the bridge when replacing the scene.

Application fixtures are available only when explicitly registered with `testMode: true`. Enable this in dedicated test builds, never public production builds. Your application still defines its own rules, observable state and fixtures.

Custom plugins receive `sdk.game`, `sdk.browser.page()` and `sdk.run`, including artifact attachment support, alongside the existing SDK.

## Assertions and browser sessions

```text
flow.expect attribute "#order" "data-state" "approved";
flow.expect attribute "#order" "class" contains "selected";
flow.save session "browser" persist;
flow.use session "browser";
```

Attribute comparisons wait up to the configured timeout. Exact matching is case-sensitive; `contains` checks a substring. Missing attributes fail even when the expected value is empty.

Sessions capture cookies, local storage, session storage and the current HTTP(S) storage origin. Local storage and session storage are restored immediately on the matching origin or before its first matching navigation. It is not seeded into unrelated origins. The initial seed is then removed so later application changes and reloads are preserved.

Existing cookie/local-storage snapshots remain compatible. Older snapshots with Web Storage but no origin prefer the configured application `baseUrl` (including `BASE_URL`), then an available current HTTP(S) application page. Configure the intended base URL before restoring a legacy record. Restoration merges saved keys into storage. This is a single-origin storage snapshot.

## Interactive history and debugging

Each completed flow tab restores its own last captured screen. Selecting an earlier step remembers a separate history cursor for that file. Flows without screenshots show an empty state. New runs clear previous screens and cursors.

The local cURL preview remains `[REDACTED]`. Copy masked cURL copies a sanitized request template with email, password, authorization and cookies masked. Supply replacements manually before running that command. Replay also starts masked and rejects unresolved placeholders before sending; it never silently reuses original credentials. Manually entered credentials are re-masked after Send, while `emailVerified` retains its actual value/type. Automated .flow execution still uses configured credentials normally. CI and Cloud reports retain redaction.

Review artifact access and test data: credential redaction does not remove every possible application secret, and screenshots or videos can show sensitive information.

## Runnable core workflow examples

[Core Flowstride workflows](NATIVE_WORKFLOWS.md) covers API + UI, email OTP, iFrames, audio/transcripts, tables/cells, variables and manual testing. The [shared setup](examples/native-workflows/README.md) explains the local demo application's lifecycle and CI configuration.

After `npm ci` and matching browser installation, a CI job can run a named local example with:

```sh
npx --no-install flowstride run workflow-examples/api-and-ui/flows/api-and-ui.flow --ci
```

In CI, `--no-install` makes a missing local Flowstride installation fail rather than fetching a package. Ordinary interactive commands use `npx flowstride`. Configure the local app through `webServer`, and exclude `negative/` examples and unconfigured service templates from your passing CI target.

## Report existing Playwright Test suites

Add the Flowstride reporter to your existing Playwright config. Keep your current reporters in the array if you want their output too.

```javascript
reporter: [
  ['list'],
  ['flowstride/playwright-reporter'],
],
```

Run `npx playwright test` as usual. Playwright runs the specs, fixtures, browsers, workers, and retries and decides the exit status. Flowstride saves the suite outcome, test outcomes, individual attempts, and failure diagnostics. Open **Saved runs** with `npx flowstride report` from the same project directory. Use `--no-open` to print the browser URL. [Playwright reporter API](https://playwright.dev/docs/api/class-reporter), [Playwright test results](https://playwright.dev/docs/api/class-testresult)

Flowstride CI runs from `npx flowstride run … --ci` appear in the same view. The reports are stored locally under `.flowstride/run-history/`. Flowstride CI evidence stays in the configured artifacts directory. Ignore `.flowstride/` in your test project to keep the saved reports out of version control.

Attachments are opt-in. Add `{ attachments: ['screenshot', 'video', 'trace', 'text'] }` as the second item in the reporter entry to copy those types from completed attempts. The reporter supports PNG and JPEG screenshots, WebM and MP4 video, Playwright trace ZIPs, and UTF-8 text and JSON. Screenshot imports respect `security.evidence.screenshots`. Explicit `recordVideo: false` and `trace: false` in the Flowstride config disable those imports. Keep file-backed attachments inside the project and use Playwright’s default output retention so the files are available to the reporter. Each attachment is limited to 32 MiB, text and JSON inputs to 256 KiB, and the imported evidence for a run to 128 MiB.

Failure diagnostics and text attachments pass through Flowstride's redaction. Use `redactEnv: ['QA_AUTH_VALUE']` to register the values of extra environment variables for redaction. Screenshots, videos, and traces are saved as binary downloads and may contain sensitive test data. Enable them only for suites whose evidence is safe to retain. Runtime stdout and stderr are outside this archive.

The [runnable discount example](examples/native-workflows/playwright-reporting/README.md) shows how to use one JavaScript helper in a Playwright spec and a `.flow` scenario.
