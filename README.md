# LLM API discovery core

[中文](README.zh-CN.md) · [Website](https://nobrowning.github.io/llm-service-discovery-demo/) · [Full guide](https://github.com/nobrowning/llm-discovery-core/blob/main/docs/guide.md)

A Node.js library that finds LLM API services on the local network and keeps the list current. Use it to give an AI app a "nearby LLM services" list, like the Wi-Fi list on a laptop.

## Why

AI apps such as coding agents, chat apps and IDE assistants already talk to models through an API, so they can switch servers easily. What they lack is a way to see which servers are available on the network they are on. Users end up typing IP addresses, ports and paths into settings, and doing it again when the server moves or the laptop joins another network.

Servers that use [llm-api-advertiser](https://github.com/nobrowning/llm-api-advertiser) announce themselves with mDNS/DNS-SD under the service type `_llm-api._tcp`. This library listens for them and turns the records into a checked list your app can show.

## What it does

- Browses `_llm-api._tcp.local` and builds one candidate per service, with a ready-to-use base URL such as `https://studio-llm.local:8443/v1`.
- Checks every record: TXT version, API profile, base path, auth hint, host name, port and address. Invalid records are reported and never become connectable.
- Keeps the list current as services are added, updated, withdrawn or expire.
- Follows the network (prerelease `0.4.0-roaming.1`). With `interfaceMode: 'auto'` it starts over on the new network when the device moves to another LAN. With `waitForNetwork: true` it waits quietly while there is no network instead of reporting an error.

It does not connect to APIs, decide trust or send credentials. Discovery records are untrusted hints; your app should check TLS and its own trust policy before it sends a key.

## Quick start

You need Node.js 22 or later. Download a `.tgz` and `SHA256SUMS` from [Releases](https://github.com/nobrowning/llm-discovery-core/releases):

- `0.3.2` is the latest release.
- `0.4.0-roaming.1` is a prerelease that adds network following and `network` events. It is also in the [demo repository's `vendor/` folder](https://github.com/nobrowning/llm-service-discovery-demo/tree/main/vendor).

```sh
npm install ./llm-discovery-discovery-core-0.4.0-roaming.1.tgz
```

```js
import { createDiscoveryClient } from '@llm-discovery/discovery-core';

const client = createDiscoveryClient({
  interfaceMode: 'auto',   // follow the current LAN
  waitForNetwork: true,    // wait quietly while offline
});
client.subscribe(event => {
  if (event.type === 'added' || event.type === 'updated') {
    console.log(event.candidate.displayName, event.candidate.baseURL);
  }
  if (event.type === 'removed') console.log('gone:', event.candidate.displayName);
});
await client.start();
// later: await client.stop();
```

`client.snapshot()` returns the current list. Events are `added`, `updated`, `invalid`, `removed`, `network`, `status` and `warning`.

With release `0.3.2`, pass `interfaceAddress: '192.168.1.20'` (your LAN IPv4 address) instead of `interfaceMode`. Without an address it uses the first eligible IPv4 interface. There are no `network` events in `0.3.2`.

## Learn more

- [Full guide](https://github.com/nobrowning/llm-discovery-core/blob/main/docs/guide.md): choosing an interface, waiting for a network, how network changes are detected, protocol helpers, auth hints, platforms.
- [Technical details](https://nobrowning.github.io/llm-service-discovery-demo/technical.html): records, TXT keys, validation rules and the discovery flow.
- [Platform validation](https://github.com/nobrowning/llm-discovery-core/blob/main/docs/platform-validation.md).

## Status

Experimental implementation of the IETF Internet-Draft [draft-cui-dawn-local-llm-api-discovery-00](https://datatracker.ietf.org/doc/draft-cui-dawn-local-llm-api-discovery/). IPv4 multicast on one interface at a time; services must be on the same local network. It does not change firewall, routing or system DNS settings.

## Part of Local LLM API Discovery

| Repository | What it does |
|---|---|
| [llm-api-advertiser](https://github.com/nobrowning/llm-api-advertiser) | Announces an LLM API on the local network. Runs next to the server. |
| **llm-discovery-core** (this repository) | Finds and checks announced services. A library for client apps. |
| [dsh-lan-discovery](https://github.com/nobrowning/dsh-lan-discovery) | Lists LAN services inside DeepSeek Harness and connects the one you choose. |
| [llm-service-discovery-demo](https://github.com/nobrowning/llm-service-discovery-demo) | Runnable demo with simulated APIs, and the project website. |

## Development

```sh
npm ci --ignore-scripts
npm test
npm pack
```

## License

MIT. See [LICENSE](LICENSE).
