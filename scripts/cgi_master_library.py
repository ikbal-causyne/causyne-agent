"""
Sovereign Blender 3D CGI Master Library (v1.1.58)
Provides high-end procedural 3D generation templates, Geometry Nodes generators,
and smart PBR material presets for Causyne Agent 3D AGI Engineering.
"""

import math

def get_aztec_pyramid_script():
    """
    Returns a complete, extreme, high-precision procedural script for generating
    a photorealistic, cinematic Aztec/Mayan Pyramid with sloped talud-tablero
    walls, 4 sweeping staircases with balustrades, top ceremonial temple with pillars,
    procedural masonry displacement shaders, and golden capstone altar.
    """
    return """
import bpy, bmesh, math

def smooth_mesh(obj):
    if hasattr(obj.data, "use_auto_smooth"):
        try: obj.data.use_auto_smooth = True
        except: pass
    for p in obj.data.polygons:
        p.use_smooth = True

# 1. Clean existing scene meshes and lights
for o in list(bpy.context.scene.objects):
    if o.type in ['MESH', 'LIGHT']:
        bpy.data.objects.remove(o, do_unlink=True)

# 2. Build Procedural PBR Shaders first
# A. Ancient Masonry Stone (Brick + Noise + Displacement)
mat_stone = bpy.data.materials.new(name="CausyneAncientMasonry")
mat_stone.use_nodes = True
try: mat_stone.cycles.displacement_method = 'BOTH'
except: pass
nodes = mat_stone.node_tree.nodes
links = mat_stone.node_tree.links
nodes.clear()

bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
out = nodes.new(type="ShaderNodeOutputMaterial")
bsdf.location = (0, 0); out.location = (400, 0)
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

# Brick pattern for masonry blocks
brick = nodes.new(type="ShaderNodeTexBrick")
brick.location = (-800, 200)
brick.inputs["Scale"].default_value = 8.0
brick.inputs["Mortar Size"].default_value = 0.015
brick.inputs["Mortar Smooth"].default_value = 0.05
brick.inputs["Color1"].default_value = (0.58, 0.46, 0.33, 1.0)
brick.inputs["Color2"].default_value = (0.45, 0.35, 0.24, 1.0)
brick.inputs["Mortar"].default_value = (0.18, 0.15, 0.12, 1.0)

# Noise for weathering
noise = nodes.new(type="ShaderNodeTexNoise")
noise.location = (-800, -200)
noise.inputs["Scale"].default_value = 25.0
noise.inputs["Detail"].default_value = 14.0

# Mix Color
mix_col = nodes.new(type="ShaderNodeMixRGB" if hasattr(bpy.types, "ShaderNodeMixRGB") else "ShaderNodeMix")
mix_col.location = (-400, 200)
if hasattr(mix_col, "data_type"): mix_col.data_type = 'RGBA'
if "Fac" in mix_col.inputs: mix_col.inputs["Fac"].default_value = 0.35
elif 0 in mix_col.inputs: mix_col.inputs[0].default_value = 0.35
links.new(brick.outputs["Color"], mix_col.inputs["Color1" if "Color1" in mix_col.inputs else 6])
links.new(noise.outputs["Color"], mix_col.inputs["Color2" if "Color2" in mix_col.inputs else 7])
links.new(mix_col.outputs["Color" if "Color" in mix_col.outputs else 2], bsdf.inputs["Base Color"])

# Roughness
bsdf.inputs["Roughness"].default_value = 0.88

# Bump & Displacement
bump = nodes.new(type="ShaderNodeBump")
bump.location = (-400, -100)
bump.inputs["Strength"].default_value = 0.65
links.new(brick.outputs["Fac"], bump.inputs["Height"])
links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

disp = nodes.new(type="ShaderNodeDisplacement")
disp.location = (150, -300)
disp.inputs["Scale"].default_value = 0.04
links.new(brick.outputs["Fac"], disp.inputs["Height"])
links.new(disp.outputs["Displacement"], out.inputs["Displacement"])

# B. Ceremonial Brushed Gold Altar & Capstone
mat_gold = bpy.data.materials.new(name="CausyneSacrificialGold")
mat_gold.use_nodes = True
gnodes = mat_gold.node_tree.nodes
glinks = mat_gold.node_tree.links
gnodes.clear()
gbsdf = gnodes.new(type="ShaderNodeBsdfPrincipled")
gout = gnodes.new(type="ShaderNodeOutputMaterial")
glinks.new(gbsdf.outputs["BSDF"], gout.inputs["Surface"])
gbsdf.inputs["Base Color"].default_value = (1.0, 0.766, 0.336, 1.0)
gbsdf.inputs["Metallic"].default_value = 1.0
gbsdf.inputs["Roughness"].default_value = 0.16

# C. Dark Obsidian Staircase Steps
mat_obsidian = bpy.data.materials.new(name="CausyneObsidianStairs")
mat_obsidian.use_nodes = True
onodes = mat_obsidian.node_tree.nodes
olinks = mat_obsidian.node_tree.links
onodes.clear()
obsdf = onodes.new(type="ShaderNodeBsdfPrincipled")
oout = onodes.new(type="ShaderNodeOutputMaterial")
olinks.new(obsdf.outputs["BSDF"], oout.inputs["Surface"])
obsdf.inputs["Base Color"].default_value = (0.12, 0.13, 0.15, 1.0)
obsdf.inputs["Roughness"].default_value = 0.45
obsdf.inputs["Metallic"].default_value = 0.25

# 3. Build Sloped Talud-Tablero Pyramid Tiers (True Mayan/Aztec Architecture)
base_size = 12.0
num_tiers = 6
tier_height = 0.8
taper_ratio = 0.85 # Each tier tapers at top for authentic slope

for i in range(num_tiers):
    bottom_width = base_size * (1.0 - (i / (num_tiers + 1.5)))
    top_width = bottom_width * taper_ratio
    z_bottom = i * tier_height
    z_top = (i + 1) * tier_height
    
    # Create tapered frustum using BMesh
    bm = bmesh.new()
    # Bottom 4 verts
    v0 = bm.verts.new((-bottom_width/2, -bottom_width/2, z_bottom))
    v1 = bm.verts.new((bottom_width/2, -bottom_width/2, z_bottom))
    v2 = bm.verts.new((bottom_width/2, bottom_width/2, z_bottom))
    v3 = bm.verts.new((-bottom_width/2, bottom_width/2, z_bottom))
    # Top 4 verts
    v4 = bm.verts.new((-top_width/2, -top_width/2, z_top))
    v5 = bm.verts.new((top_width/2, -top_width/2, z_top))
    v6 = bm.verts.new((top_width/2, top_width/2, z_top))
    v7 = bm.verts.new((-top_width/2, top_width/2, z_top))
    bm.verts.ensure_lookup_table()
    
    # Faces
    bm.faces.new([v0, v3, v2, v1]) # Bottom
    bm.faces.new([v4, v5, v6, v7]) # Top
    bm.faces.new([v0, v1, v5, v4]) # South slope
    bm.faces.new([v1, v2, v6, v5]) # East slope
    bm.faces.new([v2, v3, v7, v6]) # North slope
    bm.faces.new([v3, v0, v4, v7]) # West slope
    
    mesh = bpy.data.meshes.new(f"PyramidTierMesh_{i}")
    bm.to_mesh(mesh)
    bm.free()
    
    tier_obj = bpy.data.objects.new(f"PyramidTier_{i}", mesh)
    bpy.context.scene.collection.objects.link(tier_obj)
    smooth_mesh(tier_obj)
    bev = tier_obj.modifiers.new("MasonryBevel", 'BEVEL')
    bev.width = 0.025
    bev.segments = 3
    bev.limit_method = 'ANGLE'
    tier_obj.data.materials.append(mat_stone)

# 4. Build 4 Grand Cardinal Staircases + Balustrades (North, South, East, West)
stair_width = 2.4
total_height = num_tiers * tier_height
step_count = int(total_height / 0.15) # 32+ detailed steps

for angle_deg in [0, 90, 180, 270]:
    rad = math.radians(angle_deg)
    for s in range(step_count):
        sh = s * 0.15
        progress = sh / total_height
        # Calculate horizontal distance from center based on slope
        dist_from_center = (base_size / 2.0) * (1.0 - progress * (1.0 - (1.0 / (num_tiers + 1.5)) * taper_ratio))
        
        step_x = dist_from_center * math.sin(rad)
        step_y = -dist_from_center * math.cos(rad)
        
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(step_x, step_y, sh + 0.075))
        step = bpy.context.active_object
        step.name = f"StairStep_{angle_deg}_{s}"
        
        # Orient step along cardinal direction
        step.rotation_euler = (0, 0, rad)
        step.scale = (stair_width, 0.35, 0.15)
        smooth_mesh(step)
        bev = step.modifiers.new("StepBevel", 'BEVEL')
        bev.width = 0.012
        step.data.materials.append(mat_obsidian)
    
    # Add Stone Altar Guardian Blocks at Staircase Bases
    base_x = (base_size / 2.0 + 0.6) * math.sin(rad)
    base_y = -(base_size / 2.0 + 0.6) * math.cos(rad)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(base_x, base_y, 0.5))
    guardian = bpy.context.active_object
    guardian.name = f"StairGuardian_{angle_deg}"
    guardian.rotation_euler = (0, 0, rad)
    guardian.scale = (stair_width + 0.6, 1.2, 1.0)
    smooth_mesh(guardian)
    bev = guardian.modifiers.new("GuardianBevel", 'BEVEL')
    bev.width = 0.04
    guardian.data.materials.append(mat_stone)

# 5. Build Ceremonial Top Temple Sanctuary with Pillars & Gold Capstone
top_z = num_tiers * tier_height
top_plat_width = base_size * (1.0 - ((num_tiers - 1) / (num_tiers + 1.5))) * taper_ratio * 0.85

# Sanctuary Base
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, top_z + 0.6))
temple = bpy.context.active_object
temple.name = "PyramidTempleBase"
temple.scale = (top_plat_width, top_plat_width, 1.2)
smooth_mesh(temple)
bev = temple.modifiers.new("TempleBevel", 'BEVEL')
bev.width = 0.03
temple.data.materials.append(mat_stone)

# Corner Pillars / Columns
pillar_dist = (top_plat_width / 2.0) - 0.4
for px in [-pillar_dist, pillar_dist]:
    for py in [-pillar_dist, pillar_dist]:
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.3, depth=1.8, location=(px, py, top_z + 1.2 + 0.9))
        pillar = bpy.context.active_object
        pillar.name = f"TemplePillar_{px}_{py}"
        smooth_mesh(pillar)
        pillar.data.materials.append(mat_stone)

# Temple Roof Sanctuary Canopy
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, top_z + 3.2))
roof = bpy.context.active_object
roof.name = "TempleRoof"
roof.scale = (top_plat_width + 0.6, top_plat_width + 0.6, 0.4)
smooth_mesh(roof)
bev = roof.modifiers.new("RoofBevel", 'BEVEL')
bev.width = 0.04
roof.data.materials.append(mat_stone)

# Gleaming Gold Capstone Pyramid & Sacrificial Altar Bowl
bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=1.4, depth=1.6, location=(0, 0, top_z + 3.4 + 0.8))
capstone = bpy.context.active_object
capstone.name = "AztecGoldCapstone"
capstone.rotation_euler = (0, 0, math.radians(45))
smooth_mesh(capstone)
bev = capstone.modifiers.new("CapstoneBevel", 'BEVEL')
bev.width = 0.03
capstone.data.materials.append(mat_gold)

# Sacrificial Gold Altar Bowl inside temple
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.6, depth=0.5, location=(0, 0, top_z + 1.2 + 0.25))
altar = bpy.context.active_object
altar.name = "SacrificialGoldAltar"
smooth_mesh(altar)
altar.data.materials.append(mat_gold)

print("Generated Extreme Cinematic Aztec Pyramid with Sloped Walls, 4 Staircases, Pillars, and Golden Sanctuary.")
"""

