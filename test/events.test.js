const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createEvents } = require('../src/events');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('createEvents', () => {
  let events;
  let server;

  afterEach(() => {
    events.close();
    server.close();
  });

  // Starts a server for the hub and connects to it. `text()` is everything received so far.
  async function connect(options) {
    events = createEvents(options);
    server = http.createServer((req, res) => events.handle(req, res));
    await new Promise(resolve => server.listen(0, resolve));
    const res = await new Promise(resolve => http.get(`http://127.0.0.1:${server.address().port}`, resolve));
    let received = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { received += chunk; });
    const ended = new Promise(resolve => res.on('end', resolve));
    await delay(20);
    return { res, ended, text: () => received };
  }

  it('streams server-sent events', async () => {
    const { res } = await connect();
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('sends changes that come close together as one message', async () => {
    const client = await connect({ delayMs: 20 });
    events.notify();
    events.notify();
    await delay(60);
    events.notify();
    await delay(60);
    assert.equal(client.text().match(/data: change\n\n/g).length, 2);
  });

  it('sends a comment now and then to keep the connection open', async () => {
    const client = await connect({ heartbeatMs: 20 });
    await delay(50);
    assert.match(client.text(), /: ping\n\n/);
  });

  it('ends every stream when closed', async () => {
    const client = await connect();
    events.close();
    await client.ended;
  });
});
