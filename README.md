# Mason

A desktop chat app built with Electron that connects to the Databricks AI Gateway. Talk to multiple LLMs through a unified interface with MCP tool calling, local filesystem access, auto-discovered models, and streaming responses.

## Installation

### macOS (Apple Silicon) — one-line install

```bash
curl -fsSL https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.sh | bash
```

This downloads the latest signed/notarized DMG from GitHub Releases, mounts it, copies `Mason.app` to `/Applications`, and unmounts. Pin to a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.sh | bash -s v1.0.0
```

### macOS — manual install

Download `Mason-*-arm64.dmg` from [the latest release](https://github.com/databricks-solutions/mason/releases/latest), open it, and drag Mason to Applications.

### Other platforms

Windows and Linux builds are not yet published. The `electron-builder` config supports them — building from source on those platforms (`npm ci && npm run build:win` / `npm run build:linux`) will produce installers.

## How to get help

Databricks support doesn't cover this content. For questions or bugs, please open a [GitHub issue](https://github.com/databricks-solutions/mason/issues) and the team will help on a best effort basis.

## License

&copy; 2026 Databricks, Inc. All rights reserved. The source in this repository is provided subject to the Databricks License [https://databricks.com/db-license-source]. All included or referenced third party libraries are subject to the licenses set forth below.
