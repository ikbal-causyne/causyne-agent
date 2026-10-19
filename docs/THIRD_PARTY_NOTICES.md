# Third-party software review

Review date: 2026-10-19.

Causyne Agent's npm package declares third-party packages as dependencies; it
does not bundle their source into the project tarball. Each dependency remains
under its own license. The locked graph reviewed on this date contained these
license identifiers:

| License expression | Lockfile package entries |
| --- | ---: |
| MIT | 87 |
| Apache-2.0 | 22 |
| BSD-2-Clause | 8 |
| ISC | 5 |
| BSD-3-Clause | 1 |
| BlueOak-1.0.0 | 1 |
| 0BSD | 1 |
| MIT OR CC0-1.0 | 1 |

The lockfile contained 126 dependency entries in total. npm's audit metadata
reported 106 production dependencies; platform-specific optional entries and
development dependencies account for the differing views of the graph.

The direct runtime dependencies are `@babel/parser`, `acorn-walk`, `commander`,
`duck-duck-scrape`, `googlethis`, and `inquirer`. Direct
development dependencies are `@types/node`, `acorn`, and `typescript`. Exact
versions and integrity hashes are recorded in `package-lock.json`.

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
parameter block selects the named licensor, Causyne Agent 1.10.0 as the licensed
work, 2030-08-09 as the change date, and Apache-2.0 as the change
license. The Additional Use Grant permits production use except a paid
competing commercial offering as defined in that block. These business terms
should receive legal review before publication if enforcement is material.
