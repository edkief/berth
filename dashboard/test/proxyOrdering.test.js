'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('workspace proxies are registered before the JSON body parser', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const parser = source.indexOf("app.use(express.json({ limit: '16kb' }))");

    assert.ok(parser > source.indexOf("app.use('/tty/:id'"));
    assert.ok(parser > source.indexOf("app.use('/codex/:id'"));
    assert.ok(parser > source.indexOf("app.use('/config-tty'"));
    assert.ok(parser < source.indexOf("app.get('/api/config/status'"));
});

test('terminal shell route is registered before the dashboard SPA fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(source.indexOf("app.get('/terminal/:id'") < source.indexOf("app.get('*'"));
});

test('the config shell is served through the terminal chrome, not raw ttyd', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /req\.params\.id !== 'config'/);

    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(!dashboard.includes('href="/config-tty/"'), 'link the wrapper, not the raw ttyd base path');
    assert.ok(dashboard.includes('href="/terminal/config/"'));

    const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'terminal-shortcuts.mjs'), 'utf8');
    assert.ok(shell.includes("'/config-tty/'"), 'the wrapper must know where to point its iframe');
});

test('unversioned assets are served with a revalidating cache header', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // A CDN fronts the origin: with no header it may hand out a stylesheet from
    // before the deploy alongside freshly deployed markup.
    assert.match(source, /express\.static\([\s\S]{0,200}setHeaders[\s\S]{0,120}'Cache-Control', 'no-cache'/);
    for (const page of ['terminal.html', 'index.html', 'landing.html']) {
        const sent = new RegExp(`Cache-Control', 'no-cache'\\)\\.sendFile\\(path\\.join\\(__dirname, 'public', '${page}'`);
        assert.match(source, sent, `${page} must revalidate`);
    }
});
