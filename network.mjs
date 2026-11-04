import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const exec = promisify(execFile);
const virtual = /^(?:lo\d*|utun\d*|tun\d*|tap\d*|wg\d*|docker\d*|veth.*|br-.*|virbr.*|vmnet.*|vboxnet.*|tailscale.*|zt[a-z0-9]+|bridge\d*)$|vpn|virtual|hyper-v|vethernet|loopback|wsl/i;
const linkAddress = value => {
  const mac = String(value ?? '').replace(/-/g, ':').toLowerCase();
  if (!/^[0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}$/.test(mac)) return undefined;
  const normalized = mac.split(':').map(part => part.padStart(2, '0')).join(':');
  return normalized === '00:00:00:00:00:00' ? undefined : normalized;
};

/** Choose one LAN attachment. An old IPv4 address is deliberately not a preference. */
export function chooseIPv4Attachment(interfaces, { preferredInterfaceName, previous, routes = [] } = {}) {
  const physical = interfaces.filter(row => isIP(row.address) === 4 && !virtual.test(row.name));
  const assigned = physical.filter(row => !row.address.startsWith('169.254.'));
  const usable = assigned.length ? assigned : physical;
  if (!usable.length) return null;
  const routeFor = row => routes.filter(route => route.name === row.name && isIP(route.gateway) === 4)
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0];
  const selected = usable.find(row => row.name === preferredInterfaceName)
    ?? [...usable].filter(routeFor).sort((a, b) => (routeFor(a).metric ?? 0) - (routeFor(b).metric ?? 0))[0]
    ?? usable.find(row => row.name === previous?.interfaceName)
    ?? [...usable].sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))[0];
  const route = routeFor(selected);
  const routeBase = `${selected.name}|${selected.address}|${route?.gateway ?? ''}`;
  // An incomplete ARP-cache entry is not evidence of changing networks.
  const gatewayMac = linkAddress(route?.mac) ?? (previous?.routeBase === routeBase ? previous.gatewayMac : undefined);
  let networkId = route ? `${route.gateway}|${gatewayMac ?? ''}` : undefined;
  // OS route inspection is best-effort; temporary probe failure must not churn a live socket.
  if (!route && selected.name === previous?.interfaceName && selected.address === previous?.interfaceAddress) networkId = previous.networkId;
  return {
    interfaceName: selected.name, interfaceAddress: selected.address,
    interfaceMac: selected.mac,
    networkId, gatewayMac, routeBase: route || selected.name !== previous?.interfaceName || selected.address !== previous?.interfaceAddress ? routeBase : previous.routeBase ?? routeBase,
  };
}

/** Read OS route/neighbor caches only. No route, firewall, Wi-Fi or ARP changes. */
export async function readNetworkRouteHints({ platform = process.platform, signal, execFileImpl = exec, readFileImpl = readFile } = {}) {
  const run = async (file, args) => (await execFileImpl(file, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 256 * 1024, windowsHide: true, signal })).stdout;
  try {
    if (platform === 'darwin') {
      const text = await run('/sbin/route', ['-n', 'get', 'default']);
      const name = text.match(/^\s*interface:\s*(\S+)/m)?.[1];
      const gateway = text.match(/^\s*gateway:\s*(\S+)/m)?.[1];
      if (!name || isIP(gateway ?? '') !== 4) return [];
      let mac;
      try {
        const arp = await run('/usr/sbin/arp', ['-n', gateway]);
        // Only accept the requested gateway on its reported interface.
        const row = arp.split('\n').find(line => line.includes(`(${gateway})`) && line.includes(` on ${name} `));
        mac = linkAddress(row?.match(/\bat\s+([^\s]+)/)?.[1]);
      } catch { /* The gateway might not be in the cache yet. */ }
      return [{ name, gateway, mac, metric: 0 }];
    }
    if (platform === 'linux') {
      const [table, arp] = await Promise.all([
        readFileImpl('/proc/net/route', { encoding: 'utf8', signal }),
        readFileImpl('/proc/net/arp', { encoding: 'utf8', signal }).catch(() => ''),
      ]);
      return table.trim().split('\n').slice(1).flatMap(line => {
        const [name, destination, hex, flags, , , metric, mask] = line.trim().split(/\s+/);
        if (destination !== '00000000' || mask !== '00000000' || !/^[0-9a-f]{8}$/i.test(hex) || !(parseInt(flags, 16) & 1)) return [];
        const gateway = hex.match(/../g).reverse().map(byte => parseInt(byte, 16)).join('.');
        if (gateway === '0.0.0.0') return [];
        const neighbor = arp.split('\n').map(row => row.trim().split(/\s+/)).find(row => row[0] === gateway && row[5] === name);
        return [{ name, gateway, metric: Number(metric) || 0, mac: linkAddress(neighbor?.[3]) }];
      });
    }
    if (platform === 'win32') {
      const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object {$r=$_;$i=Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue;$n=Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex -IPAddress $r.NextHop -ErrorAction SilentlyContinue | Select-Object -First 1;[pscustomobject]@{name=$r.InterfaceAlias;gateway=$r.NextHop;metric=($r.RouteMetric+$i.InterfaceMetric);mac=$n.LinkLayerAddress}}) | ConvertTo-Json -Compress";
      const result = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
      return (Array.isArray(result) ? result : [result]).filter(row => row && typeof row.name === 'string' && isIP(row.gateway ?? '') === 4)
        .map(row => ({ name: row.name, gateway: row.gateway, metric: Number(row.metric) || 0, mac: linkAddress(row.mac) }));
    }
  } catch { /* Unavailable platform tools do not prevent basic LAN discovery. */ }
  return [];
}
