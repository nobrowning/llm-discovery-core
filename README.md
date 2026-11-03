# LLM API discovery core

Reusable Node.js mDNS/DNS-SD discovery and protocol helpers for `_llm-api._tcp.local`. This package has no Harness, Docker, Mock API, credentials, or UI dependency. It implements the experimental discovery profile used by the local LLM discovery demo; it is not a claim of complete RFC or draft conformance.

## Develop and package

Requires Node.js 22 or later. Node.js 24 is used by CI.

```sh
npm ci --ignore-scripts
npm test
npm pack
```

This checkout is independently installable. Until an npm release is published, consumers can install the generated tarball with `npm install /path/to/llm-discovery-discovery-core-0.3.0.tgz`. No published npm package or public repository URL is assumed.

## Discover services

```js
import { createDiscoveryClient } from '@llm-discovery/discovery-core';

const client = createDiscoveryClient({
  interfaceAddress: '192.168.1.20', // An IPv4 address attached to this client.
  networkId: 'office-lan',
});
const unsubscribe = client.subscribe(event => {
  if (event.type === 'added' || event.type === 'updated') {
    console.log(event.candidate.displayName, event.candidate.baseURL);
  }
});
await client.start();

// On application shutdown:
process.once('SIGINT', async () => {
  unsubscribe();
  await client.stop();
});
```

The selected interface must support multicast. This library does not alter firewall, routing, or system DNS settings. If no interface is supplied, it selects the first eligible non-loopback IPv4 interface; applications with multiple adapters should select one explicitly.

`snapshot()` returns the current candidates. `subscribe()` receives discovery, removal, validation, and network warnings. `stop()` closes the socket and timers. `query()` requests a refresh. Candidate state includes the network attachment, resolved addresses, expiration, validation, and a record generation so clients can reject stale selections.

## Protocol helpers

The root export also provides `SERVICE_TYPE`, `serviceRecords`, `parseTxt`, `candidateFromRecords`, and validation helpers. For record-only use:

```js
import { serviceRecords } from '@llm-discovery/discovery-core/protocol';
```

Publishing services belongs in the separate advertiser package. HTTPS trust, authorization, model/capability inspection, and inference belong in the consuming client. DNS-SD records are untrusted hints and do not authorize connecting to an API or sending credentials.

### Authentication hints

`serviceRecords(service)` accepts per-service `auth: 'required' | 'none'`, defaulting to `required` when omitted. Different API paths on the same host may have different requirements. Unknown values are rejected. Only this hint is included in TXT; no token or API key is read or advertised.

```js
const shared = { hostname: 'studio-llm.local', address: '192.168.1.20', port: 8443 };
const protectedRecords = serviceRecords({ ...shared, instanceName: 'Private Text', basePath: '/private/v1', auth: 'required' });
const publicRecords = serviceRecords({ ...shared, instanceName: 'Public Text', basePath: '/public/v1', auth: 'none' });
```

The [draft's TXT table](https://datatracker.ietf.org/doc/html/draft-cui-dawn-local-llm-api-discovery-00#section-5.2) defines both values, but its [Open Responses binding](https://datatracker.ietf.org/doc/html/draft-cui-dawn-local-llm-api-discovery-00#section-5.3) requires `auth=required`. Therefore this package treats Open Responses with `auth=none` as an explicit **local experimental extension**, not draft-00 compliance. Such a candidate remains usable under the consuming application's independent policy and carries `draftAuthCompatible: false` plus a `validation.warnings` entry. Required-auth candidates carry `draftAuthCompatible: true`. A missing hint remains `unknown` and is not a connectable Open Responses candidate; unrecognized hint values are invalid. A valid candidate or `auth=none` never grants authorization by itself.

The network client currently uses IPv4 multicast. It can retain A and AAAA records, but that does not constitute verified IPv6 transport or cross-subnet discovery support. The deterministic tests here do not open multicast sockets; live network and interoperability checks are maintained in the demo repository.

## 中文说明

这是可独立复用的局域网 LLM API 发现库，负责 mDNS/DNS-SD 浏览、记录校验、缓存与服务生命周期。它不依赖 Harness、Docker 或演示模型，也不读取凭据或修改系统网络设置。

运行 `npm ci --ignore-scripts`、`npm test`、`npm pack` 即可安装依赖、测试和生成独立安装包。尚未发布 npm 时可直接安装生成的 `.tgz`。多网卡机器应通过 `interfaceAddress` 明确选择客户端 IPv4 地址。

公告功能位于单独的 advertiser 模块；HTTPS 信任、认证和推理由客户端实现。发现记录只是未受信任的服务线索，不能直接当作授权。真实网络互通验收保存在独立 Demo 仓库。

每个服务可配置 `auth: 'required'`（默认）或 `auth: 'none'`；同一主机的不同路径可使用不同设置。这里只公告认证要求，不传播 API key。草案通用 TXT 字段支持这两个值，但 -00 的 Open Responses binding 要求 `required`，因此免 key 的 Open Responses 是本项目的实验扩展，候选会包含 `draftAuthCompatible: false` 和诊断 warning；仍需独立的连接授权与 TLS 验证。

MIT License. See [LICENSE](LICENSE).
