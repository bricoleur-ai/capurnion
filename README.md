# Capurnion

A Chrome extension that clicks **"Sign in with &lt;provider&gt;"** buttons for you.

If you use SSO, you know the tax: every session expiry drops you on a login page whose
only purpose is to make you click one button before it sends you to your identity
provider. Capurnion clicks it. Manifest V3, no runtime dependencies, and no build step.
It can also renew temporary access for Snowflake programmatic access tokens using an
explicitly configured hourly workflow and store secrets in a local encrypted vault.

It is configured by a single JSON file and a CLI, so an agent driving your browser can
add a new site on its own — including reading the login page to find the button.

```bash
git clone <this repo> ~/projects/capurnion
cd ~/projects/capurnion
./bin/capurnion init          # creates your private rules.json, all rules off
```
Then `chrome://extensions` → Developer mode → **Load unpacked** → the folder you cloned.

## Your config never enters the repo

`rules.json` names the hosts you log into. That holds no credentials, but it does
describe your employer, your vendors, and your tenant, so it is **gitignored**. So are
the two files generated from it, `manifest.json` and `rules.generated.js`, since host
permissions are derived from your enabled rules.

What is tracked is `rules.example.json`: the same rules with `REPLACE-ME` hosts and
everything disabled. `capurnion init` copies it to `rules.json` for you.

This means a fresh clone will not load in Chrome until you run `capurnion init` (or at
least `capurnion sync`) to generate the manifest. That is deliberate — an empty,
permissionless extension is a better default than one that ships someone else's hosts.

## Adding a site

### With an agent driving Chrome

The agent needs to see the page to know what to click, so there is a read-only probe for
exactly that. In the tab sitting on the login page:

```bash
capurnion probe            # prints a JS snippet — run it in the page
```

Run it with Claude in Chrome's `javascript_tool`, Playwright's `page.evaluate`, or
DevTools. It reads the page and returns the host, the headings you could guard on, and
every clickable label with SSO-looking ones sorted first. It clicks nothing.

Save that JSON and hand it to `draft`:

```bash
capurnion draft --from probe.json
#   * [ 0] Sign in with Okta
#   * [ 1] Continue with Google
#     [ 2] Sign in

capurnion draft --from probe.json --pick 0 --id acme-okta \
    --guard "sign in to acme" --add
capurnion sync
```

`draft` refuses to create a rule with no page guard, and prints the page's own headings
as ready-to-paste `--guard` values.

### By hand

Edit `rules.json`, then `capurnion test <url> --text "<text on the page>"` until it says
`WOULD FIRE`, then `capurnion sync`.

Starting from one of the `example-*` rules? Replace its `REPLACE-ME` host **before**
enabling it — `capurnion enable` refuses a rule that still has a placeholder host, and
leaves the file unwritten.

Either way, finish by hitting **reload** on the Capurnion card at `chrome://extensions`.
Content scripts and host permissions do not update until you do — `capurnion doctor`
reports it as `STALE` if you forget.

## Rule schema

