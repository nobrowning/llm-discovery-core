# LLM API discovery core

Reusable Node.js mDNS/DNS-SD discovery and protocol helpers for `_llm-api._tcp.local`. This package has no Harness, Docker, Mock API, credentials, or UI dependency. It implements the experimental discovery profile used by the local LLM discovery demo; it is not a claim of complete RFC or draft conformance.

## Develop and package

Requires Node.js 22 or later and npm. Use a Node.js runtime matching the host CPU (for example, native ARM64 on Apple Silicon or Linux ARM64). The package and its dependencies are JavaScript; no native add-on, Docker, WSL, Homebrew, or system Bonjour/Avahi development library is required.

```sh
npm ci --ignore-scripts
npm test
npm pack
```

## Install a release

Download `llm-discovery-discovery-core-0.3.2.tgz` and `SHA256SUMS` from [GitHub Releases](https://github.com/nobrowning/llm-discovery-core/releases). With Node.js 22 or later and npm installed, install the archive in your application:

```sh
npm install ./llm-discovery-discovery-core-0.3.2.tgz
```

This is a developer library, with no desktop application or command-line entry point. npm obtains its third-party dependencies from the registry or your local cache; the archive is not an offline runtime bundle. No separate advertiser, Harness plugin, or Demo installation is required. The package is distributed through GitHub Releases and is not published to the npm registry.

On Linux, verify the downloaded archive with `sha256sum --check SHA256SUMS`; on macOS use `shasum -a 256 -c SHA256SUMS`. On Windows, compare `(Get-FileHash .\llm-discovery-discovery-core-0.3.2.tgz -Algorithm SHA256).Hash` with the entry in `SHA256SUMS`.

Maintainers can run `npm run release:prepare` after installation and tests. It checks the package allowlist, checks reproducible archive bytes, installs the final archive into an isolated temporary project, and exercises its public exports. Outputs are written to `.release-artifacts/`; an optional output directory can be supplied after `--`. Pushing a matching `v0.3.2` tag runs these checks and uploads the archive plus checksum file to GitHub Releases. It never publishes to npm.

## Discover services

List assigned, non-loopback IPv4 addresses before selecting a network:

```js
import { listIPv4Interfaces, requireLocalIPv4Interface } from '@llm-discovery/discovery-core';
const interfaces = listIPv4Interfaces(); // [{ name, address, mac }, ...]
console.table(interfaces);
const interfaceAddress = requireLocalIPv4Interface('192.168.1.20', interfaces);
```

Interface names differ between operating systems; `interfaceAddress` always takes the IPv4 address, not `en0`, `eth0`, or `Ethernet`. Listing addresses does not prove multicast reachability. VPN and virtual adapters may appear, so select the LAN used by the services. `requireLocalIPv4Interface()` rejects malformed, IPv6, and unattached addresses without opening a socket. The real discovery transport performs the same check when starting and rebinding.

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

The selected interface must support multicast. This library does not alter firewall, routing, or system DNS settings. The legacy default, when no interface is supplied, selects the first eligible non-loopback IPv4 interface. Applications can instead opt into the automatic attachment policy below.

`snapshot()` returns the current candidates. `subscribe()` receives discovery, removal, validation, and network warnings. `stop()` closes the socket and timers. `query()` requests a refresh. Candidate state includes the network attachment, resolved addresses, expiration, validation, and a record generation so clients can reject stale selections.

## Waiting for a temporarily unavailable network

Clients that need to remain usable while offline can pass `waitForNetwork: true`.
An absent selected address, no active IPv4 interface, or transient network socket
failure then enters `status === 'waiting'` instead of rejecting startup. The
existing network-check timer retries, and resumes discovery when the selected
network is available. A pinned address never falls back to another adapter.
Invalid addresses and permission failures still reject initial startup.

`status` is `stopped`, `waiting`, `discovering`, or `error`; subscribers receive
`{ type: 'status', status }` only on transitions. `running` still means a socket
is present, so it is false while waiting. `stop()` cancels binding and retries;
late packets from old sockets are ignored. Network changes invalidate cached
candidates and attachment IDs. The default strict startup behavior is unchanged.

## Automatically discover again after changing networks

For a client that moves from the office network to a home network, opt into automatic
selection and resilient startup together:

```js
const client = createDiscoveryClient({
  interfaceMode: 'auto',
  waitForNetwork: true,
  // Optional: follow this physical adapter across DHCP address changes.
  // preferredInterfaceName: 'en0',
});
client.subscribe(event => {
  if (event.type === 'network') console.log(event.attachment);
});
await client.start();
console.log(client.attachment);
// { mode: 'auto', interfaceName, interfaceAddress, attachmentEpoch }, or null.
```

Automatic mode ignores any old `interfaceAddress` configuration. It selects an
assigned physical LAN adapter, preferring `preferredInterfaceName` when attached,
then the usable default-route adapter, then the existing physical adapter and a
stable name/address order. Recognizable VPN/container/virtual adapters are excluded;
use a pinned address for an intentional VPN or virtual-network deployment. Assigned
addresses are preferred to link-local IPv4; link-local-only physical LANs remain
eligible. This is a single-interface policy, not concurrent scanning of all NICs.

When the selected attachment changes, the old candidate cache is cleared, previous
socket responses are ignored, and discovery starts on the new address. Unrelated
NIC changes do not invalidate the selected attachment. No available LAN enters the
normal waiting state. Discovery does not reconnect API sessions or replay requests;
the consuming application must revalidate trust and credentials before connecting.

Read-only OS route and neighbor-cache inspection adds best-effort detection of
different networks that assign the same IPv4 address. macOS uses `route` and `arp`,
Linux reads `/proc/net/route` and `/proc/net/arp`, and Windows uses bounded
PowerShell `Get-NetRoute`/`Get-NetNeighbor` queries. No external API or SSID/location
permission is needed. Missing platform tools fall back to interface selection.
If the interface/address/default gateway and available gateway identity are all
unchanged, OS polling alone cannot prove that a network changed. An embedding host
with OS network-change notifications can supply a stronger attachment identity.

`resolveNetworkAttachment({ interfaces, previous, signal })` is an optional async
hook returning `{ interfaceAddress, interfaceName?, networkId? }` or `null`. The
address must belong to the supplied interfaces. Its `networkId` is an attachment
identity hint only: it never replaces the top-level `networkId` used by candidates
and trust policies. Resolver work has a 3500 ms deadline (`networkProbeTimeoutMs`)
and receives an abort signal on shutdown; late results cannot open a new socket.
The network monitor uses the existing `networkCheckIntervalMs` interval (2000 ms).
Injected `networkInterfaces` without a resolver uses deterministic selection and
does not inspect the real host's routing table.

Omitting `interfaceMode`, or setting it to `pinned`, preserves the existing explicit
IPv4 selection. Automatic mode does not rewrite the caller's configuration. The
exported `chooseIPv4Attachment()` and `readNetworkRouteHints()` helpers expose the
selection and read-only inspection separately for host integration and tests.

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

## Platform verification

The same release archive is used on Windows, macOS, and Linux. CI is configured for the following native runners, using [GitHub's documented architecture labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners):

| Platform | Runner | Node.js |
|---|---|---|
| Linux x64 | `ubuntu-24.04` | 22 and 24 |
| Linux ARM64 | `ubuntu-24.04-arm` | 24 |
| Windows x64 | `windows-2022` | 24 |
| macOS Apple Silicon | `macos-15` | 24 |
| macOS Intel | `macos-15-intel` | 24 |

Each job checks its actual CPU architecture, protocol/interface tests, and installation of the final tarball in a fresh project. See the [CI runs](https://github.com/nobrowning/llm-discovery-core/actions/workflows/ci.yml) for completed results; this table describes the configured coverage, not a claim that an unrun job passed. Node.js's own OS support requirements still apply.

Real-network status is separate: the earlier Windows/WSL Demo has live-network evidence; native macOS Bonjour coexistence, Linux Avahi coexistence, and cross-machine ARM64 discovery are not established by these socket-free tests. Follow the [Demo validation report](https://github.com/nobrowning/llm-service-discovery-demo/blob/main/docs/validation-report.md) for actual runs. A LAN must carry IPv4 mDNS (`224.0.0.251`, UDP 5353) and the advertised API traffic. Keep existing system mDNS services enabled during coexistence checks. Investigate bind/membership warnings, the selected adapter, host firewall/local-network permissions, and access-point isolation when discovery fails; this library never changes those settings.

Release archives are built on the Linux release runner. Repeated packing on the same environment is checked; a local rebuild on another OS can differ in tar executable-bit metadata without changing JavaScript contents.

## 中文说明

这是可独立复用的局域网 LLM API 发现库，负责 mDNS/DNS-SD 浏览、记录校验、缓存与服务生命周期。它不依赖 Harness、Docker 或演示模型，也不读取凭据或修改系统网络设置。

从 [GitHub Releases](https://github.com/nobrowning/llm-discovery-core/releases) 下载 `.tgz` 和 `SHA256SUMS`，校验后在应用目录运行 `npm install ./llm-discovery-discovery-core-0.3.2.tgz`。需要 Node.js 22+，安装时 npm 仍需获取第三方依赖。此包是供开发者集成的 SDK，不是独立桌面程序，无需另装公告器、Harness 插件或 Demo。

开发者运行 `npm ci --ignore-scripts`、`npm test`、`npm run release:prepare` 即可生成并验证发行包；产物在 `.release-artifacts/`。多网卡机器应通过 `interfaceAddress` 明确选择客户端 IPv4 地址。

Windows、macOS（Intel / Apple Silicon）、Linux（x64 / ARM64）使用同一份安装包，安装与 CPU 匹配的 Node.js 22+ 即可。macOS 校验使用 `shasum -a 256 -c SHA256SUMS`。使用 `listIPv4Interfaces()` 列出网卡，再把其 IPv4 地址传给 `interfaceAddress`；不要填写 `en0`、`eth0` 等网卡名称。默认选择首个非回环 IPv4 的行为保持不变，但多网卡、VPN、虚拟网卡环境应明确选择。运行时会检查地址仍属于本机。

从公司回家等移动场景可显式开启 `interfaceMode: 'auto'` 和 `waitForNetwork: true`：旧 IPv4 不再锁定发现，新网络接通后重新选择物理 LAN 网卡、清除旧候选并开始发现。可选 `preferredInterfaceName` 按设备名跟随 Wi-Fi 的 DHCP 地址变化。旧的固定地址模式保持兼容；自动发现不等于自动授权或恢复推理会话。当前地址和网络状态可从 `attachment` 及 `network` 事件读取。相同 IPv4 的网络变化使用网关身份作尽力检测，不能替代完整 OS 网络切换通知；更强的宿主通知可通过 resolver 注入。

CI 已配置五种系统/架构及 Node.js 22/24 代表组合，具体通过情况以 Actions 记录为准。单元测试和打包安装不等于真实组播通过；Bonjour/Avahi 共存、真实局域网跨机发现的验收状态见 Demo 报告。目前限 IPv4 mDNS，不承诺 IPv6或跨子网发现，不自动调整防火墙、系统 mDNS 或网络权限。

公告功能位于单独的 advertiser 模块；HTTPS 信任、认证和推理由客户端实现。发现记录只是未受信任的服务线索，不能直接当作授权。真实网络互通验收保存在独立 Demo 仓库。

每个服务可配置 `auth: 'required'`（默认）或 `auth: 'none'`；同一主机的不同路径可使用不同设置。这里只公告认证要求，不传播 API key。草案通用 TXT 字段支持这两个值，但 -00 的 Open Responses binding 要求 `required`，因此免 key 的 Open Responses 是本项目的实验扩展，候选会包含 `draftAuthCompatible: false` 和诊断 warning；仍需独立的连接授权与 TLS 验证。

MIT License. See [LICENSE](LICENSE).
