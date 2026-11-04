import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiscoveryClient, chooseIPv4Attachment, readNetworkRouteHints, serviceRecords } from '../index.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let n = 0; n < 200; n++) { if (condition()) return; await pause(5); }
  assert.fail('Timed out waiting for network transition');
}
const nic = (address, mac = '10:20:30:40:50:60') => [{ family: 'IPv4', address, mac, internal: false }];
const packet = label => ({ answers: serviceRecords({ instanceName: label, hostname: `${label.toLowerCase()}.local`, address: '192.168.1.30', port: 8443, basePath: '/v1' }) });
function sockets(opened, ready = true) {
  return config => {
    const socket = new EventEmitter(); socket.config = config; socket.destroyed = 0;
    socket.query = (_packet, callback) => callback?.();
    socket.destroy = callback => { socket.destroyed++; callback?.(); };
    opened.push(socket); if (ready) queueMicrotask(() => socket.emit('ready'));
    return socket;
  };
}

test('auto discovery moves company -> offline -> home without a configured-address rewrite', async t => {
  let source = { en0: nic('10.20.0.2') }; const opened = [], events = [];
  const options = { interfaceMode: 'auto', interfaceAddress: '10.20.0.2', preferredInterfaceName: 'en0', waitForNetwork: true, networkInterfaces: () => source, networkCheckIntervalMs: 5, transportFactory: sockets(opened), networkId: 'trusted-demo-scope' };
  const client = createDiscoveryClient(options); t.after(() => client.stop()); client.subscribe(event => events.push(event));
  await client.start(); opened[0].emit('response', packet('Company'));
  assert.equal(client.snapshot().length, 1); assert.equal(client.snapshot()[0].networkId, 'trusted-demo-scope');
  const firstId = client.snapshot()[0].id;
  source = {}; await until(() => client.status === 'waiting' && !client.attachment);
  opened[0].emit('response', packet('Company')); assert.deepEqual(client.snapshot(), []);
  source = { en0: nic('192.168.1.20') }; await until(() => opened.length === 2 && client.status === 'discovering');
  opened[1].emit('response', packet('Home'));
  assert.equal(opened[1].config.interface, '192.168.1.20'); assert.equal(client.snapshot().length, 1);
  assert.match(client.snapshot()[0].instanceName, /Home/); assert.notEqual(client.snapshot()[0].id, firstId);
  assert.equal(client.snapshot()[0].networkId, 'trusted-demo-scope');
  assert.equal(options.interfaceAddress, '10.20.0.2');
  assert.deepEqual(client.attachment, { mode: 'auto', interfaceName: 'en0', interfaceAddress: '192.168.1.20', attachmentEpoch: client.snapshot()[0].attachmentEpoch });
  assert.ok(events.some(event => event.type === 'network' && event.attachment === null));
  assert.ok(events.every(event => !['warning', 'error'].includes(event.type)));
});

test('direct network replacement expires old attachments and ignores old-socket packets', async t => {
  let source = { en0: nic('10.20.0.2') }; const opened = [];
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkInterfaces: () => source, networkCheckIntervalMs: 5, transportFactory: sockets(opened) });
  t.after(() => client.stop()); await client.start(); opened[0].emit('response', packet('Company'));
  source = { 'Ethernet 2': nic('192.168.2.2') };
  await until(() => opened.length === 2 && client.status === 'discovering');
  assert.equal(opened[0].destroyed, 1); assert.deepEqual(client.snapshot(), []);
  opened[0].emit('response', packet('Company')); assert.deepEqual(client.snapshot(), []);
  opened[1].emit('response', packet('Home')); assert.equal(client.snapshot().length, 1);
});

test('same-address attachment identities rebind without changing configured trust network scope', async t => {
  let attachmentId = 'company-router'; const opened = [];
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkId: 'trust-scope', networkInterfaces: () => ({ en0: nic('192.168.1.20') }), networkCheckIntervalMs: 5, transportFactory: sockets(opened), resolveNetworkAttachment: ({ interfaces }) => ({ interfaceAddress: interfaces[0].address, networkId: attachmentId }) });
  t.after(() => client.stop()); await client.start(); opened[0].emit('response', packet('PrinterLikeAPI'));
  const old = client.snapshot()[0]; attachmentId = 'home-router';
  await until(() => opened.length === 2 && client.status === 'discovering');
  assert.deepEqual(client.snapshot(), []); opened[1].emit('response', packet('PrinterLikeAPI'));
  assert.notEqual(client.snapshot()[0].id, old.id); assert.equal(client.snapshot()[0].networkId, 'trust-scope');
});

