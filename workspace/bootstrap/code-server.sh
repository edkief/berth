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
# terminals alive this long for a reconnect (default 3 h); five minutes gives
# the memory back soon after the editor is closed.
set -euo pipefail

case "${CODE_ENABLE:-}" in
    1|true|yes|on) ;;
    *) exit 0 ;;
esac

CODE_HOME="${CODE_HOME:-/workspace/_home/code-server}"
mkdir -p "$CODE_HOME/data/User" "$CODE_HOME/extensions"

# Workspace trust guards against running an untrusted checkout's code; here the
# agents already run this checkout with full access, and the prompt would only
# stand between the user and the integrated terminal. Seeded once, never over
# settings the user has since made their own.
SETTINGS="$CODE_HOME/data/User/settings.json"
if [ ! -e "$SETTINGS" ]; then
    printf '{\n    "security.workspace.trust.enabled": false\n}\n' > "$SETTINGS"
fi

exec code-server \
    --auth none \
    --bind-addr "0.0.0.0:${CODE_PORT:-7686}" \
    --config "$CODE_HOME/config.yaml" \
    --user-data-dir "$CODE_HOME/data" \
    --extensions-dir "$CODE_HOME/extensions" \
    --disable-telemetry \
    --disable-update-check \
    --reconnection-grace-time 300 \
    "${WORKSPACE_DIR:-/workspace}"
