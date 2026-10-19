---
name: bundle-size-reduction
description: Reduce JavaScript or CSS bundle size. Use when a build warns about chunk size, when a page ships more than a few hundred kilobytes of script, or when load time is dominated by download and parse.
---

# Bundle Size Reduction

## Workflow

1. Look at the bundle before guessing.
   - `rollup-plugin-visualizer`, `webpack-bundle-analyzer`, or `vite build --mode production` with a visualiser. One dependency is usually most of the weight.
   - **Done when:** you can name the three largest contributors and their sizes.

2. Attack the largest one first.
   - Common offenders and their fixes:
     - A date library — use `Intl.DateTimeFormat` or a modular alternative.
     - A full icon set — import individual icons, never the barrel file.
     - `lodash` — import the single function path, or use the platform equivalent.
     - A charting or editor library — load it dynamically at the point of use.
   - **Done when:** the largest contributor has dropped measurably or is justified in writing.

3. Split by route.
   - Dynamic `import()` at route boundaries. The landing page should not carry the admin dashboard's code.
   - **Done when:** navigating between routes loads separate chunks.

4. Check tree-shaking is actually working.
   - It requires ES modules, `"sideEffects": false` in the dependency's manifest, and no barrel file re-exporting everything. A single CommonJS dependency in the chain can defeat it silently.
   - **Done when:** an unused export from a first-party module is absent from the output.

5. Do not forget CSS and fonts.
   - Unused CSS from a utility framework needs the purge step configured against every template path. Subset fonts to the characters actually used.
   - **Done when:** the CSS bundle contains no selector the app cannot produce.

## Verification

- Report the before and after transferred size for the entry chunk.
- The largest chunk is below the project's stated budget.
- The app still works: run the test suite and load every route.
