---
name: blender-cgi-mastery
description: Sovereign Blender 3D AGI Engineering Engine & Procedural CGI Master Skill. Guides Causyne Agent on generating magazine-quality 3D models, procedural Geometry Nodes, PBR shaders, sloped architectural masonry, and auto-framed studio/cinematic renders using blender.act v1.1.58.
---

# Sovereign Blender 3D CGI Mastery (`blender.act v1.1.58`)

This skill provides expert guidance for Causyne Agent when generating 3D models, procedural scenes, Geometry Nodes, materials, and renders in Blender 3D (`Blender 3.x / 4.x / 5.2 LTS`).

---

## 🛑 The Core Problem: Why Raw LLM 3D Scripts Look Basic & Flat ("THE BOX MID HAIIYA")

When an LLM writes `bpy` Python code from scratch without high-level CGI engineering principles, the results often look like flat primitive boxes:
1. **Geometric Primitive Stacking vs. Sloped Architecture**: When you loop `primitive_cube_add` with decreasing scale, you get a simple stepped wedding cake of boxes. Real Aztec/Mayan pyramids (Chichen Itza / Teotihuacan) have **sloped talud-tablero walls ($72^\circ - 76^\circ$ trapezoidal frustums)**, 4 sweeping staircases with angled stone balustrades, and temple sanctuaries with columns.
2. **No Bevels or Edge Catching**: Raw primitives (`primitive_cube_add`) have infinitely sharp CAD edges (`0.0°`). In the real world, light catches slightly rounded edges. Without Bevels, rendering engines produce flat planes with zero specular highlights.
3. **Flat RGB Color Materials vs. Masonry Displacement**: Setting `bsdf.inputs['Base Color'].default_value = (0.8, 0.7, 0.5, 1.0)` produces a dull plastic look. Commercial 3D assets require **Procedural PBR Node Trees** (`Brick Texture`, `Noise/Voronoi`, and real `ShaderNodeDisplacement`).
4. **Macro/Skewed Camera Framing & Black Void**: A camera floating in pitch black (`#000000`) with a macro wide-angle (`35mm`) lens distorts scale. Epic monuments require **Cinematic Atmospheric Lighting (`MULTIPLE_SCATTERING` sky + volumetric haze)** and **50mm-65mm portrait/landscape focal lengths**.

---

## ⚡ The Solution: Extreme Sovereign CGI Mastery Architecture (`v1.1.57`)

To guarantee commercial, photorealistic output (`Sovereign Blender AGI Engine v1.1.57`), ALWAYS invoke these specialized actions in `blender.act` when creating or polishing 3D assets:

### 1. `smartGeometry` (Studio Bevel & Polygon Smoothing)
Automatically smooths polygons and injects non-destructive `BEVEL` and `SUBSURF` modifiers on all target meshes:
```json
{
  "type": "smartGeometry",
  "bevel_width": 0.015,
  "subsurf": true
}
```

### 2. `smartMaterial` (Procedural PBR Shader Generator)
Instantly constructs a multi-node `Principled BSDF` network with built-in procedural micro-roughness and bump details. Available presets:
- `gold_brushed` / `aztec_gold` (Metallic 1.0, Roughness 0.18, subtle noise bump for high-end gold artifacts)
- `sandstone` / `pyramid_stone` (Roughness 0.85, dual-scale procedural noise displacement for architectural masonry)
- `velvet` / `watch_cushion` (Dark luxury fabric sheen for display pedestals)
- `chrome` / `watch_case` (Polished steel/chrome reflection)
- `sapphire` / `glass` (IOR 1.76 high transmission watch crystal/lenses)
- `custom` (Accepts custom `metallic`, `roughness`, and `bump_strength`)

### 3. `cinematicAtmosphere` (Nishita/Multi-Scattering Sky & Volumetric Fog)
Creates a breathtaking procedural `MULTIPLE_SCATTERING` / `NISHITA` sky with golden hour or dramatic sun angles, plus optional volumetric haze box bounding the scene (`ShaderNodeVolumeScatter`):
```json
{
  "type": "cinematicAtmosphere",
  "sun_elevation": 24.0,
  "volumetric_fog": true,
  "fog_density": 0.015
}
```

### 4. `smartGeoNodes` (Procedural Geometry Nodes Generators)
Attaches powerful procedural Geometry Nodes setups (`masonry_brick_wall`, `procedural_staircase`, `sci_fi_panels`, `scatter_debris`) directly onto target meshes:
```json
{
  "type": "smartGeoNodes",
  "generator": "masonry_brick_wall",
  "subdivisions": 3
}
```

### 5. `autoFrameCamera` (Subject-Only Tracking & 50mm-65mm Studio/Landscape Lens)
Automatically filters out floor/cove/backdrop planes, calculates the true bounding sphere of the subject, sets a professional `50.0mm-65.0mm` telephoto lens, and attaches a `DAMPED_TRACK` constraint targeting the exact subject center:
```json
{
  "type": "autoFrameCamera",
  "focal_length": 50.0
}
```

---

## 📐 Procedural Blueprint Reference: Extreme Aztec Pyramid (`cgi_master_library.py`)

For complex architectural masterworks like **Aztec Pyramid v4**, Causyne Agent provides `scripts/cgi_master_library.py` which constructs sloped `talud-tablero` tiers, 4 sweeping staircases, corner temple columns, and a golden sacrificial altar:

```python
import scripts.cgi_master_library as lib

# Retrieve extreme procedural script
py_code = lib.get_aztec_pyramid_script()
# Or luxury watch studio:
watch_code = lib.get_watch_studio_script()
```

By combining clean procedural `bmesh` tapered geometry generation with `smartGeometry`, `smartMaterial`, `cinematicAtmosphere`, `smartGeoNodes`, and `autoFrameCamera (50mm/65mm)`, Causyne Agent guarantees magazine-quality 3D assets and renders (`v1.1.58`).

---

## 🛑 Host Sandbox Workspace Boundary Rules (`fs_read: /tmp/`) & 4K Cycles Protocol

1. **Workspace Boundary Prevention (`fs_read vs /tmp/`)**:
   - Host IDEs and agent sandboxes restrict native file inspection tools (`fs_read`, `view_file`, `read_file`) strictly to the active project workspace.
   - **DO NOT write intermediate logs or target outputs to `/tmp/` (`e.g., /tmp/ps_output.txt` or `/tmp/video.mp4`) if you plan to inspect them with `fs_read` or `view_file`!** Doing so will trigger `Path outside allowed workspace: /tmp/...`.
   - Always specify target file paths (`filepath`) inside the workspace buffer (`.tmp_causyne_3d/`) or another path explicitly approved by the user. By default, `blender.act` uses `getWorkspaceTempDir()` so previews and captures remain inside the workspace boundary.

2. **4K Cycles Render Timeouts & Fast Preview Rule**:
   - Running a synchronous `CYCLES` render at 4K resolution (`3840x2160`) with `256 samples` inside `blender.act` takes 5 to 15 minutes, which will exceed default tool socket timeouts (`300,000 ms`) or hang Blender's main thread (`Layer 1`).
   - **Sovereign Solution**: For fast iteration and autonomous visual verification (`Layer 2 /capture`), always use `BLENDER_EEVEE_NEXT` (`or CYCLES with samples=32..64 at 1920x1080`) so rendering completes in under 2 seconds. When full production 4K Cycles multi-frame animations are required, offload execution to a background terminal command (`blender --background ...`) and check progress asynchronously (`manage_task` status) without blocking the active agent loop.
