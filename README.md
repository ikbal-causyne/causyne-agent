# Causyne Agent

> **Development status:** Causyne Agent is under active development. It is not
> yet a stable release, and its interfaces and behavior may change.

Causyne Agent is an AI agent harness for complex, multi-step work. It is being
developed to turn intention into meaningful progress through capable,
increasingly autonomous AI, with clear boundaries and human control.

This repository is an early source-available development snapshot. Public
documentation is intentionally concise while the project is evolving.

Learn more at [causyne.com](https://causyne.com/).

## Installation

This build is provided specifically for debugging, testing, and architectural evaluation. If you are exploring or debugging the harness, you can install it using the automated script or directly through npm.

For macOS, Linux, or WSL:

```sh
curl -fsSL https://causyne.com/install.sh | bash
```

For Windows PowerShell:

```powershell
irm https://causyne.com/install.ps1 | iex
```

Alternatively, you can install the global package via npm:

```sh
npm install -g @causyne/agent
```

Please treat this release as an experimental preview built for debugging and hands-on testing rather than day-to-day production workloads. As the developer behind Causyne, I would be genuinely grateful for your feedback, edge-case findings, and diagnostic reports. If you run into unexpected behavior or have thoughts on how the runtime behaves, please open an issue on GitHub or reach out directly to help@causyne.com.

## Contact

For general inquiries and business communication, reach out to contact@causyne.com. For technical questions, bug reports, and diagnostic feedback, email help@causyne.com. For security disclosures and vulnerability reports, email security@causyne.com. For partnerships and direct collaboration, write to ikbal@causyne.com.

## Development

Node.js 24 or newer is required.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck:strict
npm run check:public
```

Please read [SECURITY.md](SECURITY.md) before running development builds or
reporting a security concern. Never commit API keys, credentials, private
configuration, or personal data.

The source is available under the [Business Source License 1.1](LICENSE).
Causyne Agent is source-available software and is not presented as OSI-approved
open-source software.
