const match = /^\/terminal\/(berth-ws-[a-z0-9-]+-[0-9a-f]{8})\/?$/.exec(window.location.pathname);
const frame = document.getElementById('terminal-frame');

if (match) {
  frame.src = `/tty/${encodeURIComponent(match[1])}/`;
} else {
  frame.replaceWith(Object.assign(document.createElement('p'), { textContent: 'Invalid terminal URL.' }));
}
