'use strict';

const DEFAULT_HEARTBEAT_MS = 15_000;

function normalizedHeartbeat(value) {
  const number = Number(value);
  const milliseconds = Number.isFinite(number) ? Math.trunc(number) : 0;
  return milliseconds > 0 ? milliseconds : DEFAULT_HEARTBEAT_MS;
}

function sseFrame(eventName, payload, id) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  if (eventName) lines.push(`event: ${eventName}`);
  const serialized = JSON.stringify(payload === undefined ? null : payload);
  for (const line of serialized.split(/\r?\n/)) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

function createReviewEventHub(options = {}) {
  const heartbeatMs = normalizedHeartbeat(options.heartbeatMs);
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const clients = new Set();
  let sequence = 0;
  let closed = false;

  function remove(client) {
    if (!client || client.closed) return;
    client.closed = true;
    clients.delete(client);
  }

  function subscribe(req, res) {
    if (closed) throw new Error('review event hub is closed');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (req.socket && typeof req.socket.setKeepAlive === 'function') req.socket.setKeepAlive(true, heartbeatMs);
    res.write('retry: 3000\n: connected\n\n');

    const client = { req, res, closed: false };
    clients.add(client);
    const cleanup = () => remove(client);
    req.once('aborted', cleanup);
    req.once('close', cleanup);
    res.once('close', cleanup);
    res.once('error', cleanup);
    return cleanup;
  }

  function broadcast(eventName, payload) {
    if (closed) return 0;
    const frame = sseFrame(eventName, payload, ++sequence);
    let delivered = 0;
    for (const client of [...clients]) {
      if (client.closed || client.res.destroyed || client.res.writableEnded) {
        remove(client);
        continue;
      }
      try {
        client.res.write(frame);
        delivered += 1;
      } catch {
        remove(client);
      }
    }
    return delivered;
  }

  function heartbeat() {
    if (closed) return 0;
    const frame = `: heartbeat ${now()}\n\n`;
    let delivered = 0;
    for (const client of [...clients]) {
      if (client.closed || client.res.destroyed || client.res.writableEnded) {
        remove(client);
        continue;
      }
      try {
        client.res.write(frame);
        delivered += 1;
      } catch {
        remove(client);
      }
    }
    return delivered;
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const client of [...clients]) {
      remove(client);
      try { client.res.end(); } catch {}
    }
  }

  const timer = setInterval(heartbeat, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();

  return Object.freeze({
    subscribe,
    broadcast,
    heartbeat,
    close,
    clientCount: () => clients.size,
  });
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  createReviewEventHub,
  sseFrame,
};
