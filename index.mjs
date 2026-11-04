import multicastDns from 'multicast-dns';
import os from 'node:os';
import { isIP } from 'node:net';
import { SERVICE_TYPE, canonicalName, candidateFromRecords, normalizeRecord, recordIdentity } from './protocol.mjs';
import { chooseIPv4Attachment, readNetworkRouteHints } from './network.mjs';
export * from './protocol.mjs';
export { chooseIPv4Attachment, readNetworkRouteHints } from './network.mjs';

/** List assigned, non-loopback IPv4 addresses without opening a socket. */
export function listIPv4Interfaces(readInterfaces = os.networkInterfaces) {
  return Object.entries(readInterfaces()).flatMap(([name, rows]) => (rows ?? [])
    .filter(row => !row.internal && (row.family === 'IPv4' || row.family === 4) && isIP(row.address) === 4 && row.address !== '0.0.0.0')
    .map(row => ({ name, address: row.address, mac: row.mac })));
}

/** Validate an address, not an OS-specific interface name such as en0 or eth0. */
export function requireLocalIPv4Interface(address, available = listIPv4Interfaces()) {
  if (typeof address !== 'string' || isIP(address) !== 4) throw interfaceError('DISCOVERY_INTERFACE_INVALID', 'Select a local IPv4 interface address, not a device name.');
  if (!available.some(row => row.address === address)) throw interfaceError('DISCOVERY_INTERFACE_UNAVAILABLE', 'The selected discovery interface is not currently attached.');
  return address;
}

