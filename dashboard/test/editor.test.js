'use strict';

// The standalone editor: the workspace image in WORKSPACE_MODE=editor
// (k8s/editor.yaml), and the dashboard's read-only shortcut to it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { editorHealth } = require('../../workspace/agent');

const WORKSPACE = path.join(__dirname, '..', '..', 'workspace');

test('editor readiness is bootstrap done and code-server answering, nothing else', () => {
    const up = { up: true, reason: null };
    const down = { up: false, reason: 'not running' };

    assert.deepEqual(editorHealth('starting', up, null), { ready: true, stage: 'ready', detail: null });
    assert.deepEqual(editorHealth('starting', down, null),
        { ready: false, stage: 'starting-editor', detail: 'code-server: not running' });
    // Mid-bootstrap, code-server is not even started yet: the stage wins.
    assert.deepEqual(editorHealth('syncing-config', up, null),
        { ready: false, stage: 'syncing-config', detail: null });
    assert.deepEqual(editorHealth('failed', up, 'could not seed claude config\n'),
        { ready: false, stage: 'failed', detail: 'could not seed claude config' });
});

test('the editor bootstrap skips the clone and the bootstrap claude remote', () => {
    const source = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');
    const clone = source.indexOf('bootstrap/clone.sh');
    const launch = source.indexOf('claude remote --name');
    assert.ok(clone > 0 && launch > 0);
    // Both sit inside a branch that the editor mode does not take.
    const guardBefore = (at) => source.lastIndexOf('if [ "$WORKSPACE_MODE"', at);
    assert.match(source.slice(guardBefore(clone), clone), /= "editor" \]; then[\s\S]*else/);
    assert.match(source.slice(guardBefore(launch), launch), /!= "editor" \]; then/);
    assert.match(source, /export CODE_ENABLE=1/);
});

test('supervisord leaves ttyd and codexapp stopped when WORKSPACE_TERMINALS is false', () => {
    const source = fs.readFileSync(path.join(WORKSPACE, 'supervisord.conf'), 'utf8');
    for (const program of ['ttyd', 'codex-ui']) {
        const section = source.match(new RegExp(`^\\[program:${program}\\]\\n([\\s\\S]*?)(?=^\\[)`, 'm'));
        assert.ok(section, `[program:${program}] is missing`);
        assert.match(section[1], /^autostart=%\(ENV_WORKSPACE_TERMINALS\)s$/m);
    }
    // supervisord refuses to start on an unset %(ENV_*)s: the entrypoint
    // must set it in both modes.
    const entry = fs.readFileSync(path.join(WORKSPACE, 'entrypoint.sh'), 'utf8');
    assert.match(entry, /export WORKSPACE_TERMINALS=false/);
    assert.match(entry, /export WORKSPACE_TERMINALS=true/);
});
