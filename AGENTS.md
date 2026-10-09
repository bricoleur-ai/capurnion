# Capurnion — instructions for agents

Capurnion auto-clicks SSO "Sign in with *provider*" buttons. You configure it by
editing **`rules.json` only**, then running two commands. Never edit `engine.js`,
`matcher.js`, `manifest.json`, or `rules.generated.js` — the last two are generated and
your changes will be overwritten.

If `rules.json` does not exist yet, run `capurnion init`. It is gitignored on purpose:
it names the user's hosts, so **never commit it and never paste its contents into a
public issue, PR, or commit message.**

## Task: automate a login page you can see in a browser

This is the main flow. You have a tab open on the login page.

1. **Probe the page.** `capurnion probe` prints a read-only JS snippet. Run it in that
   tab (`mcp__claude-in-chrome__javascript_tool`, `page.evaluate`, DevTools). It clicks
   nothing. Save the JSON it returns.

   The snippet must be evaluated as an expression. It is written so that
   `return <file contents>` works; do not reformat it or move the leading `(`.

2. **List what it found.** `capurnion draft --from probe.json`
   Candidates are sorted with SSO-looking labels first and marked `*`. Headings are
   printed as candidate page guards.

3. **Draft the rule.**
   ```bash
   capurnion draft --from probe.json --pick 0 --id acme-app \
       --guard "sign in to acme" --add
   ```
   Without `--add` it prints the rule for you to inspect first. Without `--guard` it
   refuses and shows you the page's headings to choose from.

4. **Ship it.** `capurnion sync`

5. **Ask the user to reload** the extension at `chrome://extensions`. **You cannot do
   this** — `chrome://` pages are not scriptable by any automation. Say so plainly
   rather than implying the change is already live.

Verify any time without a browser:
`capurnion test <url> --text "<page text>"` → `WOULD FIRE`, or the exact list of what
blocked it. `capurnion doctor` says whether the generated files match `rules.json` (and, on
macOS, whether Chrome has the extension registered). It cannot tell whether the user reloaded,
or which version Chrome is running.

## Task: write a rule by hand

```json
{
  "id": "acme-app",
  "description": "Acme login page -> Okta SSO",
  "enabled": true,
  "kind": "idp-select",
  "hosts": ["app.example.com"],
  "require": { "pageText": "sign ?in to acme" },
  "click": { "label": "sign in with okta" }
}
```
```bash
echo '{...}' | capurnion add && capurnion sync
```

## Rules you must follow

- **`kind` is a safety decision, not a label.** Use `idp-select` unless you have a
  specific reason. It covers every "Sign in with X" / "Continue with X" / "Use SSO"
  button — the entire normal case.
- **Never set `kind: "consent-grant"` on your own initiative.** It clicks
  Allow/Authorize on an OAuth consent screen, granting an application access to the
  user's account. It requires `"confirmGrantsAccess": true`, and you should only add one
  when the user asked for that specific screen, on one specific host. Never on a shared
  IdP domain (`accounts.google.com`, `login.microsoftonline.com`) — that would approve
  every application that asks.
- **Never automate an MFA push/approve prompt: the project prohibits it.** Never write a
  rule targeting one, and never add code that answers one. There is no tier for it.
  Auto-clicking it defeats the second factor. If asked, decline and explain why. (SMS
  for a single configured tenant is handled *outside* the rule engine by the opt-in
  `oktaLogin` capability — see below — never by a rule.)
- **Always set `require.pageText` or `require.url`** unless the host serves nothing but
  that one login page. `draft` enforces this; hand-written rules should honor it too.
- **Scope `hosts` as narrowly as the site allows.** Host patterns become the extension's
  permissions. Prefer `app.example.com` over `*.example.com`.
- **Disabled rules are free** — they ship nothing and grant no permissions, so leaving a
  half-finished rule at `"enabled": false` is safe.

## Debugging on a live page

The engine logs to the page console. Read it with
`mcp__claude-in-chrome__read_console_messages` and `pattern: "capurnion"`:

| Line | Means |
|---|---|
| `armed on <host>: <ids>` | Content script loaded; these rules are viable. |
| `rule "<id>" will not fire: <reasons>` | Structurally blocked — bad kind, bad regex, missing flag. |
| `clicked rule="<id>" ...` | It fired. |
| `no match within <ms>ms` | Guards never passed, or the button never appeared. |
| *(nothing at all)* | The content script is not running on this host: no enabled rule names it, or `sync`/reload was skipped. |

## Things that will trip you up

- `sync` builds the manifest from **enabled rules only**. Enabling a rule changes the
  extension's host permissions, which is why a reload is required.
- `capurnion test` without `--text` reports `pageText ... untested` rather than passing.
  Treat that as "unknown", not "yes".
- Chrome derives the extension's ID from the SHA-256 of its absolute path. Do not move or
  rename the folder; it becomes a different extension and must be re-installed.
- `capurnion enable` refuses a rule whose host is still `REPLACE-ME...` and writes
  nothing. Set the real host first, then enable.
- `capurnion test` needs `node` on PATH. The extension itself does not.

