import multicastDns from 'multicast-dns';
import os from 'node:os';
import { isIP } from 'node:net';
import { SERVICE_TYPE, canonicalName, candidateFromRecords, normalizeRecord, recordIdentity } from './protocol.mjs';
export * from './protocol.mjs';

/** List assigned, non-loopback IPv4 addresses without opening a socket. */
export function listIPv4Interfaces(readInterfaces = os.networkInterfaces) {
  return Object.entries(readInterfaces()).flatMap(([name, rows]) => (rows ?? [])
    .filter(row => !row.internal && (row.family === 'IPv4' || row.family === 4) && isIP(row.address) === 4 && row.address !== '0.0.0.0')
    .map(row => ({ name, address: row.address, mac: row.mac })));
}

/** Validate an address, not an OS-specific interface name such as en0 or eth0. */
export function requireLocalIPv4Interface(address, available = listIPv4Interfaces()) {
  if (typeof address !== 'string' || isIP(address) !== 4) throw new Error('Select a local IPv4 interface address, not a device name.');
  if (!available.some(row => row.address === address)) throw new Error('The selected discovery interface is not currently attached.');
  return address;
}

const recordKey = recordIdentity;
const semanticCandidate = (candidate) => JSON.stringify({ ...candidate, expiresAt: 0, recordGeneration: 0 });