```json
{
  "id": "acme-okta",
  "description": "Acme's login page -> Okta",
  "enabled": true,
  "kind": "idp-select",
  "hosts": ["app.acme.com", "*.acme-corp.com"],
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
| `kind` | yes | Safety tier — see below. |
| `hosts` | yes | Bare hostnames. `*.example.com` matches subdomains and the apex. |
| `require.pageText` | no | Case-insensitive regex the page's visible text must match. |
| `require.url` | no | Case-insensitive regex the full URL must match. |
| `click.label` | yes | Case-insensitive regex matched against the button's visible label. |
| `click.selector` | no | CSS override. Default: `button, a, [role=button], input[type=submit\|button]`. |
| `options.timeoutMs` | no | Stop watching the page after this. Default 15000. |
| `options.delayMs` | no | Wait before clicking; re-checks the button is still there. |
| `allFrames` | no | Also run inside iframes, for framed consent screens. |
| `confirmGrantsAccess` | consent only | Must be `true` for a `consent-grant` rule to run. |

A rule fires when **every** guard passes. With no `require` at all it will click any
matching button anywhere on those hosts, and `validate` warns about it.

## Security model

Capurnion has no host permissions except the ones your enabled rules and capabilities
ask for. It makes no direct API requests. SSO rules read the DOM and call `.click()`;
the optional Snowflake capability adds a service worker, alarms, and local status storage.

SSO rules never fill a field or touch a password form and click at most **once per
page load**. The Snowflake workflow fills only the bypass duration and performs its
specific sequence of clicks in a dedicated tab.

### Safety tiers

| `kind` | Clicks | |
|---|---|---|
| `idp-select` | "Sign in with Okta / Google / Microsoft / SSO" | Navigational — it picks which identity provider to use and grants nothing. This is the default and covers almost every case. |
| `session-continue` | "Continue as &lt;user&gt;", "Stay signed in?" | Grants nothing, but clicks past a screen you may have wanted to read. |
| `consent-grant` | "Allow" / "Authorize" on an OAuth consent screen | **Grants an application access to your account.** Requires `"confirmGrantsAccess": true`; the engine refuses to run it otherwise, and `validate` errors if it is enabled without the flag. |

Scope a `consent-grant` rule to one host. Pointed at a shared IdP domain such as
`accounts.google.com` or `login.microsoftonline.com`, it would blanket-approve every
application that asks.

**MFA prompts are deliberately unsupported.** There is no tier for them: the extension
cannot distinguish an MFA "Approve" from a consent "Allow", and auto-clicking one
defeats the second factor. Don't write a rule targeting a push-approval screen.

## Hourly Snowflake PAT renewal

This optional capability opens a **new, inactive tab** on one account's Authentication
settings page each hour. Existing Capurnion SSO rules run normally through login
redirects. Renewal starts only after the Programmatic access tokens section loads.
The tab closes after the check, including failed checks. If you activate the tab,
automation stops and leaves it open for you.

For each token on the **Active** list with fewer than two hours of temporary access
remaining, it opens that row's **More options** menu, selects **Bypass requirement for
network policy**, fills **24**, selects **Hours**, and clicks **Grant access**. It checks
the form and row identity before submission and waits for the same token to show
23–24 hours of temporary access afterward. Token expiration dates are unchanged.
Tokens at exactly two hours, without a bypass timer, or with an unrecognized timer
are skipped. Missing network policy alone never triggers a grant.

Configure it in the private `rules.json`, alongside `version` and `rules`:

```json
"snowflakePat": {
  "enabled": true,
  "confirmGrantsAccess": true,
  "url": "https://app.snowflake.com/your-org/your-account/settings/authentication",
  "expectedUser": "your-snowflake-user",
  "intervalMinutes": 60,
  "renewBelowMinutes": 120,
  "grantHours": 24
}
```

Use the username shown in the account menu's accessible label. The URL must name
one exact HTTPS account settings page; wildcards and shared IdP hosts are rejected.
The access-grant flag is a deliberate opt-in to renewing this network-policy
requirement exception. This capability does not use the SSO rule safety tiers.

Run `capurnion validate`, then `capurnion sync`, then manually reload Capurnion at
`chrome://extensions`. The first check runs when the capability is first loaded,
on browser startup, and hourly afterward. **Chrome must be running and Snowflake
must have an authenticated session or complete its configured SSO flow.** Chrome
alarms do not wake a sleeping computer; a missed check runs after wake.

Click the extension's toolbar icon for the last result, token timers, expiration
dates, and **Check now**, **Pause**, or **Resume**. A `!` badge indicates a failed
check or skipped, unrecognized timers. Checks cannot overlap. A three-minute
deadline closes a check that cannot finish login or whose page has changed.
The extension stores only token names, displayed timers/dates, and check results;
it never reads or saves token secrets.

Set `snowflakePat.enabled` to `false`, sync, and reload to remove the capability
and its added permissions. With no enabled capability, the SSO extension keeps
its original behavior.

## Local encrypted vault and browser settings

Add `"vault": { "enabled": true }` alongside `version` and `rules` in your private
`rules.json`, sync, then reload. Open **Settings & vault** from the toolbar popup,
or use Capurnion's **Extension options** on its Chrome extension details page.
When the vault is the only enabled capability, clicking the toolbar icon opens
the settings panel directly.

Create a vault with your own passphrase of at least 12 characters. The panel lets
you add, edit, reveal, and delete named secrets and change the vault passphrase.
Names and values are encrypted together in this Chrome profile's local extension
storage. Secret values and the passphrase are never written to `rules.json`, the
generated configuration, browser sync storage, or messages to the page scripts.