## The `oktaLogin` capability (vault + SMS relay)

Separate from the rule engine. For **one** Okta tenant it fills email + password
from the vault on the sign-in page, then completes the **SMS** factor (select
Phone → request code → fetch it from a configured HTTP relay → Verify). It drives
only the SMS/Phone factor; it never approves an Okta Verify push and never fills a
password-less step-up.

Configure it in `rules.json` (see the README for the full block). Rules you must
honor:

- It automates the user's **second factor** — only ever set it up on the user's
  explicit request, for their own account on their own machine. `confirmAutomatesMfa`
  must be literally `true` or `sync` refuses it.
- It requires `vault.enabled: true`; `usernameSecret`/`passwordSecret` name vault
  entries. Never write secret *values* into `rules.json` — only the names.
- `host` is one bare Okta hostname; `smsCodeUrl` is an endpoint returning
  `{"code":"..."}`. Its origin becomes a `host_permission`.
- The code that fills fields lives in `okta-login-*.js`; like `engine.js`/`matcher.js`
  it is not something you edit to configure a login — you only edit `rules.json`.

## The `snowflakePat` capability (renewal, recovery, session watch)

Also separate from the rule engine. Each hour, and at a five-minute watchdog poll when a check
failed or a window is nearly due, it opens its own inactive tab on **one** Snowflake account's
Authentication settings page. There it grants 24 hours of network-policy bypass to each Active
token with under two hours left. Rules you must honor:

- It grants an access exception, so set it up only on the user's explicit request.
  `confirmGrantsAccess` must be literally `true`. The numbers (`intervalMinutes` 60,
  `pollMinutes` 5, `renewBelowMinutes` 120, `grantHours` 24) are fixed and `validate` rejects
  any other value; do not try to tune them.
- **`restoreMissingAccess: true` is the user's call, not yours.** It gives every Active token
  with no timer a fresh grant, even with no history. Without it, a vanished timer is restored
  only when stored history shows its window has passed and the page reports a missing network
  policy. Leave the key out unless they asked for it.
- **Late SSO recovery** (`snowflake-sso-watch.js`) rides along with the SSO rules once the
  capability is on. It clicks only in the check's own tab (focused or not), on Snowflake's hosts, for
  an enabled `idp-select` rule whose guards pass, and only a button whose label mentions Okta or
  SSO. It needs no rule of its own: never widen a rule's `hosts` or `click.label` to make it fire.
- **The Okta session check.** With `oktaLogin` also enabled, each poll sends a
  cookie-authenticated GET to that host's `/api/v1/sessions/me` (ten-second timeout, no
  redirects followed), and `sync` adds the host to `host_permissions`. It records one of three
  states: `active` (Okta answered ACTIVE), `signed-out` (Okta's structured no-session error) or
  `unknown` (anything else: a bare 404, an unsupported endpoint, a redirect, a timeout). Only
  `signed-out` sends the check's tab through Okta sign-in first, and the check moves on only
  once the session reads `active`. **`unknown` is never treated as logged out**; renewal runs
  through the usual SSO flow, and nothing in `rules.json` fixes it.
- Never ask for, store or paste a PAT secret, an Okta session ID or a cookie. The extension never
  reads or saves them, and nothing in `rules.json` needs them.
- **What counts as done.** A check reads tokens only once the Active list shows at least one
  row (it waits up to 60 seconds, then fails rather than reporting success), and a grant counts
  only after its dialog closes and the same row shows 23 to 24 hours left. Do not describe a
  check as successful on any weaker evidence.
- **Permissions.** `sync` adds `alarms`, `storage`, `notifications`, `scripting` and the
  account's host (`https://app.snowflake.com/*`); the worker uses `scripting` only to re-attach
  the page script to the check's own tab. Never add permissions by hand: edit `rules.json`, `sync`.
- Do not drive or reuse the check's tab. Focusing it does not stop the check; **Pause**, closing
  the tab, or leaving the settings page after renewal has started does, and the tab closes when
  the check ends. To stop it, ask the user to press **Pause** in the toolbar popup (it stops the
  hourly check, the watchdog and sign-in recovery), or set `"enabled": false`, `sync`, and ask
  them to reload. After any `sync`, the reload is the user's manual step: never say new code is
  live.
- The code lives in `snowflake-pat*.js`, `snowflake-sso-watch.js` and `okta-session.js`. Like
  `engine.js`, it is not something you edit to configure anything.

## The vault, and what the tests prove

- Describe the vault honestly. Locking management is **not** cryptographic revocation: the
  automation key stays in the profile and keeps decrypting. The key is non-exportable, which
  does **not** make it hardware-backed or protect it from a compromised browser or profile.
- Secrets are read only by trusted extension code. Never add a message handler that returns a
  secret to a web page, and never paste rules, browser storage, page HTML or vault records into
  an issue, PR or commit: usernames, account paths and token names are private too.
- The tests run on jsdom and a VM with simulated Chrome APIs (the workflow tests on a Chromium
  fixture page). They are not a real Chrome end-to-end suite, and unattended hourly renewal is
  not yet proven. Never claim more than that.
