# Third-party software review

Review date: 2026-10-19.

Causyne Agent's npm package declares third-party packages as dependencies; it
does not bundle their source into the project tarball. Each dependency remains
under its own license. The locked graph reviewed on this date contained these
license identifiers:

| License expression | Lockfile package entries |
| --- | ---: |
| Apache-2.0 | 21 |
| MIT | 9 |

The lockfile contained 30 dependency entries in total. Three are production
entries; development and platform-specific optional entries account for the
rest. npm's audit metadata reported 12 installed packages.

The direct runtime dependencies are `acorn-walk` and `commander`. Direct
development dependencies are `@babel/parser`, `@types/node`, `acorn`, and
`typescript`. Exact versions and integrity hashes are recorded in
`package-lock.json`.

No dependency in the reviewed main lockfile was marked with an install script.
Optional capability dependencies are installed only after approval into a
separate local environment and are not covered by the main lockfile review.

Repository scanning found no third-party copyright header or license marker in
the project-authored source and skill files. That negative scan alone cannot
establish authorship or permission. On 2026-10-19, the licensor confirmed that
the project-authored source, native skills, tests, and assets are original work
or can lawfully be distributed under the stated terms.

BUSL-1.1 applies only to Causyne-owned material. It does not replace or narrow
the licenses of third-party dependencies.

The terms section of `LICENSE` was normalized and compared with the SPDX
BUSL-1.1 canonical text during this review; it matched. The project-specific
parameter block selects the named licensor, Causyne Agent 1.10.1 as the licensed
work, 2030-08-09 as the change date, and Apache-2.0 as the change
license. The Additional Use Grant permits production use except a paid
competing commercial offering as defined in that block. These business terms
should receive legal review before publication if enforcement is material.
