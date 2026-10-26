# Security

Causyne Agent is under active development and has not reached a stable security
baseline. Development builds may execute tools that interact with files,
processes, applications, and external model providers. Review requested actions
and use an isolated workspace when evaluating the project.

## Protecting credentials

- Keep API keys and provider credentials outside the repository.
- Do not commit `.env` files, private keys, authentication tokens, personal
  configuration, or generated state.
- Use test credentials with minimal permissions during development.
- Revoke and rotate any credential that is accidentally disclosed.

The release checks scan for common credential formats, but automated scanning
cannot prove that a repository contains no secrets.

## Reporting a vulnerability

Please avoid publishing exploit details in a public issue. Report any security concern or vulnerability directly to security@causyne.com so it can be investigated and resolved promptly.