const interfaceError = (code, message) => Object.assign(new Error(message), { code });
const networkUnavailable = error => ['DISCOVERY_INTERFACE_UNAVAILABLE', 'DISCOVERY_NO_INTERFACE', 'DISCOVERY_NETWORK_PROBE_TIMEOUT', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ENODEV'].includes(error?.code);

const recordKey = recordIdentity;
const semanticCandidate = (candidate) => JSON.stringify({ ...candidate, expiresAt: 0, recordGeneration: 0 });

export function createDiscoveryClient(options = {}) {
  options = { ...options };
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
  let rebinding;
  let stopping;
  let status = 'stopped';
  let cancelBind;
  let selectedAttachment = null;
  let probeController;
  const automatic = options.interfaceMode === 'auto';
  const lastQuestion = new Map();
  const interfaceId = () => currentInterface ?? 'all';
  const networkId = options.networkId ?? 'local';
  const now = options.now ?? Date.now;
  const factory = options.transportFactory ?? ((config) => multicastDns(config));
  const notify = (event) => { for (const fn of listeners) { try { fn(event); } catch {} } };
  const interfaces = () => listIPv4Interfaces(options.networkInterfaces);
  const networkFingerprint = () => JSON.stringify(interfaces().map(({ name, address, mac }) => [name, address, mac]).sort());
  const attachmentView = () => selectedAttachment ? {
    mode: automatic ? 'auto' : 'pinned', interfaceName: selectedAttachment.interfaceName,
    interfaceAddress: selectedAttachment.interfaceAddress, attachmentEpoch,
  } : null;
  function setAttachment(value) {
    selectedAttachment = value;
    currentInterface = value?.interfaceAddress;
    notify({ type: 'network', attachment: attachmentView() });
  }
  async function resolveAutoAttachment() {
    const available = interfaces();
    const signal = probeController.signal;
    const attempt = new AbortController();
    const timeoutMs = options.networkProbeTimeoutMs ?? 3500;
    const result = await new Promise((resolve, reject) => {
      const cancel = () => { finish(interfaceError('DISCOVERY_NETWORK_PROBE_CANCELLED', 'Network inspection cancelled.')); attempt.abort(); };
      const timeout = setTimeout(() => { finish(interfaceError('DISCOVERY_NETWORK_PROBE_TIMEOUT', 'Network inspection is temporarily unavailable.')); attempt.abort(); }, timeoutMs);
      const finish = (error, value) => {
        clearTimeout(timeout); signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      Promise.resolve().then(async () => {
        if (options.resolveNetworkAttachment) return options.resolveNetworkAttachment({ interfaces: structuredClone(available), previous: selectedAttachment ? structuredClone(selectedAttachment) : null, signal: attempt.signal });
        const routes = options.networkInterfaces ? [] : await readNetworkRouteHints({ signal: attempt.signal });
        return chooseIPv4Attachment(available, { preferredInterfaceName: options.preferredInterfaceName, previous: selectedAttachment, routes });
      }).then(value => finish(null, value), error => finish(error));
    });
    if (result === null || result === undefined) return null;
    if (typeof result !== 'object' || isIP(result.interfaceAddress ?? '') !== 4) throw interfaceError('DISCOVERY_INTERFACE_INVALID', 'The network resolver must select a local IPv4 address.');
    const row = available.find(row => row.address === result.interfaceAddress && (!result.interfaceName || row.name === result.interfaceName));
    if (!row) throw interfaceError('DISCOVERY_INTERFACE_INVALID', 'The network resolver must select an attached interface and matching IPv4 address.');
    if (result.networkId !== undefined && (typeof result.networkId !== 'string' || result.networkId.length > 1024)) throw interfaceError('DISCOVERY_INTERFACE_INVALID', 'The network resolver attachment identity must be a bounded string.');
    return { ...result, interfaceName: row.name, interfaceMac: row.mac };
  }
  const attachmentFingerprint = value => JSON.stringify(value ? [value.interfaceName, value.interfaceAddress, value.interfaceMac ?? '', value.networkId ?? ''] : null);

  function setStatus(value) {
    if (status === value) return;
    status = value;
    notify({ type: 'status', status });
  }
  function transportFailure(error, socket) {
    if (!active || transport !== socket) return;
    if (options.waitForNetwork && networkUnavailable(error)) {
      transport = null;
      clearAttachment('network-attachment-changed');
      setStatus('waiting');
      socket.destroy();
    } else notify({ type: 'warning', error: String(error.message ?? error) });
  }
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
    const socket = transport;
    try { socket.query({ questions: relevant.slice(0, 64), answers }, (error) => { if (error) transportFailure(error, socket); }); }
    catch (error) { transportFailure(error, socket); }
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
  async function openSocket(epoch, attachment) {
    const available = interfaces();
    // One socket corresponds to one attachment. Mixing interfaces cannot safely key candidates.
    currentInterface = automatic ? attachment?.interfaceAddress : options.interfaceAddress || available[0]?.address;
    if (!currentInterface) throw interfaceError('DISCOVERY_NO_INTERFACE', 'No active IPv4 interface; select a LAN interface explicitly.');
    if (!options.transportFactory || options.networkInterfaces) requireLocalIPv4Interface(currentInterface, available);
    if (automatic) setAttachment(attachment);
    else selectedAttachment = { interfaceAddress: currentInterface, interfaceName: available.find(row => row.address === currentInterface)?.name };
    const socket = factory({ bind: '0.0.0.0', interface: currentInterface, port: options.port ?? 5353, loopback: true, reuseAddr: true });
    transport = socket;
    let readyForTraffic = false;
    socket.on('response', (packet, rinfo) => { if (active && transport === socket && lifecycle === epoch) ingest(packet, rinfo); });
    socket.on('warning', (error) => { if (readyForTraffic || !networkUnavailable(error)) transportFailure(error, socket); });
    socket.on('error', (error) => { if (readyForTraffic) transportFailure(error, socket); });
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); socket.removeListener('ready', ready); socket.removeListener('error', failed); socket.removeListener('warning', warning); if (cancelBind === cancel) cancelBind = undefined; };
      const ready = () => { readyForTraffic = true; cleanup(); resolve(); };
      const failed = (error) => { cleanup(); reject(error); };
      const warning = error => { if (networkUnavailable(error)) failed(error); };
      const cancel = () => failed(new Error('mDNS startup cancelled'));
      const timeout = setTimeout(() => failed(new Error('mDNS bind timed out')), 5000);
      cancelBind = cancel;
      socket.once('ready', ready); socket.once('error', failed); socket.on('warning', warning);
    }).catch((error) => { if (transport === socket) { transport = null; socket.destroy(); } throw error; });
    if (!active || lifecycle !== epoch) { if (transport === socket) { transport = null; socket.destroy(); } return; }
    readyForTraffic = true;
    query();
  }
  async function attach(epoch, attachment) {
    try {
      await openSocket(epoch, attachment);
      if (active && lifecycle === epoch && transport) setStatus('discovering');
    } catch (error) {
      if (!active || lifecycle !== epoch) return;
      if (!options.waitForNetwork || !networkUnavailable(error)) throw error;
      setStatus('waiting');
    }
  }
  async function start() {
    if (stopping) await stopping;
    if (starting) return starting;
    if (active) return;
    if (options.interfaceMode !== undefined && !['auto', 'pinned'].includes(options.interfaceMode)) throw interfaceError('DISCOVERY_INTERFACE_INVALID', 'Discovery interfaceMode must be auto or pinned.');
    if (options.preferredInterfaceName !== undefined && (typeof options.preferredInterfaceName !== 'string' || !options.preferredInterfaceName.trim())) throw interfaceError('DISCOVERY_INTERFACE_INVALID', 'A preferred interface name must be a nonempty device name.');
    active = true;
    const epoch = ++lifecycle;
    probeController = new AbortController();
    const initial = automatic ? (async () => {
      let attachment;
      try { attachment = await resolveAutoAttachment(); }
      catch (error) {
        if (!active || lifecycle !== epoch) return;
        if (options.waitForNetwork && networkUnavailable(error)) { setStatus('waiting'); return; }
        throw error;
      }
      if (!active || lifecycle !== epoch) return;
      lastNetworkFingerprint = attachmentFingerprint(attachment);
      await attach(epoch, attachment);
    })() : (lastNetworkFingerprint = networkFingerprint(), attach(epoch));
    starting = initial.then(() => {
      if (!active || lifecycle !== epoch) return;
      timers = [setInterval(query, options.queryIntervalMs ?? 10000), setInterval(sweep, 250)];
      timers.push(setInterval(() => {
        if (!active || lifecycle !== epoch || rebinding) return;
        rebinding = (async () => {
          const attachment = automatic ? await resolveAutoAttachment() : undefined;
          if (!active || lifecycle !== epoch) return;
          const next = automatic ? attachmentFingerprint(attachment) : networkFingerprint();
          if (next === lastNetworkFingerprint && transport) return;
          // Learning the first cached gateway MAC is stronger evidence for the same
          // attachment, not a move. Later MAC replacement still invalidates it.
          if (automatic && transport && attachment?.gatewayMac && !selectedAttachment?.gatewayMac
            && attachment.routeBase && attachment.routeBase === selectedAttachment?.routeBase
            && attachment.interfaceName === selectedAttachment.interfaceName
            && attachment.interfaceAddress === selectedAttachment.interfaceAddress
            && attachment.interfaceMac === selectedAttachment.interfaceMac) {
            selectedAttachment = attachment; lastNetworkFingerprint = next; return;
          }
          lastNetworkFingerprint = next;
          if (options.waitForNetwork) setStatus('waiting');
          clearAttachment('network-attachment-changed');
          if (automatic && !attachment) setAttachment(null);
          const socket = transport; transport = null;
          if (socket) await new Promise((resolve) => socket.destroy(resolve));
          if (active && lifecycle === epoch) await attach(epoch, attachment);
        })().catch(error => {
          if (!active || lifecycle !== epoch) return;
          if (options.waitForNetwork && networkUnavailable(error)) { if (!transport) setStatus('waiting'); return; }
          setStatus('error'); notify({ type: 'warning', error: error.message });
        }).finally(() => { rebinding = null; });
      }, options.networkCheckIntervalMs ?? 2000));
    }).catch((error) => { if (lifecycle === epoch) { active = false; setStatus('error'); } throw error; }).finally(() => { starting = null; });
    return starting;
  }
  async function stop() {
    if (stopping) return stopping;
    active = false; lifecycle++;
    probeController?.abort();
    cancelBind?.();
    for (const timer of timers) clearInterval(timer);
    timers = [];
    const socket = transport; transport = null;
    stopping = (async () => {
      if (socket) await new Promise((resolve) => socket.destroy(resolve));
      await Promise.allSettled([starting, rebinding]);
      clearAttachment('discovery-stopped');
      if (automatic) setAttachment(null);
      else selectedAttachment = null;
      setStatus('stopped');
    })().finally(() => { stopping = null; });
    return stopping;
  }
  return {
    start, stop, query,
    snapshot: () => [...candidates.values()].map((value) => structuredClone(value)),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    // Deterministic protocol testing without opening sockets.
    ingest, sweep,
    get running() { return transport !== null; },
    get status() { return status; },
    get attachment() { return attachmentView(); },
  };
}
