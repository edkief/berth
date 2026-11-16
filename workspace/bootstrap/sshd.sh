#!/usr/bin/env bash
# sshd for the standalone editor (SSH_ENABLE), run by supervisord's
# [program:sshd] as ubuntu. entrypoint.sh decides whether it runs at all
# (editor mode, SSH_ENABLE, a non-empty keys file): see SSH_SERVER there.
#
# Non-root: sshd only needs root to switch users and to chroot its privsep
# child, and this one never does either -- a non-root sshd can only log in as
# the user it runs as. So: one user (ubuntu), public keys only, no PAM.
#
# Every start (so `supervisorctl restart sshd` picks up a rotated Secret):
#   1. authorized_keys is copied from the mounted Secret into ~/.ssh, mode 600.
#      The mount itself is a symlink into a root-owned ..data dir, and fsGroup
#      can leave its dirs group-writable; StrictModes (left on) refuses both.
#      ~/.ssh is on the container layer under a home owned by ubuntu.
#   2. Host keys are generated once, on the PVC, so a client sees the same
#      host after a restart or a reschedule. Their mode is reset each time:
#      fsGroup can widen it, and sshd refuses a group-readable key.
#   3. The pod env a login needs is written to a file the session sources:
#      sshd builds a session's environment from scratch. That includes what
#      herdr-core resolves its socket from (HC_*, XDG_*, when the pod sets
#      them), so `herdr-core connect` from the herdr app reaches the
#      supervised core instead of spawning a second one.
#   4. The config is written and sshd is exec'd in the foreground.
#
# SSH_DRY_RUN=1 stops before the exec and prints the config (tests).
set -euo pipefail

AUTHORIZED_KEYS="${SSH_AUTHORIZED_KEYS:-/run/secrets/ssh-authorized-keys/authorized_keys}"
STATE_DIR="${SSH_STATE_DIR:-$HOME/.ssh}"
HOST_KEY_DIR="${SSH_HOST_KEY_DIR:-/workspace/_home/ssh}"
SESSION="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ssh-session.sh"

PORT="${SSH_PORT:-2222}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "[sshd] SSH_PORT=$PORT is not a port; using 2222" >&2
    PORT=2222
fi

if [ ! -s "$AUTHORIZED_KEYS" ]; then
    # entrypoint.sh checked this already; the Secret went away since.
    echo "[sshd] $AUTHORIZED_KEYS is missing or empty; not starting" >&2
    exit 1
fi

umask 077
mkdir -p "$STATE_DIR" "$HOST_KEY_DIR"
chmod 700 "$STATE_DIR" "$HOST_KEY_DIR"

# 1. keys: cat follows the Secret's symlink; the copy is a plain 600 file.
cat "$AUTHORIZED_KEYS" > "$STATE_DIR/authorized_keys.tmp"
chmod 600 "$STATE_DIR/authorized_keys.tmp"
mv -f "$STATE_DIR/authorized_keys.tmp" "$STATE_DIR/authorized_keys"

# 2. host keys
for type in ed25519 rsa; do
    key="$HOST_KEY_DIR/ssh_host_${type}_key"
    if [ ! -s "$key" ]; then
        rm -f "$key" "$key.pub"
        if [ "$type" = rsa ]; then bits=(-b 3072); else bits=(); fi
        ssh-keygen -q -t "$type" "${bits[@]}" -N '' -C berth-editor -f "$key"
        echo "[sshd] generated $key"
    fi
    chmod 600 "$key"
    chmod 644 "$key.pub"
done

# 3. session env (printf %q keeps any value safe to source)
{
    for var in WORKSPACE_DIR CODEX_HOME PI_CODING_AGENT_DIR GITHUB_TOKEN GH_TOKEN \
               HERDR_SERVER HERDR_CORE_SERVER HC_SOCKET HC_SESSION \
               XDG_RUNTIME_DIR XDG_STATE_HOME XDG_CONFIG_HOME NVM_DIR TZ; do
        if [ -n "${!var:-}" ]; then
            printf 'export %s=%q\n' "$var" "${!var}"
        fi
    done
} > "$STATE_DIR/berth-env"
chmod 600 "$STATE_DIR/berth-env"

# 4. config. Not the distro's /etc/ssh/sshd_config, which assumes a root sshd.
CONFIG="$STATE_DIR/sshd_config"
cat > "$CONFIG" <<EOF
# Written by bootstrap/sshd.sh on every start; edits are overwritten.
Port $PORT
HostKey $HOST_KEY_DIR/ssh_host_ed25519_key
HostKey $HOST_KEY_DIR/ssh_host_rsa_key
PidFile none

UsePAM no
PermitRootLogin no
AllowUsers $(id -un)
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
AuthorizedKeysFile $STATE_DIR/authorized_keys
StrictModes yes

# Local forwards only (a dev server's port, say): a key holder already has a
# shell in the pod, so this opens nothing new. Nothing forwarded back in.
AllowTcpForwarding local
GatewayPorts no
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no
PermitUserEnvironment no

# Phones drop links without closing them; reap those sessions in ~2 min.
ClientAliveInterval 30
ClientAliveCountMax 4

# Every login, sftp included: the forced command runs the subsystem's path
# from SSH_ORIGINAL_COMMAND.
Subsystem sftp /usr/lib/openssh/sftp-server
ForceCommand $SESSION
EOF

if [ "${SSH_DRY_RUN:-}" = 1 ]; then
    cat "$CONFIG"
    exit 0
fi

echo "[sshd] listening on $PORT"
exec /usr/sbin/sshd -D -e -f "$CONFIG"
