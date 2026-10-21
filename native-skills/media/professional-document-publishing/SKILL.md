---
name: professional-document-publishing
description: Generate publication-grade PDF documents, grant proposals, financial sheets, and technical reports using HTML/CSS Paged Media and Headless Chrome. Enforces visual quality inspection, under 2MB compliance, and mathematical integrity.
---

# Professional Document Publishing & Harness

Frontier LLMs and efficient models produce equally stunning, publication-ready documents when guided by this harness methodology.

Never assemble print layouts through raw Python scripts. Always author in semantic HTML5 plus CSS Paged Media, compile via Headless Chrome, and visually inspect the rendered output.

## Workflow

1. Prepare structured data and schemas.
   - Keep numeric budget and scheduling data in structured JSON format.
   - Run math validation with `document_forge` (`action: "audit_budget"`).
   - **Done when:** all numbers are validated against the single source of truth.

2. Compile document markup and styles.
   - Author page layouts in HTML using standard CSS `@page` rules (`size: A4 portrait; margin: 20mm 18mm 18mm 18mm;`).
   - Use `@page cover { margin: 0; }` for full-bleed cover banners without white borders.
   - Force `-webkit-print-color-adjust: exact; print-color-adjust: exact;` so backgrounds and gradients render faithfully.
   - Prevent mid-table row cuts with `tr { page-break-inside: avoid; }`.
   - Prevent orphan headers with `h1, h2, h3 { page-break-after: avoid; }`.
   - Compile via `document_forge` (`action: "compile_document"`).
   - **Done when:** HTML markup and CSS paged styles are written to disk.

3. Render to vector PDF via Headless Chrome.
   - Invoke `document_forge` (`action: "render_pdf"`, `sourceHtmlPath`, `outputPdfPath`).
   - **Done when:** vector PDF file exists on disk with non-zero size.

4. Inspect pages visually and audit compliance.
   - Extract page images via `document_forge` (`action: "inspect_pages"`).
   - Verify page fill density: flag and repair any pages with less than 25% text coverage.
   - Confirm PDF file size is below 2,048 KB for portal compliance.
   - Audit text content for long em-dashes and AI clichés with `document_forge` (`action: "audit_text"`).
   - **Done when:** all pages pass visual density check and size constraints.

## Verification

- `document_forge` returns `success: true`.
- Output PDF file size is non-zero and under 2,048 KB.
- Extracted page images show no clipped text or orphaned headers.
- Mathematical totals match across all sections.
