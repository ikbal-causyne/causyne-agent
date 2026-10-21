# Third-party software review

Review date: 2026-10-21.

Causyne Agent's npm package declares third-party packages as dependencies; it
does not bundle their source into the project tarball. Each dependency remains
under its own license. The locked graph reviewed on this date contained these
license identifiers:

| License expression | Lockfile package entries |
| --- | ---: |
| Apache-2.0 | 25 |
| MIT | 20 |
| ISC | 2 |

The lockfile contained 47 dependency entries in total. Development and
platform-specific optional entries account for most of the graph.

The direct runtime dependencies are `@modelcontextprotocol/client`,
`acorn-walk`, and `commander`. Direct development dependencies are
`@babel/parser`, `@modelcontextprotocol/node`, `@modelcontextprotocol/server`,
`@types/node`, `acorn`, `typescript`, and `zod`. The three direct MCP packages
are licensed under Apache-2.0. Exact versions, transitive dependencies, license
identifiers, and integrity hashes are recorded in `package-lock.json`.

No dependency in the reviewed main lockfile was marked with an install script.
Optional capability dependencies are installed only after approval into a
separate local environment and are not covered by the main lockfile review.

The product-facing browser capability is **Causyne Browser**. Upstream names
below are used only for required attribution and exact dependency identifiers.

The optional browser capability installs `camoufox-js` 0.11.5 under MPL-2.0
and `playwright-core` 1.58.0 under Apache-2.0. They remain separate packages in
the user's local capability directory and are not copied into Causyne Agent's
npm tarball. Causyne does not download or bundle the Camoufox browser runtime.

The snapshot windowing and external executable bridge in `src/browser/` are
adapted from the MIT-licensed Camofox Browser project at source commit
`2c0036a8b18bf9cd983376751ff4d52dfd9add0f`. Its required notice is:

> MIT License
>
> Copyright (c) 2025 Jo, Inc
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The computer-use action parser and coordinate grounding engine in `src/computerUse/visionGrounding.ts`
and `src/tools/computerUse.ts` power **Causyne Vision Desktop** (`computer_use`). Algorithms for coordinate
grounding and action grammar contain adaptations from upstream open-source work:

> Copyright (c) 2025 Bytedance, Inc. and its affiliates.
> Licensed under the Apache License, Version 2.0 (the "License");
> you may not use this file except in compliance with the License.
> You may obtain a copy of the License at
>
>     http://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing, software
> distributed under the License is distributed on an "AS IS" BASIS,
> WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
> See the License for the specific language governing permissions and
> limitations under the License.

The generative UI component and preview engine in `src/uiEngine/uiForge.ts` and
`src/tools/uiForge.ts` power **Causyne UI Forge** (`ui_forge`). Code generation algorithms
contain adaptations from upstream open-source work:

> MIT License
>
> Copyright (c) 2011-2024 Thesys Inc.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.


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
