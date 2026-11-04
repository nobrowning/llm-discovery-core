import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiscoveryClient, listIPv4Interfaces, requireLocalIPv4Interface } from '../index.mjs';

const networks = () => ({
  lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false, mac: 'aa:bb:cc:dd:ee:ff' }],
  'Ethernet 2': [{ family: 4, address: '10.0.0.4', internal: false, mac: '11:22:33:44:55:66' }],
  empty: undefined,
});

test('interface listing handles native names and both Node IPv4 family forms without changing selection order', () => {
  const source = networks();
  const before = structuredClone(source);
  assert.deepEqual(listIPv4Interfaces(() => source), [
    { name: 'en0', address: '192.168.1.20', mac: 'aa:bb:cc:dd:ee:ff' },
    { name: 'Ethernet 2', address: '10.0.0.4', mac: '11:22:33:44:55:66' },
  ]);
  assert.deepEqual(source, before);
});

test('explicit interface selection rejects device names, IPv6 and unattached addresses', () => {
  const available = listIPv4Interfaces(networks);
  assert.equal(requireLocalIPv4Interface('10.0.0.4', available), '10.0.0.4');
  for (const value of ['en0', 'Ethernet 2', '::1', null, '']) assert.throws(() => requireLocalIPv4Interface(value, available), /IPv4/);
  for (const value of ['192.168.1.99', '127.0.0.1', '0.0.0.0']) assert.throws(() => requireLocalIPv4Interface(value, available), /not currently attached/);
});

test('real transport validation fails before opening a socket for an unavailable interface', async () => {
  for (const interfaceAddress of ['en0', '192.168.1.99']) {
    const client = createDiscoveryClient({ interfaceAddress, networkInterfaces: networks });
    await assert.rejects(client.start(), /IPv4|not currently attached/);
    assert.equal(client.running, false);
  }
  await assert.rejects(createDiscoveryClient({ networkInterfaces: () => ({}) }).start(), /No active IPv4/);
});

test('discovery retains its first-address default and explicit selection with injected transport', async t => {
  const opened = [];
  const transportFactory = config => {
    opened.push(config);
    const socket = new EventEmitter();
    socket.query = (_packet, callback) => callback?.();
    socket.destroy = callback => callback?.();
    queueMicrotask(() => socket.emit('ready'));
    return socket;
  };
  const first = createDiscoveryClient({ networkInterfaces: networks, transportFactory });
  const selected = createDiscoveryClient({ networkInterfaces: networks, transportFactory, interfaceAddress: '10.0.0.4' });
  t.after(async () => { await first.stop(); await selected.stop(); });
  await first.start(); await selected.start();
  assert.equal(opened[0].interface, '192.168.1.20');
  assert.equal(opened[1].interface, '10.0.0.4');
  assert.ok(opened.every(config => config.bind === '0.0.0.0' && config.reuseAddr));
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await pause(5); }
  assert.fail('Timed out waiting for lifecycle transition');
}
function fakeTransport(opened, onOpen = socket => queueMicrotask(() => socket.emit('ready'))) {
  return config => {
    const socket = new EventEmitter();
    socket.config = config; socket.destroyed = 0;
    socket.query = (_packet, callback) => callback?.();
    socket.destroy = callback => { socket.destroyed++; callback?.(); };
    opened.push(socket); onOpen(socket); return socket;
  };
}

test('opt-in resilient discovery waits quietly at startup, recovers, and stops retrying after stop', async t => {
  let online = false; const opened = [], events = [];
  const client = createDiscoveryClient({ interfaceAddress: '192.168.1.20', waitForNetwork: true, networkInterfaces: () => online ? networks() : {}, networkCheckIntervalMs: 5, transportFactory: fakeTransport(opened) });
  t.after(() => client.stop()); client.subscribe(event => events.push(event));
  await client.start(); await pause(30);
  assert.equal(client.status, 'waiting'); assert.equal(client.running, false); assert.equal(opened.length, 0);
  assert.deepEqual(events, [{ type: 'status', status: 'waiting' }]);
  online = true; await until(() => client.status === 'discovering');
  assert.equal(opened.length, 1);
  online = false; await until(() => client.status === 'waiting');
  assert.equal(opened[0].destroyed, 1);
  online = true; await until(() => opened.length === 2 && client.running);
  await client.stop(); online = false; await pause(20); online = true; await pause(20);
  assert.equal(client.status, 'stopped'); assert.equal(opened.length, 2);
  assert.ok(events.every(event => event.type === 'status'));
});

