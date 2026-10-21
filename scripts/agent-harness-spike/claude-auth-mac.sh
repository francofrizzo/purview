#!/bin/zsh
# Mac diagnostic for claude-auth.md: run inside a DISPOSABLE macOS account with
# its own login Keychain, by a person, phase by phase. Prints versions, exit
# codes and booleans only: never status JSON, URLs, codes, emails or tokens.
#
#   ./claude-auth-mac.sh preflight   # version, A and B logged out, login --help exists
#   ./claude-auth-mac.sh login       # Anthropic's own `auth login` in A (choose claude.ai, never keyless Console)
#   ./claude-auth-mac.sh verify      # A logged in, B still logged out, fallback file modes
#   ./claude-auth-mac.sh cleanup     # removes ROOT only; the Keychain entry and the OS account are deleted by hand
set -u
umask 077
HERE=${0:A:h}
BIN="$HERE/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$(uname -m | sed 's/x86_64/x64/')/claude"
ROOT="$HOME/purview-claude-auth-root"
phase=${1:-}

probe() {  # probe <config dir> <claude args...>
  env -i HOME="$ROOT/home" CLAUDE_CONFIG_DIR="$1" XDG_CONFIG_HOME="$ROOT/xdg" TMPDIR="$ROOT/tmp" \
    PATH=/usr/bin:/bin LANG=en_US.UTF-8 "$BIN" "${@:2}"
}
# `auth status --json` → prints "<label>: loggedIn=<bool> exit=<code>" and nothing else.
status() {
  local out code
  out=$(probe "$ROOT/$1" auth status --json 2>/dev/null); code=$?
  local flag=$(printf '%s' "$out" | grep -o '"loggedIn": *\(true\|false\)' | head -1 | grep -o 'true\|false')
  echo "$1: loggedIn=${flag:-unparsed} exit=$code"
}
modes() {  # file modes only, never contents
  for f in "$ROOT/$1/.credentials.json" "$ROOT/$1/.claude.json"; do
    [ -e "$f" ] && echo "$1: $(basename "$f") mode=$(stat -f %Lp "$f")" || echo "$1: $(basename "$f") absent"
  done
}

case "$phase" in
  preflight)
    [ "$(id -un)" != "francofrizzo" ] || { echo "Refusing: run this in the disposable account, not the personal one."; exit 2; }
    echo "user=$(id -un) macos=$(sw_vers -productVersion) arch=$(uname -m)"
    echo "claude=$(env -i PATH=/usr/bin:/bin HOME="$HOME" "$BIN" --version 2>&1 | head -1)"
    mkdir -p "$ROOT/home" "$ROOT/a" "$ROOT/b" "$ROOT/xdg" "$ROOT/tmp"
    cd "$ROOT"
    status a; status b
    probe "$ROOT/a" auth login --help >/dev/null 2>&1 && echo "login --help: ok" || echo "login --help: exit $?"
    modes a; modes b
    ;;
  login)
    cd "$ROOT" && probe "$ROOT/a" auth login
    echo "login exit=$?"
    ;;
  verify)
    cd "$ROOT"
    status a; status b
    modes a; modes b
    echo "Now open Keychain Access in this account, search 'Claude', and note: how many entries, and whether their names carry a hash. Do not open or reveal any password."
    ;;
  cleanup)
    rm -rf "$ROOT" && echo "ROOT removed. Revoke the test login through Anthropic's flow, then delete this OS account and its Keychain in System Settings."
    ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
