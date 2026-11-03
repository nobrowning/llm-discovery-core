import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryClient, serviceRecords, parseTxt, validateBasePath } from '../index.mjs';

const service = { id: 'a-text', instanceName: 'Test Text', hostname: 'test-node.local', address: '192.168.50.10', port: 18443, basePath: '/text/v1' };

test('strict base path rejects authority, traversal, encoded traversal and malformed encoding', () => {
  for (const path of ['/', '/v1', '/company/api/v1']) assert.equal(validateBasePath(path), true);
  for (const path of ['', '//evil', '/v1/', '/a/../b', '/a/%2e%2e/b', '/v1?key=a', '/v1#x', '/a%2fb', '/bad%xy', '/a\\b']) assert.equal(validateBasePath(path), false, path);
});

test('TXT keys are case-insensitive and first occurrence wins', () => {
  const { fields } = parseTxt([Buffer.from('TXTvers=1'), Buffer.from('txtvers=999'), Buffer.from('flag')]);
  assert.equal(fields.txtvers, '1');
  assert.equal(fields.flag, null);
});

test('a service requires network PTR, SRV, TXT and address; API URL comes from records', () => {
  const client = createDiscoveryClient({ interfaceAddress: '192.168.50.2' });
  const records = serviceRecords(service);
  client.ingest({ answers: records.slice(1) });
  assert.deepEqual(client.snapshot(), []);
  client.ingest({ answers: records.slice(0, 1) });
  const found = client.snapshot()[0];
  assert.equal(found.baseURL, 'https://test-node.local:18443/text/v1');
  assert.equal(found.validation.valid, true);
  assert.deepEqual(found.addresses, ['192.168.50.10']);
});

test('two paths on a single host remain independent; goodbye removes only one after grace', () => {
  let time = 1000;
  const client = createDiscoveryClient({ now: () => time });
  const vision = { ...service, id: 'a-vision', instanceName: 'Test Vision', basePath: '/vision/v1' };
  client.ingest({ answers: [...serviceRecords(service), ...serviceRecords(vision)] });
  assert.equal(client.snapshot().length, 2);
  client.ingest({ answers: serviceRecords(service, 0).filter((r) => !['A', 'AAAA'].includes(r.type)) });
  assert.equal(client.snapshot().length, 2);
  time += 1100; client.sweep();
  assert.equal(client.snapshot().length, 1);
  assert.match(client.snapshot()[0].baseURL, /vision/);
});

test('TTL expires without goodbye and refresh does not change route generation', () => {
  let time = 0;
  const client = createDiscoveryClient({ now: () => time });
  client.ingest({ answers: serviceRecords(service, 2) });
  const generation = client.snapshot()[0].recordGeneration;
  time = 1000;
  client.ingest({ answers: serviceRecords(service, 2) });
  assert.equal(client.snapshot()[0].recordGeneration, generation);
  time = 3001; client.sweep();
  assert.equal(client.snapshot().length, 0);
});

test('unknown profile and malformed TXT cannot produce connectable configuration', () => {
  const client = createDiscoveryClient();
  const records = serviceRecords(service);
  records.find((r) => r.type === 'TXT').data = [Buffer.from('txtvers=1'), Buffer.from('api=unrecognized'), Buffer.from('base=/v1'), Buffer.from('scheme=https')];
  client.ingest({ answers: records });
  assert.equal(client.snapshot()[0].validation.valid, false);
  assert.equal(client.snapshot()[0].baseURL, null);
});

test('SRV cache flush uses updated port and increments record generation', () => {
  const client = createDiscoveryClient();
  client.ingest({ answers: serviceRecords(service) });
  const before = client.snapshot()[0];
  client.ingest({ answers: serviceRecords({ ...service, port: 18444 }) });
  const after = client.snapshot()[0];
  assert.equal(after.port, 18444);
  assert.ok(after.recordGeneration > before.recordGeneration);
});

test('independent paths on one host can advertise required and no-key authentication', () => {
  const client = createDiscoveryClient();
  const publicService = { ...service, id: 'public-text', instanceName: 'Public Text', basePath: '/public/v1', auth: 'none' };
  const privateRecords = serviceRecords({ ...service, token: 'must-not-be-published' });
  const publicRecords = serviceRecords(publicService);
  assert.equal(parseTxt(privateRecords.find(record => record.type === 'TXT').data).fields.auth, 'required');
  assert.equal(parseTxt(publicRecords.find(record => record.type === 'TXT').data).fields.auth, 'none');
  assert.ok(!privateRecords.filter(record => record.type === 'TXT').flatMap(record => record.data).map(part => part.toString()).join('\n').includes('must-not-be-published'));
  client.ingest({ answers: [...privateRecords, ...publicRecords] });
  const candidates = client.snapshot();
  assert.equal(candidates.length, 2);
  const required = candidates.find(candidate => candidate.basePath === '/text/v1');
  const noKey = candidates.find(candidate => candidate.basePath === '/public/v1');
  assert.equal(required.auth, 'required');
  assert.equal(required.draftAuthCompatible, true);
  assert.deepEqual(required.validation.warnings, []);
  assert.equal(noKey.auth, 'none');
  assert.equal(noKey.validation.valid, true);
  assert.equal(noKey.baseURL, 'https://test-node.local:18443/public/v1');
  assert.equal(noKey.draftAuthCompatible, false);
  assert.match(noKey.validation.warnings[0], /local experiment/);
});

test('unknown authentication values cannot be published or become connectable candidates', () => {
  for (const auth of ['optional', 'bearer', 'NONE', '', null, 0, false]) {
    assert.throws(() => serviceRecords({ ...service, auth }), /authentication hint/);
    const records = serviceRecords(service);
    const txt = records.find(record => record.type === 'TXT');
    txt.data = [...txt.data.filter(part => !part.toString().startsWith('auth=')), Buffer.from(`auth=${auth}`)];
    const client = createDiscoveryClient();
    client.ingest({ answers: records });
    assert.equal(client.snapshot()[0].validation.valid, false);
    assert.equal(client.snapshot()[0].baseURL, null);
  }
  const records = serviceRecords(service);
  const txt = records.find(record => record.type === 'TXT');
  txt.data = txt.data.filter(part => !part.toString().startsWith('auth='));
  const client = createDiscoveryClient();
  client.ingest({ answers: records });
  assert.equal(client.snapshot()[0].auth, 'unknown');
  assert.equal(client.snapshot()[0].validation.valid, false);
});

test('changing the authentication hint updates the candidate generation', () => {
  const client = createDiscoveryClient();
  client.ingest({ answers: serviceRecords(service) });
  const before = client.snapshot()[0];
  client.ingest({ answers: serviceRecords({ ...service, auth: 'none' }) });
  const after = client.snapshot()[0];
  assert.equal(after.id, before.id);
  assert.equal(after.auth, 'none');
  assert.ok(after.recordGeneration > before.recordGeneration);
});
