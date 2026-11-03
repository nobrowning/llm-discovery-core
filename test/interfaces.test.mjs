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
