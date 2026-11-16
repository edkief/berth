'use strict';

// SSH into the standalone editor (SSH_ENABLE): a non-root sshd, supervised,
// public keys only, whose logins attach herdr or run the client's command.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const ENTRYPOINT = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');
const SSHD = path.join(WORKSPACE, 'bootstrap', 'sshd.sh');
const SESSION = path.join(WORKSPACE, 'bootstrap', 'ssh-session.sh');

/** A `[program:<name>]` section of the workspace's supervisord config, as key=value pairs. */
function program(name) {
    const source = fs.readFileSync(path.join(WORKSPACE, 'supervisord.conf'), 'utf8');
    const match = source.match(new RegExp(`^\\[program:${name}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'));
    assert.ok(match, `[program:${name}] is missing`);
    return Object.fromEntries(match[1].split('\n')
        .filter((line) => /^\w+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

/** Run the entrypoint's mode block through the SSH_SERVER gate; report SSH_SERVER. */
function modeBlock(env) {
    const start = ENTRYPOINT.indexOf('export WORKSPACE_MODE=');
    const gate = ENTRYPOINT.indexOf('export SSH_SERVER=false');
    assert.ok(start > 0 && gate > start, 'mode block not found');
    const end = ENTRYPOINT.indexOf('\nfi\n', gate) + 4;
    const script = `${ENTRYPOINT.slice(start, end)}\necho "$SSH_SERVER"`;
    return execFileSync('/bin/bash', ['-c', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'berth-ssh-'));
const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);

test('supervisord runs sshd.sh as ubuntu, autostarted by SSH_SERVER', () => {
    const p = program('sshd');
    assert.equal(p.command, '/home/ubuntu/bootstrap/sshd.sh');
    assert.equal(p.user, 'ubuntu');
    assert.equal(p.autostart, '%(ENV_SSH_SERVER)s');
    // A crash restarts; a start that cannot succeed ends FATAL, not a loop.
    assert.equal(p.autorestart, 'unexpected');
    assert.equal(p.startretries, '3');
});

test('sshd runs only in editor mode, with SSH_ENABLE and a keys file', () => {
    const dir = tmp();
    const keys = path.join(dir, 'authorized_keys');
    fs.writeFileSync(keys, 'ssh-ed25519 AAAA test\n');
    const empty = path.join(dir, 'empty');
    fs.writeFileSync(empty, '');
    const cases = [
        [{}, 'false'],
        [{ SSH_ENABLE: '1', SSH_AUTHORIZED_KEYS: keys }, 'false'],
        [{ WORKSPACE_MODE: 'workspace', SSH_ENABLE: '1', SSH_AUTHORIZED_KEYS: keys }, 'false'],
        [{ WORKSPACE_MODE: 'editor', SSH_AUTHORIZED_KEYS: keys }, 'false'],
        [{ WORKSPACE_MODE: 'editor', SSH_ENABLE: '0', SSH_AUTHORIZED_KEYS: keys }, 'false'],
        // Enabled, but nobody to let in: off, never a crash loop.
        [{ WORKSPACE_MODE: 'editor', SSH_ENABLE: '1', SSH_AUTHORIZED_KEYS: path.join(dir, 'absent') }, 'false'],
        [{ WORKSPACE_MODE: 'editor', SSH_ENABLE: '1', SSH_AUTHORIZED_KEYS: empty }, 'false'],
        [{ WORKSPACE_MODE: 'editor', SSH_ENABLE: '1', SSH_AUTHORIZED_KEYS: keys }, 'true'],
        [{ WORKSPACE_MODE: 'editor', SSH_ENABLE: 'true', SSH_AUTHORIZED_KEYS: keys }, 'true'],
    ];
    for (const [env, expected] of cases) {
        assert.equal(modeBlock({ PATH: process.env.PATH, ...env }), expected, JSON.stringify(env));
    }
});

/** Run sshd.sh up to (not including) the exec, in a sandbox. */
function dryRun(t, extra = {}) {
    const dir = tmp();
    const secret = path.join(dir, 'secret');
    fs.mkdirSync(path.join(secret, '..data'), { recursive: true });
    fs.writeFileSync(path.join(secret, '..data', 'authorized_keys'), 'ssh-ed25519 AAAA test\n');
    // As a Secret volume mounts it: a symlink into ..data.
    fs.symlinkSync('..data/authorized_keys', path.join(secret, 'authorized_keys'));
    const env = {
        PATH: process.env.PATH,
        HOME: dir,
        SSH_AUTHORIZED_KEYS: path.join(secret, 'authorized_keys'),
        SSH_STATE_DIR: path.join(dir, 'state'),
        SSH_HOST_KEY_DIR: path.join(dir, 'pvc', 'ssh'),
        SSH_DRY_RUN: '1',
        ...extra,
    };
    const r = spawnSync('/bin/bash', [SSHD], { env, encoding: 'utf8' });
    return { dir, env, ...r };
}

const hasKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;

test('the config is public-key only, one user, with herdr as the forced command', { skip: !hasKeygen && 'no ssh-keygen' }, (t) => {
    const { status, stdout, stderr, env } = dryRun(t);
    assert.equal(status, 0, stderr);
    const conf = Object.fromEntries(stdout.split('\n')
        .filter((l) => /^[A-Z]/.test(l))
        .map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
    assert.equal(conf.Port, '2222');
    assert.equal(conf.UsePAM, 'no');
    assert.equal(conf.PasswordAuthentication, 'no');
    assert.equal(conf.KbdInteractiveAuthentication, 'no');
    assert.equal(conf.PubkeyAuthentication, 'yes');
    assert.equal(conf.PermitRootLogin, 'no');
    assert.equal(conf.StrictModes, 'yes');
    assert.equal(conf.AllowUsers, os.userInfo().username);
    assert.equal(conf.AuthorizedKeysFile, path.join(env.SSH_STATE_DIR, 'authorized_keys'));
    assert.equal(conf.ForceCommand, SESSION);
    assert.equal(conf.Subsystem, 'sftp /usr/lib/openssh/sftp-server');
    assert.match(stdout, /^HostKey .*\/pvc\/ssh\/ssh_host_ed25519_key$/m);
});

test('keys are copied private; host keys are made once and kept private', { skip: !hasKeygen && 'no ssh-keygen' }, (t) => {
    const first = dryRun(t);
    assert.equal(first.status, 0, first.stderr);
    const keys = path.join(first.env.SSH_STATE_DIR, 'authorized_keys');
    assert.ok(!fs.lstatSync(keys).isSymbolicLink());
    assert.equal(mode(keys), '600');
    assert.equal(mode(first.env.SSH_STATE_DIR), '700');

    const host = path.join(first.env.SSH_HOST_KEY_DIR, 'ssh_host_ed25519_key');
    const before = fs.readFileSync(host);
    fs.chmodSync(host, 0o660); // what fsGroup can do to it
    const again = spawnSync('/bin/bash', [SSHD], { env: first.env, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(fs.readFileSync(host), before, 'host key regenerated');
    assert.equal(mode(host), '600');
});

test('the session env is written safely quoted, and a bad port falls back', { skip: !hasKeygen && 'no ssh-keygen' }, (t) => {
    const { status, stdout, stderr, env } = dryRun(t, {
        SSH_PORT: 'twenty', GITHUB_TOKEN: "x y'z", HERDR_SERVER: 'true', WORKSPACE_DIR: '/workspace',
    });
    assert.equal(status, 0, stderr);
    assert.match(stdout, /^Port 2222$/m);
    const file = path.join(env.SSH_STATE_DIR, 'berth-env');
    assert.equal(mode(file), '600');
    const out = execFileSync('/bin/bash', ['-c', `. "${file}"; printf '%s|%s|%s' "$GITHUB_TOKEN" "$HERDR_SERVER" "$WORKSPACE_DIR"`],
        { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(out, "x y'z|true|/workspace");
});

test('the session env carries what herdr-core resolves its socket from, only when set', { skip: !hasKeygen && 'no ssh-keygen' }, (t) => {
    const { status, stderr, env } = dryRun(t, {
        HERDR_CORE_SERVER: 'true', HC_SOCKET: '/run/hc/core.sock', XDG_STATE_HOME: '/home/ubuntu/.local/state',
    });
    assert.equal(status, 0, stderr);
    const text = fs.readFileSync(path.join(env.SSH_STATE_DIR, 'berth-env'), 'utf8');
    assert.match(text, /^export HERDR_CORE_SERVER=true$/m);
    assert.match(text, /^export HC_SOCKET=\/run\/hc\/core\.sock$/m);
    assert.match(text, /^export XDG_STATE_HOME=/m);
    // Unset stays unset: an empty XDG_RUNTIME_DIR would move the socket.
    assert.doesNotMatch(text, /HC_SESSION|XDG_RUNTIME_DIR|XDG_CONFIG_HOME/);
});

test('sshd.sh refuses to start without keys', (t) => {
    const dir = tmp();
    const r = spawnSync('/bin/bash', [SSHD], {
        env: { PATH: process.env.PATH, HOME: dir, SSH_AUTHORIZED_KEYS: path.join(dir, 'absent'), SSH_DRY_RUN: '1' },
        encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.ok(!fs.existsSync(path.join(dir, '.ssh', 'sshd_config')));
});

test('a session runs the client command, or attaches herdr', () => {
    const dir = tmp();
    const state = path.join(dir, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'berth-env'), `export WORKSPACE_DIR=${dir}\nexport HERDR_SERVER=true\n`);
    const env = { PATH: process.env.PATH, HOME: dir, SSH_STATE_DIR: state };

    const cmd = spawnSync('/bin/bash', [SESSION], {
        env: { ...env, SSH_ORIGINAL_COMMAND: 'pwd; echo "$HERDR_SERVER"' }, encoding: 'utf8',
    });
    assert.equal(cmd.status, 0, cmd.stderr);
    assert.equal(cmd.stdout, `${fs.realpathSync(dir)}\ntrue\n`);

    // No command and no terminal: a hint, not a hung herdr.
    const none = spawnSync('/bin/bash', [SESSION], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /ssh -t/);

    const source = fs.readFileSync(SESSION, 'utf8');
    assert.match(source, /''\|dumb\|unknown\) export TERM=xterm-256color/);
    assert.match(source, /exec herdr$/m);
});

test('the image ships openssh-server without baked host keys', () => {
    const dockerfile = fs.readFileSync(path.join(WORKSPACE, 'Dockerfile'), 'utf8');
    const run = dockerfile.slice(dockerfile.indexOf('    openssh-server \\'));
    const layer = run.slice(0, run.search(/\n\n|\nRUN /));
    // Deleted in the same layer, or the keys survive in the image history.
    assert.match(layer, /rm -f \/etc\/ssh\/ssh_host_\*/);
});
