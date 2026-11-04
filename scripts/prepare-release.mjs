import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, process.argv[2] ?? '.release-artifacts');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run with npm run release:prepare.');
const npm = (args, cwd = root) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
});
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await mkdir(out, { recursive: true });
const pack = () => JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', out]))[0];
const packed = pack();
assert.equal(packed.name, manifest.name);
assert.equal(packed.version, manifest.version);
assert.deepEqual(packed.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'index.mjs', 'network.mjs', 'package.json', 'protocol.mjs'].sort());
assert.deepEqual(packed.bundled, []);
const archive = join(out, packed.filename);
const checksum = await sha256(archive);
assert.equal(pack().filename, packed.filename);
assert.equal(await sha256(archive), checksum, 'Repeated npm pack must produce identical bytes.');

const scratch = await mkdtemp(join(tmpdir(), 'llm-core-release-'));
try {
  await writeFile(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], scratch);
  await writeFile(join(scratch, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createDiscoveryClient, serviceRecords, listIPv4Interfaces, requireLocalIPv4Interface } from '@llm-discovery/discovery-core';
import { SERVICE_TYPE } from '@llm-discovery/discovery-core/protocol';
assert.equal(SERVICE_TYPE, '_llm-api._tcp.local');
const interfaces = listIPv4Interfaces(() => ({ en0: [{ family: 'IPv4', address: '192.168.50.2', internal: false }] }));
assert.equal(requireLocalIPv4Interface('192.168.50.2', interfaces), '192.168.50.2');
const client = createDiscoveryClient({ interfaceAddress: '192.168.50.2' });
client.ingest({ answers: serviceRecords({ id: 'release-check', instanceName: 'Release Check', hostname: 'release-check.local', address: '192.168.50.10', port: 8443, basePath: '/v1' }) });
assert.equal(client.snapshot()[0].baseURL, 'https://release-check.local:8443/v1');
assert.equal(client.snapshot()[0].validation.valid, true);
console.log('Installed archive exports and discovery records passed.');
`);
  process.stdout.write(execFileSync(process.execPath, ['smoke.mjs'], { cwd: scratch, encoding: 'utf8', timeout: 15_000 }));
} finally {
  const tempRoot = await realpath(tmpdir());
  const target = await realpath(scratch);
  const rel = relative(tempRoot, target);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && dirname(target) === tempRoot,
    'Temporary cleanup must stay directly under the resolved temporary directory.');
  await rm(target, { recursive: true, force: true });
}
await writeFile(join(out, 'SHA256SUMS'), `${checksum}  ${packed.filename}\n`);
process.stdout.write(`${packed.filename}\nSHA256 ${checksum}\n`);
