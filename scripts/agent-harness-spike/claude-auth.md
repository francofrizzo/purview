# Claude authentication spike — bounded, not a product adapter

## Decision

**Custom Purview Claude.ai OAuth is prohibited; independent sign-in through the
unmodified Claude Code binary is a distinct, documented case.** Do not implement
a custom OAuth client, collect tokens, copy CLI credentials, or infer permission
from a working technical experiment. The published policy directs third-party
applications, including Agent SDK applications, to API keys or supported cloud
providers, while explicitly allowing end users to sign into hosted unmodified
Claude Code under its stated conditions. This does not establish that a separate
configuration directory or the proposed Purview integration is prohibited. This
spike neither collects nor stores keys or tokens.

The Mac diagnostic below tests that binary's credential separation, not a custom
Purview login. Product design must preserve the official flow and determine
whether its particular CLI or SDK integration meets the published conditions;
seek clarification from Anthropic if that remains ambiguous.

```text
Purview-owned auth ── API key / supported cloud credentials (documented path)
                  └─ custom Claude.ai OAuth ── BLOCKED by published policy
Diagnostic only ──── unmodified Claude Code login, isolated test OS account
```

## Authoritative evidence

Official live documentation consulted for this spike (2026-10-21); these pages
are mutable and are **not** a versioned specification for 2.1.305:

1. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
   “Authentication and credential use”: developers including Agent SDK users
   should use API keys or supported cloud providers; “Anthropic does not permit
   third-party developers to offer Claude.ai login into their own applications”.
   Developers may not collect, store or intermediate Claude.ai session tokens.
   “Can customers offer Claude Code in their products?” permits unmodified binary
   hosting under its stated conditions, with each user authenticating themselves.
2. [Authentication](https://code.claude.com/docs/en/authentication), “Credential
   management”: macOS uses encrypted Keychain; failed OAuth Keychain writes may
   fall back to `.credentials.json` (0600). Linux uses that file. The page
   explicitly says `CLAUDE_CONFIG_DIR` relocates the file **and keys the Keychain
   entry to that directory**. This is a documented claim, not a Mac observation
   made here. We have not established the exact service-name/hash derivation for
   the pinned binary; do not hardcode or delete a guessed Keychain service.
3. The same page, “Log in with multiple accounts” and “Sign in without an API
   key”: separate config directories do **not** isolate keyless Console profiles;
   those live outside the Claude config directory. That Console flow can sign
   out an existing claude.ai login. `CLAUDE_CONFIG_DIR` alone is not a universal
   credential-isolation boundary.
4. The same page documents `claude setup-token` (one-year subscription token,
   printed rather than saved), `CLAUDE_CODE_OAUTH_TOKEN`, API keys,
   `apiKeyHelper`, cloud authentication and credential precedence. None converts
   subscription OAuth into supported Purview-owned login. Do not use setup-token
   as a workaround or send its output to a thread.
5. Local published package manifest:
   `node_modules/@anthropic-ai/claude-agent-sdk/package.json` declares SDK
   `0.3.305` and `claudeCodeVersion: 2.1.305`. The installed Anthropic Linux
   binary itself reports `2.1.305`; `auth status --help` documents JSON output.

## Observed in Linux (no credentials)

From this directory:

```sh
node --test claude-auth.test.mjs
node claude-auth.mjs --preflight
```

Three tests passed: explicit environment allowlist, pinned real-binary logged-out
status using empty stores, rejection of `--login`. The runner prints only:

```json
{"sdk":"0.3.305","cli":"2.1.305","loggedIn":false,"oauthStarted":false,"modelRequested":false}
```

The runner creates disposable HOME/config/XDG/tmp paths with restrictive modes,
uses a neutral working directory, does not inherit credential/provider/profile
variables, captures raw child output, enforces a timeout, and cleans up in
`finally`. It does not call SDK query, model inference, login, logout or OAuth.
It refuses macOS rather than risking a personal Keychain probe. System-managed
policy remains outside this isolation; this is not an OS sandbox or proof of
zero network traffic from the binary. No real credential files, `~/.purview`, or
port 4779 are involved. No dependencies or shared harness files were changed.

## Mac handoff — pending, human-operated diagnostic only

Use a **disposable macOS OS account with its own login Keychain**, not just a
temporary HOME inside the personal account. Do not import credentials or unlock
the personal Keychain. Use a separate browser profile and a test account whose
owner explicitly consents. Do not record login, URLs, codes, status account data
or terminal output. No agent should initiate this flow. If policy approval is
absent, stop at logged-out status/help and leave real login pending.

In that disposable OS account, install the existing lockfile dependencies, then
run these commands in `scripts/agent-harness-spike` (normal macOS zsh):

```sh
umask 077
BIN="$PWD/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$(uname -m | sed 's/x86_64/x64/')/claude"
"$BIN" --version                         # must report 2.1.305
ROOT=$(mktemp -d /tmp/purview-claude-auth.XXXXXX)
mkdir "$ROOT/home" "$ROOT/a" "$ROOT/b" "$ROOT/xdg" "$ROOT/tmp"
probe() {
  env -i HOME="$ROOT/home" CLAUDE_CONFIG_DIR="$1" \
    XDG_CONFIG_HOME="$ROOT/xdg" TMPDIR="$ROOT/tmp" \
    PATH=/usr/bin:/bin LANG=en_US.UTF-8 "$BIN" "${@:2}"
}
cd "$ROOT"
probe "$ROOT/a" auth status --json       # expect loggedIn:false (exit 1)
probe "$ROOT/b" auth status --json       # expect loggedIn:false (exit 1)
probe "$ROOT/a" auth login --help        # inspect supported options, no login
```

Only with the above approval and direct human control:

```sh
probe "$ROOT/a" auth login               # Anthropic's own unmodified flow
probe "$ROOT/a" auth status --json       # inspect privately: logged in
probe "$ROOT/b" auth status --json       # must still be logged out
```

Choose claude.ai only for this diagnostic; **do not choose keyless Console**.
If unexpected existing identity appears, stop without logout: it could revoke
another store's credential. Inspect Keychain Access in this disposable account
for metadata only (never “Show password”, `security ... -w`, or a keychain dump).
Record whether A added a distinct entry and whether fallback file exists; if a
file exists, check permissions without reading its contents. Do not claim
Keychain isolation from a successful login alone. Locked-Keychain fallback,
refresh, restart persistence, B login/A logout independence and actual model
inference all remain unverified. Real inference would incur billing and needs
separate explicit approval; this runner deliberately offers no model mode.

After the diagnostic, revoke only the disposable test login through Anthropic's
flow in that OS account, remove ROOT, and delete the disposable OS account and
its Keychain through macOS account management. Deleting ROOT alone does not
delete Keychain credentials. Do not run logout against the personal account.
Report only version/architecture, booleans for A/B status and entry separation,
file modes, and pass/fail — never raw status JSON, tokens, email or login URL.

**Still pending:** real Mac execution, exact pinned Keychain namespace behavior,
independent credential lifecycle, provider-approved Purview authentication UX,
API-key secret-storage design and any product adapter. The existing Codex
44/44 + OAuth/model result does not establish any of these Claude properties.