test('network changes invalidate old candidates and never silently switch a pinned network', async t => {
  const { serviceRecords } = await import('../index.mjs');
  let source = networks(); const opened = [], events = [];
  const client = createDiscoveryClient({ interfaceAddress: '192.168.1.20', waitForNetwork: true, networkInterfaces: () => source, networkCheckIntervalMs: 5, transportFactory: fakeTransport(opened) });
  t.after(() => client.stop()); client.subscribe(event => events.push(event));
  await client.start();
  const packet = { answers: serviceRecords({ instanceName: 'Test', hostname: 'test.local', address: '192.168.1.30', port: 8443, basePath: '/v1' }) };
  opened[0].emit('response', packet);
  const old = client.snapshot()[0]; assert.ok(old);
  source = { other: [{ family: 'IPv4', address: '10.1.2.3', internal: false }] };
  await until(() => client.status === 'waiting');
  opened[0].emit('response', packet);
  assert.deepEqual(client.snapshot(), []); assert.equal(opened.length, 1);
  assert.ok(events.some(event => event.type === 'removed' && event.reason === 'network-attachment-changed'));
  source = networks(); await until(() => opened.length === 2 && client.running);
  opened[1].emit('response', packet);
  assert.notEqual(client.snapshot()[0].id, old.id);
});

test('transient bind and query failures enter waiting without repeated error events', async t => {
  const opened = [], events = []; let failing = true;
  const factory = fakeTransport(opened, socket => queueMicrotask(() => socket.emit(failing ? 'error' : 'ready', Object.assign(new Error('offline'), { code: 'EHOSTUNREACH' }))));
  const client = createDiscoveryClient({ interfaceAddress: '192.168.1.20', waitForNetwork: true, networkInterfaces: networks, networkCheckIntervalMs: 5, transportFactory: factory });
  t.after(() => client.stop()); client.subscribe(event => events.push(event));
  await client.start(); await pause(20);
  assert.equal(client.status, 'waiting'); assert.equal(events.length, 1);
  failing = false; await until(() => client.status === 'discovering');
  const socket = opened.at(-1);
  socket.query = (_packet, callback) => callback(Object.assign(new Error('offline'), { code: 'ENETDOWN' }));
  // Direct socket errors exercise the same failure path without query rate limiting.
  socket.emit('error', Object.assign(new Error('offline'), { code: 'ENETDOWN' }));
  assert.equal(client.status, 'waiting'); assert.equal(socket.destroyed, 1);
  assert.ok(events.every(event => event.type === 'status'));
});

test('stop during a pending bind cancels it once, and a subsequent start works', async t => {
  const opened = [];
  const client = createDiscoveryClient({ waitForNetwork: true, networkInterfaces: networks, transportFactory: fakeTransport(opened, () => {}) });
  t.after(() => client.stop());
  const first = client.start(); const stopped = client.stop(); const next = client.start();
  await first; await stopped; await until(() => opened.length === 2);
  opened[1].emit('ready'); await next;
  assert.equal(client.status, 'discovering'); assert.equal(opened[0].destroyed, 1);
  await client.stop(); assert.equal(opened[1].destroyed, 1);
});

test('resilient mode does not hide invalid configuration or permission failures', async () => {
  const invalid = createDiscoveryClient({ waitForNetwork: true, interfaceAddress: 'en0', networkInterfaces: networks });
  await assert.rejects(invalid.start(), { code: 'DISCOVERY_INTERFACE_INVALID' });
  const denied = createDiscoveryClient({ waitForNetwork: true, networkInterfaces: networks, transportFactory: fakeTransport([], socket => queueMicrotask(() => socket.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' })))) });
  await assert.rejects(denied.start(), { code: 'EACCES' });
  await denied.stop();
});

test('a transient warning during bind enters waiting immediately rather than timing out', async t => {
  const opened = [];
  const client = createDiscoveryClient({ waitForNetwork: true, networkInterfaces: networks, transportFactory: fakeTransport(opened, socket => queueMicrotask(() => socket.emit('warning', Object.assign(new Error('offline'), { code: 'ENETUNREACH' })))) });
  t.after(() => client.stop());
  await client.start();
  assert.equal(client.status, 'waiting'); assert.equal(opened[0].destroyed, 1);
});
