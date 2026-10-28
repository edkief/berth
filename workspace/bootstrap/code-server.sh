#!/usr/bin/env bash
# code-server (browser VS Code) on the workspace checkout, run by supervisord.
#
# Opt-in: without CODE_ENABLE this exits 0 at once, which supervisord's
# [program:code-server] treats as a clean finish (startsecs=0, exitcodes=0,
# autorestart=unexpected), so a workspace without the editor runs no process.
#
# --auth none: the ingress auth plus the NetworkPolicy are the boundary, as for
# ttyd and codexapp. The dashboard strips its /code/<id> prefix before
# forwarding, which code-server is built for: every URL it emits is relative.
#
# User data and extensions live on the repo PVC, beside CODEX_HOME, so
# settings and installed extensions survive a restart and a pod replace.
# --reconnection-grace-time: VS Code keeps a closed tab's extension host and
# terminals alive this long for a reconnect (VS Code's default is 3 h).
# CODE_RECONNECT_GRACE (seconds) sets it; unset, it follows WORKSPACE_MODE:
# - workspace: 5 min. The editor there is a quick look at what an agent did,
#   so the memory comes back soon after the tab closes.
# - editor: 8 h. The standalone editor is a long-lived dev environment: a task
#   started in its terminal must still be attached after the laptop sleeps.
set -euo pipefail

case "${CODE_ENABLE:-}" in
    1|true|yes|on) ;;
    *) exit 0 ;;
esac

CODE_HOME="${CODE_HOME:-/workspace/_home/code-server}"

if [ "${WORKSPACE_MODE:-workspace}" = "editor" ]; then
    default_grace=28800
else
    default_grace=300
fi
GRACE="${CODE_RECONNECT_GRACE:-$default_grace}"
if ! [[ "$GRACE" =~ ^[0-9]+$ ]]; then
    echo "[code-server] CODE_RECONNECT_GRACE=$GRACE is not a number of seconds; using $default_grace" >&2
    GRACE="$default_grace"
fi

mkdir -p "$CODE_HOME/data/User" "$CODE_HOME/extensions"

# First-run user settings, seeded once and never over settings the user has
# since made their own:
# - workspace trust guards against running an untrusted checkout's code; here
#   the agents already run this checkout with full access, and the prompt only
#   stood between the user and the integrated terminal.
# - VS Code's built-in chat starts a Copilot runtime (~100 MB) on the first
#   connect and keeps it after the tab closes. Claude and Codex are this
#   workspace's agents and there is no Copilot login, so it is off.
SETTINGS="$CODE_HOME/data/User/settings.json"
if [ ! -e "$SETTINGS" ]; then
    printf '%s\n' '{' \
        '    "security.workspace.trust.enabled": false,' \
        '    "chat.disableAIFeatures": true' \
        '}' > "$SETTINGS"
fi

exec code-server \
    --auth none \
    --bind-addr "0.0.0.0:${CODE_PORT:-7686}" \
    --config "$CODE_HOME/config.yaml" \
    --user-data-dir "$CODE_HOME/data" \
    --extensions-dir "$CODE_HOME/extensions" \
    --disable-telemetry \
    --disable-update-check \
    --reconnection-grace-time "$GRACE" \
    "${WORKSPACE_DIR:-/workspace}"