test('unrelated interfaces do not churn a selected LAN and virtual-only networks wait', async t => {
  let source = { en0: nic('10.20.0.2') }; const opened = [];
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkInterfaces: () => source, networkCheckIntervalMs: 5, transportFactory: sockets(opened) });
  t.after(() => client.stop()); await client.start(); opened[0].emit('response', packet('Company'));
  source = { utun8: nic('10.3.0.1'), docker0: nic('172.17.0.1'), en0: nic('10.20.0.2') };
  await pause(40); assert.equal(opened.length, 1); assert.equal(client.snapshot().length, 1);
  source = { utun8: nic('10.3.0.1'), docker0: nic('172.17.0.1') };
  await until(() => client.status === 'waiting'); assert.equal(opened.length, 1); assert.deepEqual(client.snapshot(), []);
});

test('route and preferred-adapter policy selects LAN over VPN and preserves incomplete neighbor cache identity', () => {
  const rows = [{ name: 'utun3', address: '10.8.0.2' }, { name: 'en0', address: '10.20.0.2' }, { name: 'en7', address: '192.168.1.20' }];
  const routes = [{ name: 'utun3', gateway: '10.8.0.1', metric: 0 }, { name: 'en7', gateway: '192.168.1.1', metric: 10, mac: 'ab:cd:ef:01:23:45' }];
  const first = chooseIPv4Attachment(rows, { routes }); assert.equal(first.interfaceName, 'en7');
  assert.equal(chooseIPv4Attachment(rows, { routes, preferredInterfaceName: 'en0' }).interfaceName, 'en0');
  assert.equal(chooseIPv4Attachment(rows, { routes: routes.map(row => ({ ...row, mac: undefined })), previous: first }).networkId, first.networkId);
  assert.equal(chooseIPv4Attachment(rows, { routes: [], previous: first }).networkId, first.networkId);
  assert.notEqual(chooseIPv4Attachment(rows, { routes: routes.map(row => ({ ...row, mac: 'ff:ee:dd:cc:bb:aa' })), previous: first }).networkId, first.networkId);
  assert.equal(chooseIPv4Attachment([{ name: 'Wi-Fi', address: '169.254.20.1' }]).interfaceAddress, '169.254.20.1');
});

test('invalid resolver selections fail and probe cancellation makes shutdown bounded', async t => {
  for (const resolveNetworkAttachment of [() => ({ interfaceAddress: '127.0.0.1' }), () => ({ interfaceAddress: '10.20.0.2', interfaceName: 'other' }), () => ({ interfaceAddress: '10.20.0.2', networkId: {} })]) {
    const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkInterfaces: () => ({ en0: nic('10.20.0.2') }), resolveNetworkAttachment });
    await assert.rejects(client.start(), { code: 'DISCOVERY_INTERFACE_INVALID' }); await client.stop();
  }
  const opened = []; let resolveProbe; let signal;
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkInterfaces: () => ({ en0: nic('10.20.0.2') }), transportFactory: sockets(opened), resolveNetworkAttachment: context => { signal = context.signal; return new Promise(resolve => { resolveProbe = resolve; }); } });
  t.after(() => client.stop()); const start = client.start(); await until(() => resolveProbe);
  await Promise.race([client.stop(), pause(100).then(() => { throw new Error('stop waited for hung network probe'); })]);
  await start; assert.equal(signal.aborted, true); resolveProbe({ interfaceAddress: '10.20.0.2' });
  await pause(20); assert.equal(opened.length, 0); assert.equal(client.status, 'stopped');
});

