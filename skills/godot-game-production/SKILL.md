---
name: godot-game-production
description: Sovereign Godot 4.x Game Development Mastery. Use when automating scene construction, GDScript 2.0 logic, headless builds, and automated playtest simulation.
---

# Sovereign Godot 4.x Game Production Mastery (`godot.act`)

This skill defines the rules, patterns, and reference architectures for building high-performance games using **Godot Engine 4.x** and Causyne's `godot.act` tool.

## 1. The 3-Layer Automation Protocol

Causyne operates Godot through local CLI workflows; socket editor control is on hold:
- **Layer 2: Headless CLI Execution (`action: "headless_run"`)**:
  Executes `godot --headless --path <projectDir> -s <scriptPath>` to run automated GDScript batch processors, procedural level generators, and asset importers without opening the GUI.
- **Automated playtesting:**
  Runs simulated physics ticks (`ticks=60..300`) inside Godot to audit FPS stability, memory consumption (`OS.get_static_memory_usage()`), and check for unhandled collision traps.

## 2. GDScript 2.0 Design Rules
- Always use static typing (`var speed: float = 12.0`, `func _physics_process(delta: float) -> void:`).
- Use `@export` for inspector properties and `@onready` for node references.
- For physics bodies (`RigidBody3D`, `CharacterBody3D`), apply movement inside `_physics_process(delta)` using `move_and_slide()` or forces.

## 3. Reference Template: Sovereign Cyberpunk Hovercraft Controller

When generating a 3D vehicle or hovercraft in Godot 4.x, use the following GDScript 2.0 pattern with 4-point raycast hover physics and smooth banking:

```gdscript
extends CharacterBody3D

@export var hover_height: float = 2.2
@export var hover_force: float = 45.0
@export var move_speed: float = 28.0
@export var turn_speed: float = 3.5
@export var damping: float = 0.88

@onready var ray_fl: RayCast3D = $RayFL
@onready var ray_fr: RayCast3D = $RayFR
@onready var ray_rl: RayCast3D = $RayRL
@onready var ray_rr: RayCast3D = $RayRR

var _velocity: Vector3 = Vector3.ZERO

func _physics_process(delta: float) -> void:
	var gravity_vec = Vector3.DOWN * 9.81 * delta
	var total_force = Vector3.ZERO
	
	# Apply 4-point hover forces
	var rays = [ray_fl, ray_fr, ray_rl, ray_rr]
	for ray in rays:
		if ray.is_colliding():
			var dist = ray.get_collision_point().distance_to(ray.global_position)
			if dist < hover_height:
				var push = (hover_height - dist) / hover_height
				total_force += ray.get_collision_normal() * (push * hover_force)
	
	# Handle input
	var forward_input = Input.get_axis("ui_down", "ui_up")
	var turn_input = Input.get_axis("ui_right", "ui_left")
	
	rotate_y(turn_input * turn_speed * delta)
	var forward_dir = -global_transform.basis.z
	total_force += forward_dir * (forward_input * move_speed)
	
	_velocity = (_velocity + total_force * delta + gravity_vec) * damping
	velocity = _velocity
	move_and_slide()
```
