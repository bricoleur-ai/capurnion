# capurnion

**Finish the sign-ins you repeat every day: one guarded click by default, and with a local encrypted vault, Okta and token renewals too.**

<!-- bricoleur:intro -->
> Part of **[bricoleur.ai](https://bricoleur.ai)**: small, honest tools cobbled together from the AI-era parts at hand. Related: **[keeBLEr](https://github.com/shawnrancatore/keeBLEr)**, another tool that works from the browser you already have open.
<!-- /bricoleur:intro -->

```mermaid
flowchart LR
    R["rules.json<br/>your private config"] -->|capurnion sync| G["manifest.json<br/>rules.generated.js"]
    G -->|"reload at chrome://extensions"| X["capurnion<br/>in Chrome"]
    X --> L{"on a login page:<br/>host, page guard and<br/>button label all match?"}
    L -->|yes| C["one click"]
    L -->|no| N["nothing"]
```

## What it does

- **Clicks the "Sign in with &lt;provider&gt;" button** on the login pages you name in one JSON file:
  once per page load, and only when the host, your page guards and the button's label all match.
- **Signs in to one Okta tenant, if you opt in.** Your email and password come from a local encrypted
  vault, and the SMS code from a small relay such as 2fu.
- **Keeps one Snowflake account's programmatic access tokens usable, if you opt in.** An hourly check
  in a background tab resets any token's network-policy bypass to 24 hours once under two hours remain.

## Quick start

You need Chrome and Python 3. Node is needed only for `capurnion test` and the test suite.

```sh
git clone https://github.com/bricoleur-ai/capurnion
cd capurnion
bin/capurnion init      # creates your private rules.json, every rule off, and syncs
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose
the `capurnion` folder. Then run `bin/capurnion doctor`. It worked if Chrome lists **Capurnion —
SSO/OAuth login auto-click** and `doctor` ends with `no problems` (on macOS it also confirms Chrome has
it loaded). Every rule starts off, so nothing is clicked yet: [Adding a site](#adding-a-site) turns on
your first.

## How it works

`capurnion sync` turns `rules.json` into the two files Chrome loads: a manifest that asks only for the
hosts of your enabled rules, and those rules. On those hosts a content script watches the page as it
renders. When every guard of a rule passes and its button appears, it clicks once and stops; if not,
it gives up after 15 seconds by default. The decision lives in `matcher.js`, and `capurnion test` runs
that same file, so a dry run and the browser cannot disagree. The vault, Okta sign-in and Snowflake
renewal run in a service worker that loads only what you enable. The
[technical brief](https://bricoleur.ai/projects/capurnion/how-it-works) walks through it.

## What it deliberately does not do

- **No MFA approvals.** No rule can approve a push prompt: to the extension an MFA "Approve" looks like
  a consent "Allow", and clicking it for you defeats the second factor. Okta sign-in drives only the
  SMS factor, never an Okta Verify push or a password-less step-up.
- **No typing from rules.** A rule only clicks. The only fields capurnion fills belong to the two
  opt-in workflows: your Okta sign-in, and the Snowflake bypass duration.
- **No permissions you did not ask for.** Disabled rules ship nothing, and `init` starts with none.
- **No server of its own, and nothing in sync storage.** Secrets stay encrypted in this Chrome profile.
  The only requests it makes itself go to your 2fu relay and your Okta host's session endpoint, once
  you configure them. It never reads or saves Snowflake token secrets, Okta session IDs or cookies.
- **No build step and no runtime dependencies.** Chrome loads the plain JavaScript as it is; the CLI
  uses only Python's standard library.
- **No waking up.** Chrome must be running; its alarms do not wake a sleeping computer.

## Your config never enters the repo

`rules.json` names the hosts you sign in to. It holds no credentials, but it does describe your
employer, your vendors and your tenants, so it is **gitignored**, as are the two files generated from
it, `manifest.json` and `rules.generated.js`. Secret values never go in it: the Okta capability names
vault entries, and the vault holds the values.

The tracked `rules.example.json` holds the same kinds of rules with `REPLACE-ME` hosts, all disabled;
`init` copies it to `rules.json`. A fresh clone will not load in Chrome until `init` or `sync` has
generated the manifest: an empty extension is a better default than one with someone else's hosts.

## Adding a site

**With an agent driving Chrome.** The agent has to see the page to know what to click, so there is a
read-only probe. `capurnion probe` prints a JS snippet; run it in the tab on the login page with Claude
in Chrome's `javascript_tool`, Playwright's `page.evaluate`, or DevTools. It returns the host, the
headings you could guard on, and every clickable label, SSO-looking ones first, and clicks nothing.
Save that JSON and hand it to `draft`:

```sh
capurnion draft --from probe.json
#   * [ 0] Sign in with Okta
#   * [ 1] Continue with Google
#     [ 2] Sign in

capurnion draft --from probe.json --pick 0 --id acme-app --guard "sign in to acme" --add
capurnion sync
```

`draft` refuses to create a rule with no page guard, and prints the page's own headings as
ready-to-paste `--guard` values. [AGENTS.md](AGENTS.md) holds the rules an agent must follow.

**By hand.** Edit `rules.json`, run `capurnion test <url> --text "<text on the page>"` until it says
`WOULD FIRE`, then `capurnion sync`. Starting from an `example-*` rule? Replace its `REPLACE-ME` host
**before** enabling it: `capurnion enable` refuses a placeholder host and leaves the file unwritten.

Either way, finish by clicking **reload** on the capurnion card at `chrome://extensions`; content
scripts and host permissions do not change until you do. `capurnion doctor` reports `STALE` if you
forgot `sync`, but it cannot tell whether you reloaded.

## Rule schema

```json
{
  "id": "acme-app",
  "description": "Acme's login page -> Okta",
  "enabled": true,
  "kind": "idp-select",
  "hosts": ["app.example.com", "*.login.example.com"],
  "require": { "pageText": "sign ?in to acme" },
  "click":   { "label": "sign in with okta|continue with okta" },
  "options": { "timeoutMs": 15000, "delayMs": 0 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique; lowercase letters, digits, dashes. |
| `description` | strongly | What it does. Agents read this to pick a rule to edit. |
| `enabled` | yes | Disabled rules ship nothing and cost **no host permissions**. |
| `kind` | yes | Safety tier; see [Security model](#security-model). |
| `hosts` | yes | Bare hostnames. `*.example.com` matches subdomains and the apex. |
| `require.pageText` | no | Case-insensitive regex the page's visible text must match. |
| `require.url` | no | Case-insensitive regex the full URL must match. |
| `click.label` | yes | Case-insensitive regex matched against the button's visible label. |
| `click.selector` | no | CSS override. Default: `button, a, [role=button], input[type=submit\|button]`. |
| `options.timeoutMs` | no | Stop watching the page after this. Default 15000. |
| `options.delayMs` | no | Wait before clicking; re-checks the button is still there. |
| `allFrames` | no | Also run inside iframes, for framed consent screens. |
| `confirmGrantsAccess` | consent only | Must be `true` for a `consent-grant` rule to run. |

A rule fires when **every** guard passes. With no `require` it clicks any matching button anywhere on
those hosts, and `validate` warns about it.

## Security model

SSO rules read the page and call `.click()`, at most **once per page load**, on the hosts of enabled
rules only.

| `kind` | Clicks | |
|---|---|---|
| `idp-select` | "Sign in with Okta / Google / Microsoft / SSO" | Navigational: picks an identity provider and grants nothing. The default; covers almost every case. |
| `session-continue` | "Continue as &lt;user&gt;", "Stay signed in?" | Grants nothing, but clicks past a screen you may have wanted to read. |
| `consent-grant` | "Allow" / "Authorize" on an OAuth consent screen | **Grants an application access to your account.** Needs `"confirmGrantsAccess": true`; the engine refuses it otherwise, and `validate` errors. |

Scope a `consent-grant` rule to one host. On a shared IdP domain such as `accounts.google.com` or
`login.microsoftonline.com`, it would approve every application that asks.

Each capability is off until you enable it, and each needs Chrome 120 or newer. `sync` adds:

| Capability | Permissions and scripts |
|---|---|
| Snowflake renewal | `alarms`, `storage`, `notifications`; the service worker and popup; a content script on the one settings URL, and the late-SSO watch beside your SSO rules. |
| Vault | `storage`, and `unlimitedStorage` so the device key survives eviction; the settings page. No website permissions. |
| Okta sign-in | `storage` and the service worker; a content script on the one Okta host; the relay's origin. With renewal on too, the Okta host, for the session check. |

## Okta sign-in (vault and 2fu)

This signs you in to one Okta tenant **in the browser**. On the sign-in page it fills your **email and
password from the vault**, then completes the **SMS** factor: it selects Phone, asks for a code, fetches
the code from a small HTTP relay you run, and clicks Verify. Pair it with an `idp-select` rule on an
app's login page, and a cold visit signs in hands-off. It automates your **second factor**, so enable
it only for your own account on your own machine. In the private `rules.json`, beside `rules`:

```json
"oktaLogin": {
  "enabled": true,
  "confirmAutomatesMfa": true,
  "host": "example.okta.com",
  "usernameSecret": "ou",
  "passwordSecret": "op",
  "smsCodeUrl": "http://2fu.local:8787/code?client=laptop"
}
```

- `confirmAutomatesMfa` must be literally `true`, or `validate` and `sync` refuse it. `host` is the one
  Okta hostname; the content script runs only there, in the top frame.
- `usernameSecret` and `passwordSecret` name [vault](#the-local-encrypted-vault) entries (default `ou`
  and `op`), so `vault.enabled` must be `true`.
- `smsCodeUrl` answers `{"code":"123456"}` once a code is ready, and anything but `200` before then.
  The 2fu relay does exactly this: your phone forwards the text, and it hands the code over once. Its
  origin becomes a host permission. Keep it on a network you trust; it carries codes in the clear.

It takes one action per screen: fill both fields and Sign in; select Phone; ask for the SMS; then poll
the relay every three seconds for up to two minutes, fill the code and Verify. The password is
decrypted only in the service worker, which answers only the configured host's top frame; the page
script checks that the sign-in form is still showing before it types, and clears its copies after. If
the vault cannot supply the credentials yet, it tries again 30 seconds later. To set it up, save the
two secrets, unlock vault management once so the device has automation access, then sync and reload.

## Snowflake tokens and the vault

### Hourly token renewal

Each hour this opens a **new, inactive tab** on one account's Authentication settings page. Your SSO
rules run as usual through the login redirects, and renewal starts only once the Programmatic access
tokens section loads. The tab closes after the check, even a failed one; if you switch to it,
automation stops and leaves it open for you.

For each token on the **Active** list with less than two hours of temporary access left, it opens the
row's **More options** menu, selects **Bypass requirement for network policy**, fills **24**, picks
**Hours**, and clicks **Grant access**. It checks the signed-in user, the form and the row before
submitting, and waits for the same token to show 23–24 hours. Expiration dates do not change. It skips
tokens at exactly two hours and timers it does not recognise, and works only on the Active list, so
expired tokens are never selected.

A token whose timer has vanished is recovered the same way. With `restoreMissingAccess: true`, that is
any Active token with no timer, even with no history. Without it, only when stored history for the
same name and expiration shows its window has passed, and the page reports a missing network policy.

```json
"snowflakePat": {
  "enabled": true,
  "confirmGrantsAccess": true,
  "url": "https://app.snowflake.com/acme/xy12345/settings/authentication",
  "expectedUser": "you@example.com",
  "intervalMinutes": 60,
  "pollMinutes": 5,
  "restoreMissingAccess": true,
  "renewBelowMinutes": 120,
  "grantHours": 24
}
```

Use the username in the account menu's accessible label, and one exact HTTPS settings URL.
`confirmGrantsAccess` is your deliberate opt-in to renewing this network-policy exception. The numbers
are fixed (`validate` rejects others); `pollMinutes` and `restoreMissingAccess` are optional. Run
`capurnion validate`, `sync`, and reload. The first check runs when the capability loads and on
browser startup, then hourly. A **five-minute watchdog** also starts one when the last check did not
succeed, a stored countdown is within two hours of its end, or Okta reports you signed out; a check
missed during sleep runs after wake. Checks never overlap, and a five-minute deadline ends one that
cannot finish. **Snowflake must already be signed in, or able to finish its SSO flow.**

If an SSO button turns up after the engine has given up, the check's own tab looks again every five
seconds for five minutes, on Snowflake's hosts only. With the service worker's approval, it clicks one
visible button that matches an enabled `idp-select` rule, passes its guards and mentions Okta or SSO.

**With Okta sign-in also on**, each poll checks your Okta session with a cookie-authenticated GET to
the host's `/api/v1/sessions/me`. A confirmed missing session sends the check's tab to Okta first, where
Okta sign-in runs; once the session is active, the same tab moves on to Snowflake. A session the
endpoint cannot confirm shows as **could not verify**, and the check goes ahead through your usual SSO
flow; this [Okta compatibility API](https://developer.okta.com/docs/guides/oie-upgrade-sessions-api/main/)
is missing in some deployments.

The toolbar popup shows the last result, each token's timer and expiration, the next hourly check and
poll, the Okta session state, and **Check now** and **Pause**/**Resume**. **Pause** stops the hourly
check, the watchdog and sign-in recovery, and cancels a running check. A `!` badge marks a failed check
or skipped timers, and a failure raises a desktop notification at most once every 30 minutes; clicking
it opens the Snowflake settings page. Stored: token names, displayed timers and dates, countdown
deadlines, check results and session status. Set `enabled` to `false`, sync and reload to remove it.

### The local encrypted vault

Add `"vault": { "enabled": true }` beside `rules`, sync, and reload, then open **Settings & vault** from
the popup or **Extension options** (without renewal on, the toolbar icon opens it). Create a vault with
a passphrase of at least 12 characters, then add, edit, reveal and delete named secrets. Names and
values are stored encrypted together in this profile's local extension storage: never in `rules.json`,
the generated config or browser sync storage.

Encryption is Web Crypto AES-256-GCM with a fresh 96-bit nonce on every save, under a key derived by
PBKDF2-HMAC-SHA-256 (600,000 iterations, random 128-bit salt). The non-exportable key is kept as a
`CryptoKey` in the extension's IndexedDB, so automations keep access across panel closes and worker and
Chrome restarts, with no stored passphrase. Trusted extension code reads one value with
`await CAPURNION_VAULT_ACCESS.getSecret("exact-secret-name")`, fresh on every call. No message
endpoint lets a page or content script ask for arbitrary secrets; Okta sign-in hands its two named
secrets only to its host's top frame.

**Lock management** protects viewing and editing in the panel, not automation access. Closing the
panel, or five idle minutes, clears its secret fields, decrypted entries and key reference. Keep the
passphrase safe: it is not stored. A lost device key is restored by unlocking management, without
losing secrets, and a failed write leaves the previous passphrase and secrets usable. Setting
`vault.enabled` to `false` removes access and the panel but keeps the encrypted vault for later. The
profile holds the key for automatic decryption, so this does not protect against someone with that
profile or control of the extension; it is not a hardware-backed key or an OS keychain.

## CLI

| Command | |
|---|---|
| `capurnion init` | Create `rules.json` from the example and sync. |
| `capurnion list` | Every rule and whether it is on; whether renewal and Okta sign-in are on. |
| `capurnion probe` | Print the read-only page probe to run in a login tab. |
| `capurnion draft --from <json>` | Turn a probe result into a rule. |
| `capurnion test <url> [--text ...]` | Dry run; says exactly why a rule would not fire. |
| `capurnion validate` | Schema check; non-zero exit on error. |
| `capurnion sync` | Regenerate the manifest and shipped rules. |
| `capurnion doctor` | Rules valid? Generated files current? On macOS, loaded in Chrome? |
| `capurnion enable/disable <id>` | Flip a rule. |
| `capurnion add < rule.json` | Append a rule from stdin, validated. |

`bin/capurnion` works through a symlink, so it can go on your PATH (`ln -s "$PWD/bin/capurnion"
~/.local/bin/`). `test` runs `matcher.js` through Node: the file the browser runs, not a copy.

## How it is put together

| File | |
|---|---|
| `rules.json`, `rules.example.json` | Your gitignored config, the only file you edit; and the template `init` copies. |
| `manifest.json`, `rules.generated.js` | Generated by `sync`. Gitignored. |
| `matcher.js`, `engine.js` | Whether a rule fires (shared with the CLI); watching the page and clicking once. |
| `bin/capurnion`, `bin/evaluate.js`, `tools/probe.js` | The CLI, its bridge to `matcher.js`, and the page probe. |
| `background.js` | Loads the enabled capabilities into the service worker. |
| `okta-login-*.js` | Reads the Okta screens; hands over the vaulted credentials and the relay's code. |
| `snowflake-pat*.js`, `pat-popup.*` | Renewal in the check's tab; alarms, watchdog and results; the popup. |
| `okta-session.js`, `snowflake-sso-watch.js` | The Okta session check; the late-SSO watch. |
| `vault*.js`, `options.*` | Encryption, the device key and `getSecret`; the Settings & vault panel. |

## Troubleshooting

- **Nothing happened.** In the login page's DevTools console the engine logs `[capurnion] armed on
  <host>: <rule ids>`, why a rule cannot fire, and `[capurnion] clicked rule=...`. Silence means no
  enabled rule names that host, or you did not `sync` and reload.
- **`doctor` says STALE.** You edited `rules.json` without running `sync`.
- **`doctor` says gutted, or not loaded** (macOS). A Chrome protected-preferences reset unregisters
  every unpacked extension at once, silently. Turn Developer mode back on and Load unpacked again.
- **The label changed, or the button is in an iframe.** Update `click.label`, or set
  `"allFrames": true`; then `sync` and reload.
- **I need to sign in another way this once.** Switch the extension off at `chrome://extensions`.
- **A renewal failed.** The popup shows why; the watchdog retries at the next poll, and **Check now**
  retries at once. Okta sign-in logs `[capurnion-okta]` lines in the Okta page's console.
- **Okta says could not verify.** Your deployment lacks the session endpoint. Renewal still runs
  through your usual SSO flow; only the early detour to Okta is lost.
- **I moved the folder.** Chrome derives an unpacked extension's ID from the SHA-256 of its absolute
  path, so it is now a different extension: load it again. `doctor` prints the ID it expects.

## Contributing

Issues and PRs are welcome: **rules for common providers** in `rules.example.json` (disabled, with
`REPLACE-ME` hosts, never a real one), and **schema gaps**: adding a site should never mean editing
JavaScript. Keep matching logic in `matcher.js`, so the CLI and the extension cannot diverge. Run
`capurnion validate` before opening a PR, and never commit `rules.json`.

The tests need Node `^22.22.2`, `^24.15.0` or `>=26`, and Python 3. Run `npm install && npm test`.
The browser workflow tests skip, each with an install hint, until you run
`npx playwright install chromium`. Optional overrides point the tests at installs you already have:
`JSDOM_MODULE` (a jsdom module; it also runs the workflow tests on jsdom's simulated layout instead of
a browser), `PLAYWRIGHT_MODULE` (a Playwright module) and `CHROMIUM_EXECUTABLE` (a Chromium binary).
The vault tests simulate IndexedDB; they do not replace a check in live Chrome.

## The full guide

How each piece works, and how to set up Okta sign-in and token renewal end to end:
**[bricoleur.ai/projects/capurnion](https://bricoleur.ai/projects/capurnion)**.

<!-- bricoleur:footer -->
---
Part of **[bricoleur.ai](https://bricoleur.ai)** · [Full guide](https://bricoleur.ai/projects/capurnion) · MIT © 2026 DynamoFoundry LLC
<!-- /bricoleur:footer -->
