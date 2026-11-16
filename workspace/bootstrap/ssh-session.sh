#!/usr/bin/env bash
# Every SSH login to the editor runs this (sshd's ForceCommand, written by
# bootstrap/sshd.sh).
#
# - No command (an interactive client: Termius, Blink, `ssh editor`): attach
#   herdr, the same client the dashboard's /terminal/editor/ runs, so every
#   device shares one session. Without a herdr server, a login shell.
# - A command (`ssh editor ls`, scp, rsync, sftp -- whose subsystem path
#   arrives the same way): run it, in the pod's environment.
#
# sshd hands a session a near-empty environment, so the pod's (CODEX_HOME,
# GITHUB_TOKEN, ...) comes from the file sshd.sh wrote.
SSH_STATE_DIR="${SSH_STATE_DIR:-$HOME/.ssh}"
# shellcheck disable=SC1091
[ -r "$SSH_STATE_DIR/berth-env" ] && . "$SSH_STATE_DIR/berth-env"
export LANG="${LANG:-C.UTF-8}"
cd "${WORKSPACE_DIR:-$HOME}" 2>/dev/null || cd "$HOME"

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    # nvm puts node, claude and friends on PATH; a non-interactive bash would
    # not source it. Quietly: its output would corrupt an sftp/rsync stream.
    if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1
    fi
    exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo "No terminal: request one (ssh -t), or pass a command to run." >&2
    exit 1
fi

# A client that sends no usable TERM still gets colour and herdr's UI.
case "${TERM:-}" in
    ''|dumb|unknown) export TERM=xterm-256color ;;
esac

if [ "${HERDR_SERVER:-}" = true ] && command -v herdr >/dev/null 2>&1; then
    exec herdr
fi
exec /bin/bash -l
