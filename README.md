# App Store Phased Release 🍏

[![My Skills](https://skillicons.dev/icons?i=githubactions,apple,nodejs&perline=3)](https://skillicons.dev)

## Use 📄

### Example ⌨️

```yaml
    permissions:
      contents: read
      deployments: write

    steps:
      - name: Pause phased release
        id: phased
        uses: abhishek-3289/appstore-phased-release@v1
        with:
          command: pause
          issuer-id: ${{ secrets.ASC_ISSUER_ID }}
          key-id: ${{ secrets.ASC_KEY_ID }}
          private-key: ${{ secrets.ASC_PRIVATE_KEY }}
          bundle-id: com.example.app
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}

      - name: Show result
        run: |
          echo "${{ steps.phased.outputs.version }} is ${{ steps.phased.outputs.state }}"
          echo "Day ${{ steps.phased.outputs.day }} (${{ steps.phased.outputs.percentage }}%)"
```

### Description 🔖

A GitHub Action that controls the **App Store phased release** of an iOS app through the
[App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). It is the iOS
counterpart of `play-rollout-manager` and shares the same ideas: a `command`, a `dry-run` switch,
Slack notifications and deployment history in GitHub Environments.

The action finds the app (by `app-id` or by resolving `bundle-id`), picks the newest iOS version in
`READY_FOR_SALE`, `PENDING_DEVELOPER_RELEASE` or `PROCESSING_FOR_APP_STORE` that has a phased release
(or the exact `version` you pass) and then runs one of these commands:

| command    | allowed from          | result                                                                  |
|:-----------|:----------------------|:------------------------------------------------------------------------|
| `status`   | any state             | Reports state, day and percentage. Never changes anything.              |
| `pause`    | `ACTIVE`              | Sets the phased release to `PAUSED`.                                    |
| `resume`   | `PAUSED`              | Sets the phased release back to `ACTIVE`.                               |
| `complete` | `ACTIVE`, `PAUSED`    | Sets the phased release to `COMPLETE`, releasing to **all** users.      |
| `guard`    | `ACTIVE`              | Pauses when `crash-free-rate` is below `min-crash-free-rate`.           |

From any other state the command is reported as `skipped` with a reason, and the API is never asked to
set a state the release is already in. `guard` never resumes a paused release; that stays a human decision.

#### How phased release works ⏱️

Phased release only affects users with **automatic updates** turned on. Everyone can still download the new
version manually from the App Store. Apple's schedule is fixed and cannot be customised:

| day | 1  | 2  | 3  | 4   | 5   | 6   | 7    |
|:----|:---|:---|:---|:----|:----|:----|:-----|
| %   | 1% | 2% | 5% | 10% | 20% | 50% | 100% |

The `percentage` output is derived from `currentDayNumber` with this table (`COMPLETE` is always 100%,
`INACTIVE` is 0%). `INACTIVE` means the version is approved but not released yet; this action does not
release versions, so commands other than `status` are skipped in that state.

A phased release can be paused **for at most 30 days in total**. The action shows `totalPauseDuration`
in the step summary and emits a warning (also included in Slack) once the total reaches 25 days.

#### Crash guard 🛡️

Apple does **not** expose crash rates through the App Store Connect API, so `guard` takes the current
crash-free percentage as an input. Fetch it in an earlier step from your crash reporter and pass the step
output to `crash-free-rate`:

- **Firebase Crashlytics**: export Crashlytics to BigQuery and query the crash-free users ratio for the
  version with `bq query --format=json`, or read a value your own backend publishes.
- **Sentry**: call the sessions endpoint
  (`GET /api/0/organizations/<org>/sessions/?field=crash_free_rate(user)&query=release:<release>`)
  with a `SENTRY_AUTH_TOKEN` secret and multiply the ratio by 100 (check the endpoint against the Sentry docs for your plan).

Write the number (for example `99.72`) to `$GITHUB_OUTPUT` and reference it as
`${{ steps.<id>.outputs.crash-free-rate }}`. `guard` fails when `crash-free-rate` is empty, so a broken
metric step never looks healthy.

#### App Store Connect API key 🔑

1. In App Store Connect open **Users and Access → Integrations → App Store Connect API**.
2. Create a **Team key** with the **App Manager** role or higher (Admin works too). Developer and
   Marketing roles cannot change phased releases.
3. Note the **Issuer ID** and **Key ID**, and download the `AuthKey_<KEYID>.p8` file (it can be downloaded only once).
4. Add repository or environment secrets: `ASC_ISSUER_ID`, `ASC_KEY_ID` and `ASC_PRIVATE_KEY` (the full
   contents of the `.p8` file including the `BEGIN`/`END` lines).

The action signs a short lived ES256 JWT (at most 20 minutes) with `node:crypto`, masks it in the log and
never prints the key.

#### Turning automation on and off 🔀

Scheduled workflows are gated by a repository variable, so you can switch automation off without editing
YAML: **Settings → Secrets and variables → Actions → Variables**, set `PHASED_RELEASE_GUARD_ENABLED` to
`true` to enable and anything else to disable. Manual runs of the control workflow are always available.

#### Where state lives 🗂️

App Store Connect is the single source of truth: every run reads the current phased release state from
Apple, so changes made by hand in App Store Connect are picked up automatically. The action keeps no
state of its own. Every applied change (not dry runs, skips or status checks) is recorded as a GitHub
Deployment with a success status in the `deployment-environment` (default `appstore-phased-release`),
for example `2.3.0 paused on day 3 (5%)`, so the history is visible under **Environments** in the repository.
Recording history needs `deployments: write`; a failure only warns unless `require-history: true`.

### Inputs 📥

| name                   | description                                                                                                 | required | default                                  |
|:-----------------------|:------------------------------------------------------------------------------------------------------------|:---------|:-----------------------------------------|
| command                | `status`, `pause`, `resume`, `complete` or `guard`.                                                         | No       | `status`                                 |
| issuer-id              | App Store Connect API issuer ID.                                                                            | Yes      | ❌                                       |
| key-id                 | App Store Connect API key ID.                                                                               | Yes      | ❌                                       |
| private-key            | Contents of the `.p8` private key. Pass it from a secret.                                                   | Yes      | ❌                                       |
| app-id                 | Numeric Apple ID of the app. Either `app-id` or `bundle-id` is required.                                    | No       | ❌                                       |
| bundle-id              | Bundle identifier, resolved to the Apple ID when `app-id` is empty.                                         | No       | ❌                                       |
| version                | Version string to control. Empty picks the newest live or pending version with a phased release.            | No       | ❌                                       |
| crash-free-rate        | Current crash-free percentage from your crash reporter. Required for `guard`.                               | No       | ❌                                       |
| min-crash-free-rate    | `guard` pauses when `crash-free-rate` is below this percentage.                                             | No       | `99.5`                                   |
| dry-run                | Compute and report only. Never changes the release, records history or sends success/skip notifications.    | No       | `false`                                  |
| github-token           | Token used to record deployment history. Needs `deployments: write`.                                        | No       | `github.token`                           |
| deployment-environment | Environment the deployment history is recorded under.                                                       | No       | `appstore-phased-release`                |
| require-history        | Fail the run when deployment history cannot be recorded.                                                    | No       | `false`                                  |
| slack-webhook-url      | Slack incoming webhook URL, e.g. for `#releases`.                                                           | No       | ❌                                       |
| notify-on-healthy      | Also notify when `guard` finds the release healthy.                                                         | No       | `false`                                  |
| notify-on-skip         | Also notify when a command is skipped.                                                                      | No       | `false`                                  |
| api-base-url           | **Testing only.** Base URL of the App Store Connect API.                                                    | No       | `https://api.appstoreconnect.apple.com`  |
| github-api-url         | **Testing only.** Base URL of the GitHub REST API.                                                          | No       | `github.api_url`                         |

Slack messages are sent for `paused`, `resumed`, `completed` and failures (always), for a healthy `guard`
only with `notify-on-healthy`, and for skipped commands only with `notify-on-skip`. Each message contains the
app, version, state, day, percentage, reason and a link to the workflow run. A failing webhook only warns.

### Outputs 📤

1. **app-id** :- Numeric Apple ID of the app.
2. **version** :- Version string whose phased release was inspected, eg: `2.3.0`.
3. **state** :- Phased release state after the run: `INACTIVE`, `ACTIVE`, `PAUSED`, `COMPLETE` (or `NONE` when no phased release was found).
4. **day** :- Current day of the phased release (`1`-`7`), empty when not started.
5. **percentage** :- Share of automatic-update users receiving the version, derived from the day.
6. **previous-state** :- Phased release state before the run.
7. **action-taken** :- `paused`, `resumed`, `completed`, `skipped` or `none` (`none` for `status`, a healthy `guard` and every dry run).
8. **reason** :- Why the action was taken, skipped or failed. Dry runs start with `Dry run: would ...`.

A table with the same values is written to the job summary.

## Examples 🧪

Ready-to-copy workflows live in [`examples/`](examples):

- [`phased-release-control.yml`](examples/phased-release-control.yml) is a manual workflow to check, pause, resume or complete the phased release, with a `dry-run` switch (on by default), deployment history in the `appstore-phased-release` environment and a concurrency group so two runs never race.
- [`scheduled-crash-guard.yml`](examples/scheduled-crash-guard.yml) runs every two hours on weekdays when `vars.PHASED_RELEASE_GUARD_ENABLED == 'true'`, reads the crash-free rate in a placeholder step (replace it with your Crashlytics or Sentry query) and pauses the release when it drops below `99.5%`.

Both expect the secrets `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY` and optionally `SLACK_WEBHOOK_URL`.
Using an `environment` lets you add required reviewers before anyone can `complete` a release.

## Development 🛠️

```bash
node --test tests/*.test.js
```

The action is plain JavaScript on Node 24 with **no npm dependencies**: it uses the global `fetch` and
`node:crypto` only, so there is nothing to install or bundle. Tests use `node:test` with a stubbed `fetch`
and cover the JWT, request shapes, version selection, every command and state combination, the guard,
the pause limit, deployment history and Slack payloads.

[`tests/mock-server.js`](tests/mock-server.js) is a small App Store Connect stand-in that verifies the JWT
signature. Run it next to the action with `api-base-url` to try things locally:

```bash
MOCK_PORT=8787 node tests/mock-server.js
```

| Workflow | Trigger | What it does |
|:---------|:--------|:-------------|
| [CI](.github/workflows/ci.yml) | push to `main`, pull requests | actionlint, `node --check`, unit tests on Node 24, and an integration run of the action in dry-run mode against the mock server with a throwaway EC key. |
| [Release](.github/workflows/release.yml) | manual (`patch` / `minor` / `major`) | Runs CI, calculates the next version from the highest `vX.Y.Z` tag, publishes a GitHub release with generated notes, and moves the `vMAJOR` tag. |