Encryption uses native Web Crypto AES-256-GCM, a fresh 96-bit nonce on every save,
and a key derived with PBKDF2-HMAC-SHA-256 (600,000 iterations and a random 128-bit
salt). The non-exportable decryption key is persisted as a `CryptoKey` in the
extension's local IndexedDB so automations retain access after the settings panel
closes, the background worker restarts, and Chrome restarts. No raw key export or
stored passphrase is needed. Enabling the vault adds `unlimitedStorage` to protect
its IndexedDB key from storage eviction; it adds no website permissions. Chrome supports [IndexedDB in extension service
workers](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies#access_in_service_workers).

**Lock management** protects viewing and editing through the settings panel. It
does not revoke automation access. Closing the panel or five idle minutes clears
the panel's secret fields, decrypted entries, and in-memory key reference. Another
panel changing the vault also locks stale views; concurrent writes use a browser
lock and revision checks. The settings panel shows automation availability
separately from its management lock state.

This encrypts stored secret contents, but the same browser profile contains the
key required for automatic decryption. It does not protect against an attacker
with access to that profile or control of the extension. A non-exportable key
can still be used for decryption; it is not a hardware-backed key or an OS
keychain integration.

The vault passphrase is not retained, so keep it somewhere you can recover it.
Existing vaults gain persistent access the next time you unlock management. If the
device key is lost, unlocking management restores it from your passphrase without
losing secrets. Changing the passphrase replaces the device key and preserves
automation access. A key-storage failure stops a save before replacing the
ciphertext; a failed ciphertext write leaves the previous key usable.

Background automation code can call
`await CAPURNION_VAULT_ACCESS.getSecret("exact-secret-name")` to retrieve one saved
value. Each call reads the current vault; values are not cached across calls, and
the key is loaded again after worker restarts. This API is loaded only in trusted
extension contexts. There is no runtime message endpoint that lets a webpage or
content script request arbitrary secrets. Site-specific credential filling must
be wired into an explicitly configured automation; the existing SSO engine still
only clicks buttons. The hourly Snowflake renewal continues independently of
the management lock. Setting `vault.enabled` to `false` disables vault access and
removes the panel after sync/reload, while retaining the encrypted vault and device
key for a later re-enable.

## Okta auto-login (vault + an SMS code relay)

This optional capability signs you in to a single Okta tenant **in the browser**,
end to end: on the Okta sign-in page it fills your **email and password from the
vault**, then completes the **SMS** factor by selecting the Phone option,
requesting the code, fetching it from a small HTTP relay you run, and clicking
Verify. Combine it with an ordinary `idp-select` rule on an app's login page and a
cold visit becomes a hands-off sign-in: *click "Sign in with Okta" → Okta fills
and verifies itself → back in the app.*

It automates your **second factor**, so it is a deliberate opt-in. Enable it only
for your own account on your own machine.

Configure it in the private `rules.json`, alongside `version` and `rules`:

```json
"oktaLogin": {
  "enabled": true,
  "confirmAutomatesMfa": true,
  "host": "yourtenant.okta.com",
  "usernameSecret": "ou",
  "passwordSecret": "op",
  "smsCodeUrl": "http://your-relay-host:8787/code?client=your-client"
}
```

- `confirmAutomatesMfa` must be literally `true`, or sync refuses it — the same
  deliberate-opt-in gate as `consent-grant` and the Snowflake capability. It fills
  your password and completes your SMS second factor without you present.
- `host` is the one Okta hostname (e.g. `yourtenant.okta.com`). The content script
  runs only there, top frame only.
- `usernameSecret` / `passwordSecret` name entries in the **vault** (so
  `vault.enabled` must be `true`). The password is decrypted only in the service
  worker and handed to the page just long enough to type it; it is never written
  to `rules.json` or the generated config.
- `smsCodeUrl` is any endpoint that returns `{"code":"123456"}` when a code is
  ready and a non-200 otherwise. A tiny companion relay — a phone forwards the
  2FA text to it, your automation fetches the parsed code once — is exactly the
  **2fu** project's job; any equivalent endpoint works. Its origin is added to the
  manifest's `host_permissions` so the service worker can fetch it. Keep
  the relay on a trusted network (it carries your one-time codes in the clear).

Add the two secrets to the vault (**Settings & vault**) under the names you chose
(`ou`, `op`), unlock management once so automation access is enabled on the
device, run `capurnion sync`, then reload. The engine still never fills
credentials on its own; this is the explicitly-configured automation the vault is
designed to serve.

It only ever drives the SMS/Phone factor. It never approves an Okta Verify push
and never fills a password-less step-up screen.

## CLI

| Command | |
|---|---|
| `capurnion init` | Create `rules.json` from the example and sync. |
| `capurnion list` | Every rule and whether it is on. |
| `capurnion probe` | Print the read-only page probe to run in a login tab. |
| `capurnion draft --from <json>` | Turn a probe result into a rule. |
| `capurnion test <url> [--text ...]` | Dry-run; says exactly why a rule would not fire. |
| `capurnion validate` | Schema check; non-zero exit on error. |
| `capurnion sync` | Regenerate the manifest and shipped rules. |
| `capurnion doctor` | Rules valid? generated files current? extension actually loaded? |
| `capurnion enable/disable <id>` | Flip a rule. |
| `capurnion add < rule.json` | Append a rule from stdin, validated. |

`test` runs `matcher.js` through node — the *same* file the browser runs — rather than a
second copy of the logic that could quietly disagree with it. That needs `node` on PATH;
the extension itself does not.

## How it is put together

| File | |
|---|---|
| `rules.json` | Your config. The only file you edit. Gitignored. |
| `rules.example.json` | The tracked template `init` copies from. |
| `matcher.js` | Decides whether a rule fires. Shared by the extension and the CLI. |
| `engine.js` | Browser side: watches the DOM, finds the button, clicks once. |
| `tools/probe.js` | Read-only page inspector for agents. |
| `bin/capurnion` | The CLI. |
| `snowflake-pat.js` | Scoped token inspection and renewal workflow. |
| `snowflake-pat-content.js` | Starts renewal only in the scheduler's dedicated tab. |
| `snowflake-pat-background.js` | Hourly alarms, tab lifecycle, and stored results. |
| `background.js` | Loads enabled capabilities and restricts local storage to extension contexts. |
| `pat-popup.*` | Check results and pause/manual-check controls. |
| `vault.js` | Native encryption and passphrase derivation. |
| `vault-device-key.js` | Persists non-exportable decryption keys in extension-local IndexedDB. |
| `vault-runtime.js` | Retrieves named secrets for trusted automation code, independent of the panel lock. |
| `options.*` | Browser configuration panel and vault controls. |
| `manifest.json`, `rules.generated.js` | Generated by `sync`. Gitignored. |

Adding support for a site never means editing JavaScript. If you find yourself wanting
to, that is a gap in the schema worth reporting.

## Troubleshooting

- **Nothing happened.** Open the DevTools console on the login page. The engine logs
  `[capurnion] armed on <host>: <rule ids>` when it loads, why a rule cannot fire, and
  `[capurnion] clicked rule=...` when it does. Total silence means no enabled rule names
  that host, or you did not `sync` and reload.
- **`doctor` says STALE.** You edited `rules.json` without running `sync`; the browser is
  still running the old rules.
- **`doctor` says gutted / not loaded.** A Chrome protected-preferences reset
  unregisters every unpacked extension at once, silently. Turn Developer mode back on and
  Load unpacked again.
- **The label changed.** Update `click.label`, `sync`, reload.
- **I need to log in a different way this once.** Toggle the extension off at
  `chrome://extensions` — faster than disabling a rule, and no sync needed.
- **The button is inside an iframe.** Set `"allFrames": true` and `sync`.

Chrome derives an unpacked extension's ID from the SHA-256 of its absolute path, so
moving the folder makes it a different extension and it must be re-installed.
`capurnion doctor` prints the ID it expects.

## Contributing

Issues and PRs welcome. Useful things:

- **Rules for common providers**, added to `rules.example.json` — disabled, with
  `REPLACE-ME` hosts, never a real one.
- **Schema gaps** — any site that cannot be expressed without editing `engine.js`.
- Keep matching logic in `matcher.js` so the CLI and the extension cannot diverge.

Run `capurnion validate` before opening a PR. Never commit `rules.json`.

For the PAT capability, run `node --test tests/snowflake-pat-background.test.js`
and `python3 -B tests/snowflake-pat-cli.test.py`. The DOM workflow tests are in
`tests/snowflake-pat-workflow.test.js`; run them with Playwright installed, or set
`JSDOM_MODULE` to an installed jsdom module for simulated-layout checks. Optional
`PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` select existing test installations.
These are development-only dependencies and the extension needs none of them.
The vault cryptography and persistent-access tests run with
`node --test tests/vault.test.js tests/vault-runtime.test.js`; the panel tests use
jsdom (`JSDOM_MODULE=<path-to-jsdom> node --test tests/vault-panel.test.js`). Storage
tests simulate browser IndexedDB with native CryptoKey cloning. They cover worker
restarts, management locks, migration, updates, passphrase changes, tampering,
and failed writes; they do not replace a live Chrome persistence check.

## License

MIT — see [LICENSE](LICENSE). © 2026 DynamoFoundry LLC.

Part of the [Bricoleur.ai](https://bricoleur.ai) ecosystem.
