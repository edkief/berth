#!/usr/bin/env bash
# The caller-supplied runner of an agent pod (WORKSPACE_MODE=agent), run by
# supervisord's [program:agent-runner] from the checkout.
#
# A script rather than an inline `command=`: AGENT_RUNNER_CMD is an arbitrary
# shell command, and interpolating it through supervisord's %(ENV_*)s would
# break on its quoting. supervisord's PATH has no nvm either, so it is loaded
# here, or a `node`/`npx` runner would not be found.
set -uo pipefail

export NVM_DIR="${NVM_DIR:-/home/ubuntu/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ -z "${AGENT_RUNNER_CMD:-}" ]; then
    # The entrypoint fails the bootstrap before supervisord without it, so
    # this is only a hand-started program; exit non-zero so it shows.
    echo "[agent-runner] AGENT_RUNNER_CMD is not set" >&2
    exit 2
fi

cd "${WORKSPACE_DIR:-/workspace}" || exit 1
exec /bin/bash -c "$AGENT_RUNNER_CMD"
