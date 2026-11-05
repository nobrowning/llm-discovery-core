# LLM API 发现核心库

[English](README.md) · [项目网站](https://nobrowning.github.io/llm-service-discovery-demo/?lang=zh) · [完整说明（英文）](https://github.com/nobrowning/llm-discovery-core/blob/main/docs/guide.md)

一个 Node.js 库，用来发现局域网中的 LLM API 服务，并让列表保持最新。用它可以给 AI 应用加一个“附近的 LLM 服务”列表，就像笔记本上的 Wi-Fi 列表。

## 为什么需要

编程 agent、聊天应用、IDE 助手这类 AI 应用本来就通过 API 调用模型，所以换 server 很容易。它们缺的是一种方法，看到当前所在网络里有哪些 server。结果用户只能把 IP、端口和路径手动填进设置；server 一换地址，或者笔记本换了网络，又得重新填。

使用 [llm-api-advertiser](https://github.com/nobrowning/llm-api-advertiser) 的服务会通过 mDNS/DNS-SD，以 `_llm-api._tcp` 服务类型公告自己。本库接收这些公告，把记录变成校验过的列表，供你的应用展示。

## 它做什么

- 浏览 `_llm-api._tcp.local`，为每个服务生成一个候选，并给出可直接使用的 base URL，例如 `https://studio-llm.local:8443/v1`。
- 校验每条记录：TXT 版本、API profile、base 路径、认证提示、主机名、端口和地址。无效记录会被报告，但不会成为可接入的候选。
- 服务新增、更新、撤销或过期时，列表随之更新。
- 跟随网络（预发布版本 `0.4.0-roaming.1`）。设置 `interfaceMode: 'auto'` 后，设备换到另一个局域网时会在新网络上重新发现。设置 `waitForNetwork: true` 后，没有网络时安静等待，而不是报错。

它不连接 API、不判断信任、不发送凭据。发现记录只是不可信的线索；你的应用在发送 key 之前，应检查 TLS 和自己的信任策略。

## 快速开始

需要 Node.js 22 或更新版本。从 [Releases](https://github.com/nobrowning/llm-discovery-core/releases) 下载 `.tgz` 和 `SHA256SUMS`：

- `0.3.2` 是最新正式版。
- `0.4.0-roaming.1` 是预发布版本，增加了跟随网络和 `network` 事件；[Demo 仓库的 `vendor/` 目录](https://github.com/nobrowning/llm-service-discovery-demo/tree/main/vendor)中也有这个包。

```sh
npm install ./llm-discovery-discovery-core-0.4.0-roaming.1.tgz
```

```js
import { createDiscoveryClient } from '@llm-discovery/discovery-core';

const client = createDiscoveryClient({
  interfaceMode: 'auto',   // 跟随当前局域网
  waitForNetwork: true,    // 离线时安静等待
});
client.subscribe(event => {
  if (event.type === 'added' || event.type === 'updated') {
    console.log(event.candidate.displayName, event.candidate.baseURL);
  }
  if (event.type === 'removed') console.log('已移除：', event.candidate.displayName);
});
await client.start();
// 之后：await client.stop();
```

`client.snapshot()` 返回当前列表。事件类型有 `added`、`updated`、`invalid`、`removed`、`network`、`status` 和 `warning`。

使用 `0.3.2` 正式版时，请用 `interfaceAddress: '192.168.1.20'`（本机局域网 IPv4 地址）代替 `interfaceMode`；不指定地址时使用第一个可用的 IPv4 网卡。`0.3.2` 没有 `network` 事件。

## 更多

- [完整说明（英文）](https://github.com/nobrowning/llm-discovery-core/blob/main/docs/guide.md)：选择网卡、等待网络、如何识别网络变化、协议辅助函数、认证提示、平台支持。文末附有中文摘要。
- [技术细节](https://nobrowning.github.io/llm-service-discovery-demo/technical.html?lang=zh)：记录、TXT 字段、校验规则和发现流程。

## 项目状态

IETF 互联网草案 [draft-cui-dawn-local-llm-api-discovery-00](https://datatracker.ietf.org/doc/draft-cui-dawn-local-llm-api-discovery/) 的实验性实现。一次在一张网卡上使用 IPv4 组播，服务须在同一局域网内。不修改防火墙、路由或系统 DNS 设置。

## 所属项目：局域网 LLM API 发现

| 仓库 | 作用 |
|---|---|
| [llm-api-advertiser](https://github.com/nobrowning/llm-api-advertiser) | 在局域网中公告 LLM API，运行在服务端旁边。 |
| **llm-discovery-core**（本仓库） | 发现并校验公告的服务，供客户端应用使用的库。 |
| [dsh-lan-discovery](https://github.com/nobrowning/dsh-lan-discovery) | 在 DeepSeek Harness 中列出局域网服务，并接入你选择的那个。 |
| [llm-service-discovery-demo](https://github.com/nobrowning/llm-service-discovery-demo) | 使用模拟 API 的可运行 Demo，以及项目网站。 |

## 开发

```sh
npm ci --ignore-scripts
npm test
npm pack
```

## 许可

MIT，见 [LICENSE](LICENSE)。
