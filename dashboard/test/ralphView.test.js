'use strict';

const test = require('node:test');
const assert = require('node:assert');

let ralphView;
test.before(async () => { ({ ralphView } = await import('../public/js/ralph-state.mjs')); });

const daemon = (state, detail = null) => ({ state, detail });

test('a Ralph UI that answers is running, whatever supervisord says', () => {
    for (const d of [daemon('RUNNING'), daemon('FATAL', 'Exited too quickly'), null]) {
        const v = ralphView({ ui: true, configured: true, daemon: d });
        assert.equal(v.state, 'running');
        assert.equal(v.action, 'open');
    }
    // A ralph started by hand: not supervised, maybe not even configured.
    assert.equal(ralphView({ ui: true, configured: false, daemon: daemon('STOPPED') }).action, 'open');
});

test('the tooltip of a running Ralph says where its run stands', () => {
    const v = ralphView({
        ui: true, configured: true, tasks: { passed: 1, total: 3 },
        run: { live: true, taskId: 'T-2', iteration: 2, maxIterations: 20 },
    });
    assert.equal(v.title, 'Ralph running · T-2 · iteration 2/20 · 1/3 tasks');
});

test('a daemon coming up is starting, and opening it shows the waiting page', () => {
    for (const state of ['STARTING', 'BACKOFF', 'RUNNING']) {
        const v = ralphView({ ui: false, configured: true, daemon: daemon(state) });
        assert.equal(v.state, 'starting', state);
        assert.equal(v.action, 'open');
    }
});

test('a set-up Ralph that is down is stopped, says why, and starts on click', () => {
    const fatal = ralphView({ ui: false, configured: true, daemon: daemon('FATAL', 'Exited too quickly') });
    assert.equal(fatal.state, 'stopped');
    assert.equal(fatal.action, 'start');
    assert.match(fatal.title, /gave up starting \(Exited too quickly\)/);
    assert.equal(ralphView({ ui: false, configured: true, daemon: daemon('STOPPED') }).state, 'stopped');
    assert.equal(ralphView({ ui: false, configured: true, daemon: null }).state, 'stopped');
});

test('no config and nothing running is unset: the button sets Ralph up', () => {
    const v = ralphView({ ui: false, configured: false, daemon: daemon('STOPPED', 'Not started') });
    assert.equal(v.state, 'unset');
    assert.equal(v.action, 'start');
    assert.equal(v.label, 'Set up Ralph');
    assert.match(v.title, /Plan tab/);
});

test('an agent that cannot say anything about setup leaves the button off', () => {
    for (const ralph of [null, undefined, { ui: false, reason: 'workspace agent unreachable' },
        { ui: false, reason: 'not running', configured: null, daemon: null }]) {
        const v = ralphView(ralph);
        assert.equal(v.state, 'unknown');
        assert.equal(v.action, null);
    }
    assert.match(ralphView({ ui: false, reason: 'not running', configured: null }).title, /Ralph not running/);
});