export function createDiscoveryClient(options = {}) {
  const listeners = new Set();
  const cache = new Map();
  let candidates = new Map();
  let transport = null;
  let timers = [];
  let attachmentEpoch = 1;
  let generation = 0;
  let lastNetworkFingerprint;
  let currentInterface = options.interfaceAddress;
  let active = false;
  let lifecycle = 0;
  let starting;
  let rebinding = false;
  let cancelBind;
  const lastQuestion = new Map();
  const interfaceId = () => currentInterface ?? 'all';
  const networkId = options.networkId ?? 'local';
  const now = options.now ?? Date.now;
  const factory = options.transportFactory ?? ((config) => multicastDns(config));
  const notify = (event) => { for (const fn of listeners) { try { fn(event); } catch {} } };
  const interfaces = () => listIPv4Interfaces(options.networkInterfaces);
  const networkFingerprint = () => JSON.stringify(interfaces().map(({ name, address, mac }) => [name, address, mac]).sort());

  function records(name, type) {
    return [...cache.values()].filter((r) => canonicalName(r.name) === canonicalName(name) && r.type === type && r.expiresAt > now());
  }
  function ask(questions) {
    if (!transport || !questions.length) return;
    const unique = [...new Map(questions.map((q) => [`${canonicalName(q.name)}|${q.type}`, q])).values()];
    const relevant = unique.filter((q) => now() - (lastQuestion.get(`${canonicalName(q.name)}|${q.type}`) ?? -Infinity) >= 1000);
    if (!relevant.length) return;
    for (const q of relevant) lastQuestion.set(`${canonicalName(q.name)}|${q.type}`, now());
    const answers = [...cache.values()].filter((record) => record.expiresAt > now() && relevant.some((q) => canonicalName(q.name) === canonicalName(record.name) && q.type === record.type))
      .slice(0, 64).map((record) => ({ name: record.name, type: record.type, class: 'IN', data: record.data, flush: false, ttl: Math.max(0, Math.floor((record.expiresAt - now()) / 1000)) }));
    try { transport.query({ questions: relevant.slice(0, 64), answers }, (error) => { if (error) notify({ type: 'warning', error: error.message }); }); }
    catch (error) { notify({ type: 'warning', error: error.message }); }
  }
  function rebuild() {
    const next = new Map();
    const missing = [];
    for (const ptr of records(SERVICE_TYPE, 'PTR')) {
      const instanceName = ptr.data;
      const srvs = records(instanceName, 'SRV');
      const txts = records(instanceName, 'TXT');
      if (!srvs.length) missing.push({ name: instanceName, type: 'SRV' });
      if (!txts.length) missing.push({ name: instanceName, type: 'TXT' });
      if (!srvs.length || !txts.length) continue;
      // Unique records are replaced by cache-flush processing; use newest if not.
      const srv = srvs.at(-1), txt = txts.at(-1);
      const hostRecords = [...records(srv.data.target, 'A'), ...records(srv.data.target, 'AAAA')];
      if (!hostRecords.length) {
        missing.push({ name: srv.data.target, type: 'A' }, { name: srv.data.target, type: 'AAAA' });
        continue;
      }
      const candidate = candidateFromRecords({
        instanceName, srv: srv.data, txt: txt.data,
        addresses: hostRecords.map((r) => r.data), interfaceId: interfaceId(), networkId,
        attachmentEpoch, expiresAt: Math.min(ptr.expiresAt, srv.expiresAt, txt.expiresAt, ...hostRecords.map((r) => r.expiresAt)),
      });
      const old = candidates.get(candidate.id);
      const changed = !old || semanticCandidate(old) !== semanticCandidate(candidate);
      candidate.recordGeneration = changed ? ++generation : old.recordGeneration;
      next.set(candidate.id, candidate);
      if (changed) notify({ type: candidate.validation.valid ? old ? 'updated' : 'added' : 'invalid', candidate });
    }
    for (const [id, candidate] of candidates) if (!next.has(id)) notify({ type: 'removed', candidate, reason: 'records-withdrawn-or-expired' });
    candidates = next;
    return missing;
  }
  function ingest(packet, rinfo = {}) {
    if (!packet || (packet.type && packet.type !== 'response') || (rinfo.port !== undefined && rinfo.port !== (options.port ?? 5353))) return;
    const incoming = [...(Array.isArray(packet.answers) ? packet.answers : []), ...(Array.isArray(packet.additionals) ? packet.additionals : [])].map(normalizeRecord).filter(Boolean);
    const batchKeys = new Set(incoming.filter((r) => r.ttl > 0).map(recordKey));
    for (const record of incoming) {
      if (!Number.isFinite(record.ttl) || record.ttl < 0) continue;
      // Bound untrusted cache growth and TTL; absent PTR never generates a candidate.
      if (cache.size >= 2048 && !cache.has(recordKey(record))) continue;
      const key = recordKey(record);
      if (record.ttl === 0) {
        const old = cache.get(key);
        if (old) old.expiresAt = Math.min(old.expiresAt, now() + 1000);
        continue;
      }
      if (record.flush) {
        for (const [oldKey, old] of cache) {
          // RFC 6762 §10.2: protect records received in the last second, including split RRsets.
          if (record.type !== 'PTR' && canonicalName(old.name) === canonicalName(record.name) && old.type === record.type && old.receivedAt < now() - 1000 && !batchKeys.has(oldKey)) old.expiresAt = Math.min(old.expiresAt, now() + 1000);
        }
      }
      cache.delete(key);
      cache.set(key, { ...record, sourceAddress: rinfo.address, receivedAt: now(), expiresAt: now() + Math.min(record.ttl, 4500) * 1000 });
    }
    // PTR and SRV often arrive separately. Resolve immediately instead of waiting one browse interval.
    ask(rebuild());
  }
  function sweep() {
    for (const [key, record] of cache) if (record.expiresAt <= now()) cache.delete(key);
    rebuild();
  }
  function clearAttachment(reason) {
    for (const candidate of candidates.values()) notify({ type: 'removed', candidate, reason });
    cache.clear(); candidates.clear(); lastQuestion.clear(); attachmentEpoch++;
  }
  function query() {
    const missing = rebuild();
    // Refresh unique records as well as PTRs even if the responder omits additional records.
    for (const record of cache.values()) if (record.expiresAt - now() < Math.max(1000, (record.expiresAt - record.receivedAt) * 0.25)) missing.push({ name: record.name, type: record.type });
    const unique = [...new Map(missing.map((q) => [`${q.name}|${q.type}`, q])).values()];
    ask([{ name: SERVICE_TYPE, type: 'PTR' }, ...unique].slice(0, 64));
  }
  async function openSocket(epoch) {
    const available = interfaces();
    // One socket corresponds to one attachment. Mixing interfaces cannot safely key candidates.
    currentInterface = options.interfaceAddress || available[0]?.address;
    if (!currentInterface) throw new Error('No active IPv4 interface; select a LAN interface explicitly.');
    if (!options.transportFactory) requireLocalIPv4Interface(currentInterface, available);
    const socket = factory({ bind: '0.0.0.0', interface: currentInterface, port: options.port ?? 5353, loopback: true, reuseAddr: true });
    transport = socket;
    socket.on('response', (packet, rinfo) => { if (active && transport === socket && lifecycle === epoch) ingest(packet, rinfo); });
    socket.on('warning', (error) => notify({ type: 'warning', error: String(error.message ?? error) }));
    socket.on('error', (error) => notify({ type: 'error', error: String(error.message ?? error) }));
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); socket.removeListener('ready', ready); socket.removeListener('error', failed); if (cancelBind === cancel) cancelBind = undefined; };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error) => { cleanup(); reject(error); };
      const cancel = () => failed(new Error('mDNS startup cancelled'));
      const timeout = setTimeout(() => failed(new Error('mDNS bind timed out')), 5000);
      cancelBind = cancel;
      socket.once('ready', ready); socket.once('error', failed);
    }).catch((error) => { if (transport === socket) transport = null; socket.destroy(); throw error; });
    if (!active || lifecycle !== epoch) { socket.destroy(); return; }
    query();
  }
  async function start() {
    if (starting) return starting;
    if (active) return;
    active = true;
    const epoch = ++lifecycle;
    lastNetworkFingerprint = networkFingerprint();
    starting = openSocket(epoch).then(() => {
      if (!active || lifecycle !== epoch) return;
      timers = [setInterval(query, options.queryIntervalMs ?? 10000), setInterval(sweep, 250)];
      timers.push(setInterval(async () => {
      const next = networkFingerprint();
      if (!rebinding && (next !== lastNetworkFingerprint || !transport)) {
        rebinding = true;
        lastNetworkFingerprint = next;
        clearAttachment('network-attachment-changed');
        const socket = transport; transport = null;
        if (socket) await new Promise((resolve) => socket.destroy(resolve));
        try { if (active && lifecycle === epoch) await openSocket(epoch); }
        catch (error) { notify({ type: 'warning', error: error.message }); }
        finally { rebinding = false; }
      }
      }, options.networkCheckIntervalMs ?? 2000));
    }).catch((error) => { if (lifecycle === epoch) active = false; throw error; }).finally(() => { starting = null; });
    return starting;
  }
  async function stop() {
    active = false; lifecycle++;
    cancelBind?.();
    for (const timer of timers) clearInterval(timer);
    timers = [];
    const socket = transport; transport = null;
    if (socket) await new Promise((resolve) => socket.destroy(resolve));
    clearAttachment('discovery-stopped');
  }
  return {
    start, stop, query,
    snapshot: () => [...candidates.values()].map((value) => structuredClone(value)),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    // Deterministic protocol testing without opening sockets.
    ingest, sweep,
    get running() { return transport !== null; },
  };
}
