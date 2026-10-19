---
name: colour-system-construction
description: Build a colour palette for an interface. Use when colours were chosen individually, when a dark mode is being added, or when contrast is failing.
---

# Colour System Construction

## Build roles, not colours

A palette is a set of ROLES — background, surface, border, muted text, body text, accent, and the status colours. Components ask for a role. This is the only way a theme can be swapped, a dark mode can be added, or a brand colour can be changed without editing every file.

## Workflow

1. Start from the neutrals.
   - Most of an interface is grey. Build a ramp of seven to nine steps from near-background to near-foreground, then assign roles to steps. Getting the neutrals right is most of the work, and it is the step most often skipped.
   - **Done when:** a neutral ramp exists and every structural element uses a step from it.

2. Add one accent, then stop.
   - A single accent used consistently reads as intentional. Three accents read as decoration. Add a second only when a genuine second meaning exists.
   - **Done when:** the number of accents equals the number of distinct meanings.

3. Check contrast as you assign, not afterwards.
   - Body text against its background: at least 4.5:1. Large text and UI borders: at least 3:1. A palette that fails here needs rebuilding, not adjusting.
   - **Done when:** every text-on-background pair in the design meets its ratio.

4. Never encode meaning in hue alone.
   - Error, success and warning must also differ by icon, text, or position. Roughly one in twelve men cannot distinguish red from green.
   - **Done when:** every status is identifiable in greyscale.

5. Define the dark theme by redefining ROLES.
   - Not by inverting the values. Dark mode wants desaturated accents and lighter surfaces raised above the background, which an inversion gets backwards.
   - **Done when:** both themes are defined as role assignments and neither is derived by inversion.

## Verification

- Every colour used is a named role, not a literal value.
- Contrast checks pass for every text pair in both themes.
- The interface remains usable rendered in greyscale.