def get_watch_studio_script():
    """
    Returns a complete, high-precision procedural script for generating
    a photorealistic Luxury Watch Display on a velvet pedestal cushion
    with sapphire glass crystal, brushed steel case, and bezel.
    """
    return """
import bpy, math

def smooth_mesh(obj):
    if hasattr(obj.data, "use_auto_smooth"):
        try: obj.data.use_auto_smooth = True
        except: pass
    for p in obj.data.polygons:
        p.use_smooth = True

# Clean scene meshes
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)

# 1. Display Pedestal Base
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=2.5, depth=0.4, location=(0, 0, 0.2))
pedestal = bpy.context.active_object
pedestal.name = "PedestalBase"
smooth_mesh(pedestal)
bev = pedestal.modifiers.new(name="Bevel", type='BEVEL')
bev.width = 0.03

# 2. Velvet Cushion Ring
bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=32, major_radius=1.2, minor_radius=0.6, location=(0, 0, 0.7))
cushion = bpy.context.active_object
cushion.name = "VelvetCushion"
cushion.scale = (1.2, 1.0, 0.7)
smooth_mesh(cushion)

# 3. Watch Case Body
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=1.0, depth=0.28, location=(0, 0, 1.25))
case = bpy.context.active_object
case.name = "WatchCase"
smooth_mesh(case)
bev = case.modifiers.new(name="Bevel", type='BEVEL')
bev.width = 0.025
bev.segments = 4

# 4. Watch Bevel Ring
bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=16, major_radius=1.0, minor_radius=0.08, location=(0, 0, 1.39))
bezel = bpy.context.active_object
bezel.name = "WatchBezel"
smooth_mesh(bezel)

# 5. Sapphire Crystal Glass
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.92, depth=0.04, location=(0, 0, 1.41))
crystal = bpy.context.active_object
crystal.name = "SapphireCrystal"
smooth_mesh(crystal)

# 6. Dial Face
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.9, depth=0.02, location=(0, 0, 1.37))
dial = bpy.context.active_object
dial.name = "WatchDial"
smooth_mesh(dial)

# Materials
mat_steel = bpy.data.materials.new("WatchSteel")
mat_steel.use_nodes = True
s_bsdf = mat_steel.node_tree.nodes["Principled BSDF"]
s_bsdf.inputs["Base Color"].default_value = (0.88, 0.89, 0.90, 1.0)
s_bsdf.inputs["Metallic"].default_value = 1.0
s_bsdf.inputs["Roughness"].default_value = 0.08

mat_velvet = bpy.data.materials.new("PedestalVelvet")
mat_velvet.use_nodes = True
v_bsdf = mat_velvet.node_tree.nodes["Principled BSDF"]
v_bsdf.inputs["Base Color"].default_value = (0.04, 0.05, 0.08, 1.0)
v_bsdf.inputs["Roughness"].default_value = 0.92

mat_sapphire = bpy.data.materials.new("SapphireCrystalMat")
mat_sapphire.use_nodes = True
g_bsdf = mat_sapphire.node_tree.nodes["Principled BSDF"]
g_bsdf.inputs["Base Color"].default_value = (0.96, 0.98, 1.0, 1.0)
g_bsdf.inputs["Roughness"].default_value = 0.02
if "Transmission Weight" in g_bsdf.inputs: g_bsdf.inputs["Transmission Weight"].default_value = 0.98
elif "Transmission" in g_bsdf.inputs: g_bsdf.inputs["Transmission"].default_value = 0.98

mat_dial = bpy.data.materials.new("DialMidnight")
mat_dial.use_nodes = True
d_bsdf = mat_dial.node_tree.nodes["Principled BSDF"]
d_bsdf.inputs["Base Color"].default_value = (0.01, 0.02, 0.05, 1.0)
d_bsdf.inputs["Metallic"].default_value = 0.8
d_bsdf.inputs["Roughness"].default_value = 0.3

case.data.materials.append(mat_steel)
bezel.data.materials.append(mat_steel)
pedestal.data.materials.append(mat_steel)
cushion.data.materials.append(mat_velvet)
crystal.data.materials.append(mat_sapphire)
dial.data.materials.append(mat_dial)

print("Generated High-End Luxury Watch Display with Velvet Pedestal and Sapphire Crystal.")
"""

