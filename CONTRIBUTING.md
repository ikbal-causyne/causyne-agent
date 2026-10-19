# Contributing

Causyne Agent is under active development. Before opening a change, discuss
large behavioral or architectural changes in an issue so the implementation
can stay within the project's current direction.

Use Node.js 24 or newer, install the locked dependency graph without lifecycle
scripts, and run the local release checks:

```sh
npm ci --ignore-scripts
npm run check:public
npm test
npm run typecheck:strict
```

Do not commit credentials, personal data, local state, generated archives, or
private operating documents. Security reports belong in GitHub's private
vulnerability-reporting channel rather than a public issue.

By submitting a contribution, you confirm that you have the right to provide
it under the repository's current license. Causyne Agent is source-available
under BUSL-1.1; it is not presented as OSI-approved open-source software.