test('learning the first gateway MAC enriches identity without expiring live candidates', async t => {
  const opened = []; let mac;
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkCheckIntervalMs: 5, networkInterfaces: () => ({ en0: nic('192.168.1.20') }), transportFactory: sockets(opened), resolveNetworkAttachment: ({ interfaces, previous }) => chooseIPv4Attachment(interfaces, { previous, routes: [{ name: 'en0', gateway: '192.168.1.1', mac }] }) });
  t.after(() => client.stop()); await client.start(); opened[0].emit('response', packet('Company'));
  const id = client.snapshot()[0].id; mac = 'ab:cd:ef:01:23:45'; await pause(30);
  assert.equal(opened.length, 1); assert.equal(client.snapshot()[0].id, id);
  mac = 'ab:cd:ef:01:23:46'; await until(() => opened.length === 2 && client.status === 'discovering');
  assert.deepEqual(client.snapshot(), []);
});

test('auto probe timeout waits quietly and subsequent successful probe recovers', async t => {
  let hung = true; const events = [], opened = [];
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkProbeTimeoutMs: 10, networkCheckIntervalMs: 5, networkInterfaces: () => ({ en0: nic('10.20.0.2') }), transportFactory: sockets(opened), resolveNetworkAttachment: () => hung ? new Promise(() => {}) : { interfaceAddress: '10.20.0.2' } });
  t.after(() => client.stop()); client.subscribe(event => events.push(event)); await client.start();
  assert.equal(client.status, 'waiting'); hung = false;
  await until(() => client.status === 'discovering'); assert.equal(opened.length, 1); assert.ok(events.every(event => event.type !== 'warning'));
});

test('stop during auto rebind cancels pending sockets and does not resurrect discovery', async t => {
  let source = { en0: nic('10.20.0.2') }; const opened = [];
  const client = createDiscoveryClient({ interfaceMode: 'auto', waitForNetwork: true, networkCheckIntervalMs: 5, networkInterfaces: () => source, transportFactory: sockets(opened, false) });
  t.after(() => client.stop()); const first = client.start(); await until(() => opened.length === 1); opened[0].emit('ready'); await first;
  source = { en0: nic('192.168.1.20') }; await until(() => opened.length === 2);
  await client.stop(); opened[1].emit('ready'); await pause(20);
  assert.deepEqual(opened.map(socket => socket.destroyed), [1, 1]); assert.equal(client.status, 'stopped'); assert.equal(client.attachment, null);
});

test('OS route hints parse macOS, Linux and Windows caches without constructing a shell command from input', async () => {
  const calls = [];
  const mac = await readNetworkRouteHints({ platform: 'darwin', execFileImpl: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: file.endsWith('/route') ? 'gateway: 192.168.1.1\ninterface: en0\n' : '? (192.168.1.1) at a:b:c:d:e:f on en0 ifscope [ethernet]\n' }; } });
  assert.deepEqual(mac, [{ name: 'en0', gateway: '192.168.1.1', metric: 0, mac: '0a:0b:0c:0d:0e:0f' }]);
  assert.deepEqual(calls[1].args, ['-n', '192.168.1.1']); assert.equal(calls[0].options.timeout, 2500);
  const linux = await readNetworkRouteHints({ platform: 'linux', readFileImpl: async path => path.endsWith('/route') ? 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 0101A8C0 0003 0 0 100 00000000\ntun0 00000000 0100080A 0003 0 0 1 00000000\n' : 'IP address HW type Flags HW address Mask Device\n192.168.1.1 0x1 0x2 ab:cd:ef:01:23:45 * eth0\n' });
  assert.equal(linux[0].gateway, '192.168.1.1'); assert.equal(linux[0].mac, 'ab:cd:ef:01:23:45'); assert.equal(linux[1].name, 'tun0');
  const windows = await readNetworkRouteHints({ platform: 'win32', execFileImpl: async () => ({ stdout: JSON.stringify({ name: 'Wi-Fi', gateway: '192.168.1.1', metric: 10, mac: 'AB-CD-EF-01-23-45' }) }) });
  assert.equal(windows[0].mac, 'ab:cd:ef:01:23:45');
  assert.deepEqual(await readNetworkRouteHints({ platform: 'linux', readFileImpl: async () => { throw new Error('not available'); } }), []);
});