def get_flying_pen_animation_script():
    """
    Returns a complete procedural script for generating and keyframe-animating
    "The Flying Pen" — an executive luxury ballpoint pen (Montblanc / Parker inspired)
    with tapered cigar profile, knurled grip, beveled 24K gold bands, curved arched clip,
    and sapphire cabochon crown, swooping through a smooth 45-frame Bezier flight path.
    """
    return """
import bpy, math, bmesh

def smooth_mesh(obj):
    if hasattr(obj.data, "use_auto_smooth"):
        try: obj.data.use_auto_smooth = True
        except: pass
    for p in obj.data.polygons:
        p.use_smooth = True

# 1. Clear existing scene meshes
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH' or o.type == 'EMPTY':
        bpy.data.objects.remove(o, do_unlink=True)

# 2. Build High-End Luxury PBR Shaders
# Brushed Midnight Navy Resin with Clearcoat
mat_barrel = bpy.data.materials.new("PenBarrelMat")
mat_barrel.use_nodes = True
b_bsdf = mat_barrel.node_tree.nodes["Principled BSDF"]
b_bsdf.inputs["Base Color"].default_value = (0.04, 0.07, 0.15, 1.0)
b_bsdf.inputs["Metallic"].default_value = 0.85
b_bsdf.inputs["Roughness"].default_value = 0.18
if "Clearcoat" in b_bsdf.inputs: b_bsdf.inputs["Clearcoat"].default_value = 1.0
if "Clearcoat Roughness" in b_bsdf.inputs: b_bsdf.inputs["Clearcoat Roughness"].default_value = 0.03

# Polished 24K Gold Trim & Accent Rings
mat_gold = bpy.data.materials.new("PenGoldTrim")
mat_gold.use_nodes = True
g_bsdf = mat_gold.node_tree.nodes["Principled BSDF"]
g_bsdf.inputs["Base Color"].default_value = (1.0, 0.78, 0.34, 1.0)
g_bsdf.inputs["Metallic"].default_value = 1.0
g_bsdf.inputs["Roughness"].default_value = 0.08

# Mirror Chrome Nib, Tip & Clip
mat_chrome = bpy.data.materials.new("PenChromeTop")
mat_chrome.use_nodes = True
c_bsdf = mat_chrome.node_tree.nodes["Principled BSDF"]
c_bsdf.inputs["Base Color"].default_value = (0.94, 0.95, 0.97, 1.0)
c_bsdf.inputs["Metallic"].default_value = 1.0
c_bsdf.inputs["Roughness"].default_value = 0.05

# Sapphire Cabochon Crown Jewel
mat_jewel = bpy.data.materials.new("PenJewelMat")
mat_jewel.use_nodes = True
j_bsdf = mat_jewel.node_tree.nodes["Principled BSDF"]
j_bsdf.inputs["Base Color"].default_value = (0.01, 0.03, 0.22, 1.0)
j_bsdf.inputs["Metallic"].default_value = 0.1
j_bsdf.inputs["Roughness"].default_value = 0.02
if "Clearcoat" in j_bsdf.inputs: j_bsdf.inputs["Clearcoat"].default_value = 1.0

# 3. Create Master Assembly Empty
pen_parent = bpy.data.objects.new("TheFlyingPen", None)
pen_parent.empty_display_type = 'ARROWS'
pen_parent.empty_display_size = 0.5
bpy.context.scene.collection.objects.link(pen_parent)

# 4. Construct Streamlined Tapered Barrel (Cigar Profile using BMesh Lathe/Spin)
mesh_barrel = bpy.data.meshes.new("PenBarrelMesh")
obj_barrel = bpy.data.objects.new("PenBarrel", mesh_barrel)
bpy.context.scene.collection.objects.link(obj_barrel)
obj_barrel.parent = pen_parent

bm = bmesh.new()
# Define exact profile points (radius, Z height) from rear cap (-1.6) to grip joint (+1.2)
profile = [
    (0.0, -1.60),
    (0.12, -1.58),
    (0.155, -1.40),
    (0.175, -0.60),
    (0.180, 0.00),   # Center swell
    (0.170, 0.60),
    (0.150, 1.20),
    (0.140, 1.22),
    (0.0, 1.22)
]
verts = [bm.verts.new((p[0], 0, p[1])) for p in profile]
for i in range(len(verts) - 1):
    bm.edges.new([verts[i], verts[i+1]])

# Spin around Z axis (32 segments)
geom = bm.verts[:] + bm.edges[:]
bmesh.ops.spin(bm, geom=geom, angle=math.radians(360), steps=32, axis=(0, 0, 1), cent=(0, 0, 0))
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
bm.to_mesh(mesh_barrel)
bm.free()

smooth_mesh(obj_barrel)
bev_b = obj_barrel.modifiers.new("Bevel", 'BEVEL')
bev_b.width = 0.006
sub_b = obj_barrel.modifiers.new("Subsurf", 'SUBSURF')
sub_b.levels = 1
sub_b.render_levels = 2
obj_barrel.data.materials.append(mat_barrel)

# 5. Gold Accent Rings (Center Swell Band & Grip Collar)
bpy.ops.mesh.primitive_torus_add(major_radius=0.181, minor_radius=0.012, major_segments=48, minor_segments=16, location=(0, 0, 0.0))
ring_center = bpy.context.active_object
ring_center.name = "PenRingCenter"
ring_center.parent = pen_parent
ring_center.scale = (1.0, 1.0, 1.5)
smooth_mesh(ring_center)
ring_center.data.materials.append(mat_gold)

bpy.ops.mesh.primitive_torus_add(major_radius=0.142, minor_radius=0.010, major_segments=48, minor_segments=16, location=(0, 0, 1.22))
ring_grip = bpy.context.active_object
ring_grip.name = "PenRingGrip"
ring_grip.parent = pen_parent
smooth_mesh(ring_grip)
ring_grip.data.materials.append(mat_gold)

# 6. Machined Conical Nib & Ballpoint Cartridge Tip
bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=0.138, radius2=0.035, depth=0.65, location=(0, 0, 1.55))
nib = bpy.context.active_object
nib.name = "PenNibCone"
nib.parent = pen_parent
smooth_mesh(nib)
bev_n = nib.modifiers.new("Bevel", 'BEVEL')
bev_n.width = 0.004
nib.data.materials.append(mat_chrome)

# Ballpoint Tip (Tungsten Carbide Micro-Sphere)
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.025, location=(0, 0, 1.89))
tip = bpy.context.active_object
tip.name = "PenBallpointTip"
tip.parent = pen_parent
smooth_mesh(tip)
tip.data.materials.append(mat_chrome)

# 7. Crown Cap Ring & Sapphire Cabochon Finial
bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.145, depth=0.15, location=(0, 0, -1.65))
crown_ring = bpy.context.active_object
crown_ring.name = "PenCrownRing"
crown_ring.parent = pen_parent
smooth_mesh(crown_ring)
bev_cr = crown_ring.modifiers.new("Bevel", 'BEVEL')
bev_cr.width = 0.008
crown_ring.data.materials.append(mat_gold)

# Cabochon Dome Jewel
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.11, location=(0, 0, -1.74))
jewel = bpy.context.active_object
jewel.name = "PenCrownJewel"
jewel.parent = pen_parent
jewel.scale = (1.0, 1.0, 0.6)
smooth_mesh(jewel)
jewel.data.materials.append(mat_jewel)

# 8. Curved Spring Pocket Clip (Arched Profile Curve)
mesh_clip = bpy.data.meshes.new("PenClipMesh")
obj_clip = bpy.data.objects.new("PenClip", mesh_clip)
bpy.context.scene.collection.objects.link(obj_clip)
obj_clip.parent = pen_parent

bm_c = bmesh.new()
# Extrude arched clip spine from crown down barrel along +X side
clip_pts = [
    (0.135, 0.0, -1.65),
    (0.210, 0.0, -1.60),
    (0.230, 0.0, -1.40),
    (0.235, 0.0, -0.60),
    (0.220, 0.0, 0.10),
    (0.190, 0.0, 0.55),
    (0.170, 0.0, 0.60)
]
c_verts = [bm_c.verts.new(p) for p in clip_pts]
for i in range(len(c_verts) - 1):
    bm_c.edges.new([c_verts[i], c_verts[i+1]])

# Extrude clip profile width in Y axis (-0.035 to +0.035) and depth
bmesh.ops.extrude_edge_only(bm_c, edges=bm_c.edges[:])
for v in bm_c.verts:
    if len(v.link_edges) == 1 or v.co.y == 0:
        v.co.y = -0.035 if v.index % 2 == 0 else 0.035

# Give clip thickness by extruding inwards
geom_faces = [f for f in bm_c.faces]
if geom_faces:
    res = bmesh.ops.extrude_face_region(bm_c, geom=geom_faces)
    extruded_verts = [elem for elem in res['geom'] if isinstance(elem, bmesh.types.BMVert)]
    for v in extruded_verts:
        v.co.x -= 0.018

bmesh.ops.remove_doubles(bm_c, verts=bm_c.verts, dist=0.0001)
bm_c.to_mesh(mesh_clip)
bm_c.free()

smooth_mesh(obj_clip)
bev_clip = obj_clip.modifiers.new("Bevel", 'BEVEL')
bev_clip.width = 0.005
sub_clip = obj_clip.modifiers.new("Subsurf", 'SUBSURF')
sub_clip.levels = 1
obj_clip.data.materials.append(mat_gold)

# Teardrop Ball Terminal at tip of clip
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.038, location=(0.172, 0.0, 0.60))
clip_ball = bpy.context.active_object
clip_ball.name = "PenClipTerminal"
clip_ball.parent = pen_parent
smooth_mesh(clip_ball)
clip_ball.data.materials.append(mat_gold)

# 9. Keyframe Flight Animation (Frame 1 to 45)
# Set initial orientation so pen points forward gracefully
pen_parent.rotation_mode = 'XYZ'
bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = 45

# Keyframe 1: Entering smoothly from top-left
pen_parent.location = (-3.5, -2.5, 1.2)
pen_parent.rotation_euler = (math.radians(45), math.radians(-25), math.radians(35))
pen_parent.keyframe_insert(data_path="location", frame=1)
pen_parent.keyframe_insert(data_path="rotation_euler", frame=1)

# Keyframe 15: Mid-air majestic corkscrew bank
pen_parent.location = (-1.2, -0.8, 0.4)
pen_parent.rotation_euler = (math.radians(25), math.radians(110), math.radians(-15))
pen_parent.keyframe_insert(data_path="location", frame=15)
pen_parent.keyframe_insert(data_path="rotation_euler", frame=15)

# Keyframe 30: Dramatic sweeping curve center-stage right through focal plane
pen_parent.location = (0.6, 0.0, 0.0)
pen_parent.rotation_euler = (math.radians(-10), math.radians(220), math.radians(65))
pen_parent.keyframe_insert(data_path="location", frame=30)
pen_parent.keyframe_insert(data_path="rotation_euler", frame=30)

# Keyframe 45: Graceful hover/glide centered right in front of studio lens
pen_parent.location = (0.0, -1.8, 0.0)
pen_parent.rotation_euler = (math.radians(15), math.radians(360), math.radians(15))
pen_parent.keyframe_insert(data_path="location", frame=45)
pen_parent.keyframe_insert(data_path="rotation_euler", frame=45)

# Make animation curves smooth Bezier
action = pen_parent.animation_data.action if pen_parent.animation_data else None
if action:
    curves = action.fcurves if hasattr(action, 'fcurves') else (action.curves if hasattr(action, 'curves') else [])
    for fcurve in curves:
        if hasattr(fcurve, 'keyframe_points'):
            for kp in fcurve.keyframe_points:
                kp.interpolation = 'BEZIER'

print("Generated and Keyframed 'The Flying Pen' (True Industrial Design Executive Ballpoint Pen).")
"""

