# Platform validation: discovery-core 0.3.1

Component validation completed on 2026-11-03. This record covers package installation, public exports, interface selection, and deterministic protocol behavior. It does **not** establish real LAN discovery, Bonjour/Avahi coexistence, or Harness desktop acceptance.

| Environment | Runtime | Source checked | Result |
|---|---|---|---|
| Physical Mac, ARM64; Darwin kernel `27.2.0` | Node.js `v24.22.2` | `0d9772ee8301466c4c49ac9e2737104fc0072e71` | 14 tests passed; final archive installed and imported |
| Ubuntu WSL2, Linux x64; kernel `6.18.40.1-microsoft-standard-WSL2` | Node.js `v24.22.2` | Same commit | 14 tests passed; final archive installed and imported |
| Windows x64 development environment | Node.js `v24.21.0` | Same commit | 14 tests passed; clean-LF-checkout archive installed and imported |

Each Mac/Linux run completed `npm ci --ignore-scripts`, `npm test`, and `npm run release:prepare`. The release check reviewed the package allowlist, checked repeated archive bytes, installed the tarball in a temporary project, and exercised the public discovery/interface helpers without opening multicast sockets. The SDK's registry dependencies are not bundled; normal npm registry/cache access was permitted for installation.

The Mac, Linux, and Windows builds all produced:

```text
826340d0629cd8e45319198a44ef1c4a81e1b8bf3742b5920cbb9e4b1438161c  llm-discovery-discovery-core-0.3.1.tgz
```

The [CI run for the implementation commit](https://github.com/nobrowning/llm-discovery-core/actions/runs/41654542087) also completed successfully across all six configured jobs: Linux x64 with Node.js 22 and 24, and Linux ARM64, Windows x64, macOS ARM64, and macOS Intel with Node.js 24. Each job checked the actual runtime architecture and installed the final archive. These runners provide additional component coverage; their socket-free checks are not evidence of real multicast connectivity.

Actual cross-machine discovery and mDNS coexistence results are maintained separately in the [Demo validation report](https://github.com/nobrowning/llm-service-discovery-demo/blob/main/docs/validation-report.md). This evidence-only document is outside the npm `files` allowlist and does not change the 0.3.1 archive bytes.
