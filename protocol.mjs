import { isIP } from 'node:net';

export const SERVICE_TYPE = '_llm-api._tcp.local';
export const PROTOCOL_VERSION = '2026-04-24';
export const canonicalName = (name) => String(name ?? '').replace(/\.$/, '').toLowerCase();

/** Normalize wire values before cache identity/conflict comparisons (object key order is not DNS identity). */
export function normalizeRecord(record) {
  if (!record || typeof record.name !== 'string' || !record.name || !Number.isFinite(record.ttl) || record.ttl < 0 || ![undefined, 'IN', 1].includes(record.class)) return null;
  const value = { ...record, class: 'IN' };
  if (record.type === 'PTR') {
    if (typeof record.data !== 'string' || !record.data) return null;
    value.data = record.data;
  } else if (record.type === 'SRV') {
    if (!record.data || typeof record.data !== 'object' || typeof record.data.target !== 'string' || !Number.isInteger(record.data.port) || record.data.port < 0 || record.data.port > 65535) return null;
    for (const field of ['priority', 'weight']) if (record.data[field] !== undefined && (!Number.isInteger(record.data[field]) || record.data[field] < 0 || record.data[field] > 65535)) return null;
    value.data = { priority: record.data.priority ?? 0, weight: record.data.weight ?? 0, port: record.data.port, target: canonicalName(record.data.target) };
  } else if (record.type === 'TXT') {
    if (!Array.isArray(record.data) || record.data.some((part) => (!Buffer.isBuffer(part) && typeof part !== 'string') || Buffer.byteLength(part) > 255)) return null;
    value.data = record.data.map((part) => Buffer.from(part));
  } else if (record.type === 'A' || record.type === 'AAAA') {
    if (isIP(record.data) !== (record.type === 'A' ? 4 : 6)) return null;
  } else return null;
  return value;
}

export const recordIdentity = (record) => {
  const normalized = normalizeRecord(record);
  const data = normalized?.type === 'PTR' ? canonicalName(normalized.data) : normalized?.data;
  return normalized ? `${canonicalName(normalized.name)}|${normalized.type}|IN|${JSON.stringify(data)}` : null;
};

export function parseTxt(data) {
  const fields = Object.create(null);
  const errors = [];
  for (const part of Array.isArray(data) ? data : [data]) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part ?? ''));
    if (bytes.length > 255) { errors.push('TXT string exceeds 255 octets'); continue; }
    const value = bytes.toString('utf8');
    const equals = value.indexOf('=');
    const key = (equals < 0 ? value : value.slice(0, equals)).toLowerCase();
    if (!key || !/^[\x20-\x3c\x3e-\x7e]+$/.test(key)) { errors.push('Invalid TXT key'); continue; }
    // RFC 6763: first occurrence wins; absent value differs from an empty value.
    if (!Object.hasOwn(fields, key)) fields[key] = equals < 0 ? null : value.slice(equals + 1);
  }
  return { fields, errors };
}

export function validateBasePath(base) {
  if (typeof base !== 'string' || !base.startsWith('/') || base.startsWith('//')) return false;
  if (base !== '/' && base.endsWith('/')) return false;
  if (/[?#\\\s\u0000-\u001f\u007f]/.test(base) || /%(?![a-f0-9]{2})/i.test(base)) return false;
  let decoded;
  try { decoded = decodeURIComponent(base); } catch { return false; }
  // Conservative local policy also rejects encoded separators and dot traversal.
  if (/[?#\\\u0000-\u001f\u007f]/.test(decoded) || /%2f|%5c/i.test(base)) return false;
  return !decoded.split('/').some((part) => part === '.' || part === '..');
}

export function candidateFromRecords({ instanceName, srv, txt, addresses, interfaceId, networkId, attachmentEpoch, expiresAt }) {
  const { fields, errors } = parseTxt(txt);
  const warnings = [];
  const hostname = canonicalName(srv?.target);
  for (const field of ['txtvers', 'api', 'scheme', 'base']) {
    if (typeof fields[field] !== 'string' || !fields[field]) errors.push(`Missing or empty ${field}`);
  }
  if (fields.txtvers !== '1') errors.push('Unsupported TXT version');
  const profileSupported = fields.api === 'openresponses' && fields.protovers === PROTOCOL_VERSION;
  if (!profileSupported) errors.push('Unsupported API profile or protocol version');
  if (!['http', 'https'].includes(fields.scheme)) errors.push('Unsupported URL scheme');
  if (!validateBasePath(fields.base)) errors.push('Malformed API base path');
  if (fields.api === 'openresponses' && fields.auth === undefined) errors.push('Open Responses authentication hint is missing');
  if (fields.auth !== undefined && !['required', 'none'].includes(fields.auth)) errors.push('Invalid authentication hint');
  const draftAuthCompatible = profileSupported && fields.auth === 'required';
  if (profileSupported && fields.auth === 'none') warnings.push('auth=none is a local experiment; draft-00 Open Responses binding requires auth=required.');
  if (!hostname || hostname.length > 253 || !hostname.endsWith('.local') || !/^[a-z0-9_.-]+$/i.test(hostname)) errors.push('Invalid local service hostname');
  if (!Number.isInteger(srv?.port) || srv.port < 1 || srv.port > 65535) errors.push('Invalid service port');
  const validAddresses = [...new Set((addresses ?? []).filter((address) => isIP(address)))].sort();
  if (!validAddresses.length) errors.push('No resolved address');
  const id = `${networkId}:${attachmentEpoch}:${interfaceId}:${canonicalName(instanceName)}`;
  return {
    id, interfaceId, networkId, attachmentEpoch, instanceName,
    displayName: String(instanceName).replace(/\._llm-api\._tcp\.local\.?$/i, ''),
    hostname, addresses: validAddresses, port: srv?.port,
    basePath: fields.base, baseURL: errors.length ? null : `${fields.scheme}://${hostname}:${srv.port}${fields.base}`,
    apiProfile: fields.api, protocolVersion: fields.protovers, scheme: fields.scheme,
    auth: fields.auth ?? 'unknown', expiresAt, profileSupported, draftAuthCompatible,
    validation: { valid: errors.length === 0, errors, warnings },
  };
}

export function serviceRecords(service, ttl = 120) {
  const { instanceName, hostname, address, port, basePath = '/v1', auth = 'required' } = service;
  if (!isIP(address)) throw new Error('An explicitly configured publish address is required');
  if (typeof instanceName !== 'string' || !instanceName || typeof hostname !== 'string' || !hostname) throw new Error('An instance name and hostname are required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port');
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 4500) throw new Error('Invalid record TTL');
  if (!validateBasePath(basePath)) throw new Error('Invalid base path');
  if (!['required', 'none'].includes(auth)) throw new Error('Invalid authentication hint; use required or none');
  const name = instanceName.endsWith(SERVICE_TYPE) || instanceName.endsWith(`${SERVICE_TYPE}.`) ? instanceName : `${instanceName}.${SERVICE_TYPE}`;
  return [
    { name: SERVICE_TYPE, type: 'PTR', ttl, data: name },
    { name, type: 'SRV', ttl, flush: true, data: { priority: 0, weight: 0, port, target: hostname } },
    { name, type: 'TXT', ttl, flush: true, data: Object.entries({ txtvers: '1', api: 'openresponses', protovers: PROTOCOL_VERSION, scheme: 'https', base: basePath, auth }).map(([k, v]) => Buffer.from(`${k}=${v}`)) },
    { name: hostname, type: isIP(address) === 6 ? 'AAAA' : 'A', ttl, flush: true, data: address },
  ];
}
