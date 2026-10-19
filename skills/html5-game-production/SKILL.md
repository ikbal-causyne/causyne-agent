---
name: html5-game-production
description: Sovereign HTML5 Game Development Mastery. Use when creating instant browser-playable 3D WebGL (Three.js) or 2D Canvas games with mobile touch joysticks, WASD controls, and zero-dependency offline execution.
---

# Sovereign HTML5 Game Production Mastery (`game.build_html5`)

This skill defines the architectural rules and best practices for creating instant, browser-playable **HTML5 Games** using Causyne's `game.build_html5` tool.

## 1. Zero-Dependency Offline Execution (`Edge Ready`)
- Every generated game MUST be fully functional when opened as a local file (`file:///.../game.html`) without requiring a running backend node server.
- Use Three.js via CDN (`https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`) or inline Canvas 2D primitives.
- All game logic, touch controllers, particle systems, and CSS styling MUST be embedded directly inside the single HTML file or written cleanly to the target directory (`.tmp_causyne_3d`).

## 2. Universal Mobile & Desktop Controls
- **Desktop**: Support WASD (`ArrowKeys`) + `Spacebar` for firing/jumping.
- **Mobile**: Always generate a touch-compatible overlay (`#mobile-controls`) containing an interactive virtual joystick (`#joystick` with math-based angle tracking) and dedicated action/fire buttons (`#fire-btn`). Prevent default touch scrolling with `user-select: none; touch-action: none; overflow: hidden;`.

## 3. High-Performance Visual Aesthetics (`Designed to Wow`)
- **3D WebGL (Three.js)**: Use volumetric fog (`THREE.FogExp2`), bloom-compatible high-contrast color palettes (`#00ffcc` cyan, `#ff3366` crimson, `#080a12` deep space), directional shadow maps, and dynamic particle explosion debris.
- **2D Arcade (Canvas 2D)**: Use layered glowing neon drop shadows (`ctx.shadowColor`, `ctx.shadowBlur = 15`), crisp geometric primitives, and sub-pixel velocity physics (`gravity`, friction damping, and bounding box collisions).

## 4. Benchmark Templates (`game.build_html5`)
- `template: "space_defense_3d"`: 3D Cyberpunk Jet with grid tunnel flying, laser projectiles, dodecahedron enemies, and particle explosions.
- `template: "arcade_platformer_2d"`: 2D Neon Cyberpunk Platformer with gravity jumping, coin collection, and multi-level platforms.
