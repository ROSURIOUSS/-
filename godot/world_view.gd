extends Control
## One real 3D planet, one Python world. Camera scale never spawns another world.
signal creature_selected(id: int)
signal scale_changed(description: String)
signal brush_requested(data: Dictionary)
const Geometry = preload("res://planet_geometry.gd")
const PLANET_SHADER = preload("res://shaders/planet.gdshader")
const CLOUD_SHADER = preload("res://shaders/clouds.gdshader")
const ATMOSPHERE_SHADER = preload("res://shaders/atmosphere.gdshader")
const ORGANISM_SHADER = preload("res://shaders/organism.gdshader")
# Visual units only: do not change inherited size or ecological interactions.
const ORGANISM_VISUAL_SCALE: float = 0.25

var snapshot: Dictionary = {}
var selected_id: int = -1
var tracked_lineage: int = -1
var track_lineage: bool = false
var _lineage_alive: bool = false
var layer: int = 0:
	set(value):
		layer = value
		if _ground_material != null:
			_ground_material.set_shader_parameter("layer", value)
var _geometry := Geometry.new()
var _viewport: SubViewport
var _scene: Node3D
var _camera: Camera3D
var _ground: MeshInstance3D
var _clouds: MeshInstance3D
var _ground_material: ShaderMaterial
var _cloud_material: ShaderMaterial
var _weather_texture: ImageTexture
var _temperature_texture: ImageTexture
var _height_texture: ImageTexture
var _habitat_texture: ImageTexture
var _forage_texture: ImageTexture
var _bodies: MultiMeshInstance3D
var _nuclei: MultiMeshInstance3D
var _tails: MultiMeshInstance3D
var _colonies: MultiMeshInstance3D
var _plants: MultiMeshInstance3D
var show_weather: bool = true
var _rain: MultiMeshInstance3D
var _rain_sites: Array[Dictionary] = []
var _rain_timer: float = 0.0
var _rain_clock: float = 0.0
var _selection: MeshInstance3D
var _vision: MeshInstance3D
var _hud: Label
var _visuals: Dictionary = {}
var _terrain_signature: int = 0
var _initial_focus: bool = true
var _plant_counter: int = 0
var _plants_initialized: bool = false
var _longitude: float = 0.25
var _latitude: float = 0.25
var _target_longitude: float = 0.25
var _target_latitude: float = 0.25
var _altitude: float = 13.0
var _target_altitude: float = 13.0
var _dragging: bool = false
var _follow: bool = false
var _last_scale: String = ""
var brush_kind: String = "observe"
var brush_radius: float = 2.5
var brush_strength: float = 0.6
var brush_count: int = 5
var brush_enabled: bool = false
var _brush_cursor: MeshInstance3D
var _painting: bool = false
var _brush_pending: bool = false
var _brush_timer: float = 0.0
var _stroke_id: int = 0
var _sandbox_dabs: int = 0

func _ready() -> void:
	custom_minimum_size = Vector2(480, 360)
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	focus_mode = Control.FOCUS_ALL
	mouse_default_cursor_shape = Control.CURSOR_CROSS
	clip_contents = true
	_build_scene()
	var help := Label.new()
	help.text = "КОЛЕСО — МАСШТАБ   /   ПКМ — ВРАЩЕНИЕ   /   ДВОЙНОЙ ЩЕЛЧОК — К ОРГАНИЗМУ   /   HOME — ПЛАНЕТА"
	help.add_theme_font_size_override("font_size", 10)
	help.add_theme_color_override("font_color", Color("afc4c7"))
	help.mouse_filter = Control.MOUSE_FILTER_IGNORE
	help.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_LEFT)
	help.position = Vector2(14, -27)
	add_child(help)
	_hud = Label.new()
	_hud.position = Vector2(16, 12)
	_hud.add_theme_font_size_override("font_size", 12)
	_hud.add_theme_color_override("font_color", Color("d1efc4"))
	_hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_hud)
	_update_camera(1.0)

func _build_scene() -> void:
	var container := SubViewportContainer.new()
	container.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	container.stretch = true
	container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(container)
	_viewport = SubViewport.new()
	_viewport.size = Vector2i(960, 600)
	_viewport.own_world_3d = true
	_viewport.gui_disable_input = true
	_viewport.msaa_3d = Viewport.MSAA_2X
	_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	container.add_child(_viewport)
	_scene = Node3D.new()
	_viewport.add_child(_scene)
	var environment_node := WorldEnvironment.new()
	var environment := Environment.new()
	environment.background_mode = Environment.BG_SKY
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("adc9d5")
	environment.ambient_light_energy = 0.65
	environment.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	var sky := Sky.new()
	var panorama := PanoramaSkyMaterial.new()
	panorama.panorama = _star_texture()
	sky.sky_material = panorama
	environment.sky = sky
	environment_node.environment = environment
	_scene.add_child(environment_node)
	var sunlight := DirectionalLight3D.new()
	sunlight.rotation_degrees = Vector3(-28, -32, 0)
	sunlight.light_color = Color("fff1d6")
	sunlight.light_energy = 1.7
	_scene.add_child(sunlight)
	_camera = Camera3D.new()
	_camera.near = 0.0008
	_camera.far = 100.0
	_camera.fov = 48.0
	_camera.current = true
	_scene.add_child(_camera)
	_ground = MeshInstance3D.new()
	_ground_material = ShaderMaterial.new()
	_ground_material.shader = PLANET_SHADER
	_ground.material_override = _ground_material
	_scene.add_child(_ground)
	_clouds = _shell(6.62, CLOUD_SHADER)
	_cloud_material = _clouds.material_override as ShaderMaterial
	_shell(6.80, ATMOSPHERE_SHADER)
	var body_mesh := SphereMesh.new()
	body_mesh.radial_segments = 16
	body_mesh.rings = 8
	body_mesh.radius = 1.0
	body_mesh.height = 2.0
	var body_material := ShaderMaterial.new()
	body_material.shader = ORGANISM_SHADER
	_bodies = _instances(body_mesh, body_material)
	var nucleus_material := StandardMaterial3D.new()
	nucleus_material.vertex_color_use_as_albedo = true
	nucleus_material.roughness = 0.2
	nucleus_material.emission_enabled = true
	nucleus_material.emission = Color("64431b")
	nucleus_material.emission_energy_multiplier = 0.3
	_nuclei = _instances(body_mesh, nucleus_material)
	var marker_material := StandardMaterial3D.new()
	marker_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	marker_material.vertex_color_use_as_albedo = true
	_colonies = _instances(body_mesh, marker_material)
	var tail_mesh := CylinderMesh.new()
	tail_mesh.top_radius = 1.0
	tail_mesh.bottom_radius = 1.0
	tail_mesh.height = 1.0
	tail_mesh.radial_segments = 5
	var tail_material := ShaderMaterial.new()
	tail_material.shader = ORGANISM_SHADER
	tail_material.set_shader_parameter("tail", true)
	_tails = _instances(tail_mesh, tail_material)
	var leaf_mesh := CylinderMesh.new()
	leaf_mesh.top_radius = 0.0
	leaf_mesh.bottom_radius = 1.0
	leaf_mesh.height = 1.0
	leaf_mesh.radial_segments = 7
	var leaf_material := StandardMaterial3D.new()
	leaf_material.vertex_color_use_as_albedo = true
	leaf_material.roughness = 0.9
	_plants = _instances(leaf_mesh, leaf_material)
	var drop_mesh := BoxMesh.new()
	drop_mesh.size = Vector3.ONE
	var rain_material := StandardMaterial3D.new()
	rain_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	rain_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	rain_material.vertex_color_use_as_albedo = true
	_rain = _instances(drop_mesh, rain_material)
	_selection = MeshInstance3D.new()
	var ring := TorusMesh.new()
	ring.inner_radius = 0.032
	ring.outer_radius = 0.035
	ring.rings = 32
	ring.ring_segments = 6
	_selection.mesh = ring
	var highlight := StandardMaterial3D.new()
	highlight.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	highlight.albedo_color = Color("d8ffa4")
	_selection.material_override = highlight
	_selection.visible = false
	_scene.add_child(_selection)
	_vision = MeshInstance3D.new()
	_vision.material_override = highlight
	_scene.add_child(_vision)
	_brush_cursor = MeshInstance3D.new()
	var brush_material := StandardMaterial3D.new()
	brush_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	brush_material.albedo_color = Color("ffd080")
	_brush_cursor.material_override = brush_material
	_brush_cursor.visible = false
	_scene.add_child(_brush_cursor)

func _shell(radius: float, shader: Shader) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	var sphere := SphereMesh.new()
	sphere.radius = radius
	sphere.height = radius * 2.0
	sphere.radial_segments = 96
	sphere.rings = 48
	node.mesh = sphere
	var material := ShaderMaterial.new()
	material.shader = shader
	node.material_override = material
	_scene.add_child(node)
	return node

func _instances(mesh: Mesh, material: Material) -> MultiMeshInstance3D:
	var node := MultiMeshInstance3D.new()
	var multimesh := MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.use_colors = true
	multimesh.use_custom_data = true
	multimesh.mesh = mesh
	node.multimesh = multimesh
	node.material_override = material
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_scene.add_child(node)
	return node

func _star_texture() -> ImageTexture:
	var image := Image.create(1024, 512, false, Image.FORMAT_RGB8)
	image.fill(Color("050b16"))
	var rng := RandomNumberGenerator.new()
	rng.seed = 78123
	for _star in range(1800):
		var x := rng.randi_range(0, 1023)
		var y := rng.randi_range(0, 511)
		var glow := rng.randf_range(0.15, 0.9)
		image.set_pixel(x, y, Color(glow * 0.8, glow * 0.9, glow))
	return ImageTexture.create_from_image(image)

func update_world(data: Dictionary) -> void:
	snapshot = data
	if data.is_empty() or _scene == null:
		_visuals.clear()
		tracked_lineage = -1
		_lineage_alive = false
		_follow = false
		if _bodies != null:
			_bodies.multimesh.instance_count = 0
			_nuclei.multimesh.instance_count = 0
			_tails.multimesh.instance_count = 0
			_colonies.multimesh.instance_count = 0
			_vision.mesh = null
			_selection.visible = false
		stop_stroke()
		_brush_cursor.visible = false
		_rain.multimesh.instance_count = 0
		_rain_sites.clear()
		return
	var dabs := int(data.get("sandbox", {}).get("dabs", 0))
	if dabs != _sandbox_dabs:
		_plants_initialized = false
		_sandbox_dabs = dabs
	_geometry.configure(data)
	var signature := hash([data["config"]["seed"], _geometry.sea, data["elevation"]])
	if _ground.mesh == null or signature != _terrain_signature:
		_terrain_signature = signature
		_visuals.clear()
		_ground.mesh = _geometry.make_mesh()
		_plants_initialized = false
		var image := Image.create(_geometry.width, _geometry.height, false, Image.FORMAT_RF)
		for i in range(_geometry.heights.size()):
			image.set_pixel(i % _geometry.width, i / _geometry.width, Color(float(_geometry.heights[i]), 0, 0))
		_height_texture = ImageTexture.create_from_image(image)
		_ground_material.set_shader_parameter("height_map", _height_texture)
	_update_habitat()
	_update_forage()
	_update_temperature()
	_update_weather()
	_ground_material.set_shader_parameter("sea_level", _geometry.sea)
	_ground_material.set_shader_parameter("temperature", float(data["temperature"]))
	_ground_material.set_shader_parameter("rainfall", float(data["config"]["rainfall"]))
	_cloud_material.set_shader_parameter("humidity", float(data["config"]["rainfall"]))
	_update_organisms()
	_plant_counter += 1
	if _plant_counter >= 15 or not _plants_initialized:
		_update_plants()
		_plant_counter = 0
		_plants_initialized = true
	if _initial_focus and not data["creatures"].is_empty():
		var first: Dictionary = data["creatures"][0]
		_aim_at(Vector2(first["x"], first["y"]) / Vector2(_geometry.width, _geometry.height))
		_longitude = _target_longitude
		_latitude = _target_latitude
		_initial_focus = false
	_update_vision()

func _update_habitat() -> void:
	var image := Image.create(_geometry.width, _geometry.height, false, Image.FORMAT_RGBA8)
	for i in range(_geometry.width * _geometry.height):
		image.set_pixel(i % _geometry.width, i / _geometry.width, Color(float(snapshot["food"][i]), float(snapshot["canopy"][i]), float(snapshot["soil"][i]), float(snapshot["meat"][i]) / 3.0))
	if _habitat_texture == null:
		_habitat_texture = ImageTexture.create_from_image(image)
		_ground_material.set_shader_parameter("habitat_map", _habitat_texture)
	else:
		_habitat_texture.update(image)

func _update_forage() -> void:
	var image := Image.create(_geometry.width, _geometry.height, false, Image.FORMAT_RGB8)
	for i in range(_geometry.width * _geometry.height):
		image.set_pixel(i % _geometry.width, i / _geometry.width, Color(float(snapshot["leaves"][i]), float(snapshot["seeds"][i]), 0))
	if _forage_texture == null:
		_forage_texture = ImageTexture.create_from_image(image)
		_ground_material.set_shader_parameter("forage_map", _forage_texture)
	else:
		_forage_texture.update(image)

func _update_temperature() -> void:
	var image := Image.create(_geometry.width, _geometry.height, false, Image.FORMAT_RF)
	var values: Array = snapshot.get("temperature_bias", [])
	for i in range(_geometry.width * _geometry.height):
		image.set_pixel(i % _geometry.width, i / _geometry.width, Color(float(values[i]) if i < values.size() else 0.0, 0, 0))
	if _temperature_texture == null:
		_temperature_texture = ImageTexture.create_from_image(image)
		_ground_material.set_shader_parameter("temperature_map", _temperature_texture)
	else:
		_temperature_texture.update(image)

func _update_weather() -> void:
	var image := Image.create(_geometry.width, _geometry.height, false, Image.FORMAT_RGBA8)
	var moisture: Array = snapshot["moisture"]
	var rain: Array = snapshot["rain"]
	for i in range(_geometry.width * _geometry.height):
		image.set_pixel(i % _geometry.width, i / _geometry.width, Color(float(moisture[i]), float(rain[i]), 0, 1))
	if _weather_texture == null:
		_weather_texture = ImageTexture.create_from_image(image)
		_ground_material.set_shader_parameter("weather_map", _weather_texture)
		_cloud_material.set_shader_parameter("weather_map", _weather_texture)
	else:
		_weather_texture.update(image)
	_cloud_material.set_shader_parameter("model_day", float(snapshot["day"]))
	_rain_timer = 0.0

func _refresh_rain_sites() -> void:
	_rain_sites.clear()
	var center_x := floori(fposmod(_longitude / TAU + 0.5, 1.0) * _geometry.width)
	var center_y := floori((0.5 - _latitude / PI) * _geometry.height)
	for y in range(maxi(0, center_y - 3), mini(_geometry.height, center_y + 4)):
		for offset in range(-4, 5):
			var x := posmod(center_x + offset, _geometry.width)
			var tile: int = y * _geometry.width + x
			var rain := float(snapshot["rain"][tile])
			if rain < 0.04:
				continue
			for drop in range(1 + floori(rain * 4)):
				if _rain_sites.size() >= 256:
					break
				var phase := fposmod(sin(float(tile * 7 + drop * 131)) * 43758.54, 1.0)
				var jitter := fposmod(phase * 17.13, 1.0)
				var uv := Vector2((x + 0.1 + phase * 0.8) / _geometry.width, (y + 0.1 + jitter * 0.8) / _geometry.height)
				_rain_sites.append({"point": _geometry.point(uv), "basis": _tangent_basis(uv), "phase": phase, "rain": rain})
	_rain.multimesh.instance_count = _rain_sites.size()

func _update_rain_effect(delta: float) -> void:
	_rain.visible = show_weather and _altitude < 2.0 and not snapshot.is_empty()
	_rain_timer = maxf(0.0, _rain_timer - delta)
	if not _rain.visible:
		return
	if _rain_timer <= 0:
		_refresh_rain_sites()
		_rain_timer = 0.2
	if not snapshot.get("paused", true):
		_rain_clock = fposmod(_rain_clock + delta, 1000.0)
	for i in range(_rain_sites.size()):
		var site: Dictionary = _rain_sites[i]
		var basis: Basis = site["basis"]
		var rain: float = site["rain"]
		var height := 0.025 + (1.0 - fposmod(_rain_clock * 1.5 + float(site["phase"]), 1.0)) * 0.14
		var point: Vector3 = site["point"] + basis.y * height
		_rain.multimesh.set_instance_transform(i, Transform3D(basis * Basis.from_scale(Vector3(0.0007, 0.012 + rain * 0.012, 0.0007)), point))
		_rain.multimesh.set_instance_color(i, Color(0.60, 0.80, 1.0, 0.35 + rain * 0.4))

func _update_organisms() -> void:
	var alive: Dictionary = {}
	var colonies: Dictionary = {}
	for creature: Dictionary in snapshot["creatures"]:
		var identity := int(creature["id"])
		var uv := Vector2(creature["x"], creature["y"]) / Vector2(_geometry.width, _geometry.height)
		var target := _geometry.point(uv, 0.016 * float(creature["size"]) * ORGANISM_VISUAL_SCALE)
		var fresh := not _visuals.has(identity)
		var visual: Dictionary = _visuals.get(identity, {"position": target, "heading": 0.0, "target_heading": 0.0, "phase": fposmod(float(identity), TAU), "motion": 0.0})
		var behavior = creature.get("behavior")
		var motion := 0.0
		if behavior is Dictionary:
			var velocity := Vector2(float(behavior["velocity"][0]), float(behavior["velocity"][1]))
			motion = clampf(velocity.length() / maxf(0.001, 2.4 * float(creature["mobility"]) * sqrt(2.0)), 0.0, 1.0)
			if velocity.length_squared() > 0.000001:
				var direction := Geometry.direction(uv + velocity / Vector2(_geometry.width, _geometry.height) * 0.001) - Geometry.direction(uv)
				var local := _tangent_basis(uv).inverse() * direction
				visual["target_heading"] = atan2(local.x, local.z)
				if fresh:
					visual["heading"] = visual["target_heading"]
		visual["target_motion"] = motion
		visual["target"] = target
		visual["data"] = creature
		alive[identity] = visual
		var cell := Vector2i(floori(float(creature["x"])), floori(float(creature["y"])))
		var colony: Vector2i = colonies.get(cell, Vector2i.ZERO)
		colonies[cell] = colony + Vector2i(1, 1 if creature["diet"] == "carnivore" else 0)
	_visuals = alive
	_refresh_lineage_selection()
	_colonies.multimesh.instance_count = colonies.size()
	var related_cells: Dictionary = {}
	if track_lineage and _lineage_alive:
		for visual: Dictionary in alive.values():
			var c: Dictionary = visual["data"]
			if int(c["lineage"]) == tracked_lineage:
				related_cells[Vector2i(floori(float(c["x"])), floori(float(c["y"])))] = true
	var marker_index := 0
	for cell: Vector2i in colonies:
		var population: Vector2i = colonies[cell]
		var uv := (Vector2(cell) + Vector2(0.5, 0.5)) / Vector2(_geometry.width, _geometry.height)
		var scale := 0.025 + sqrt(float(population.x)) * 0.008
		_colonies.multimesh.set_instance_transform(marker_index, Transform3D(Basis.from_scale(Vector3.ONE * scale), _geometry.point(uv, 0.18)))
		var color := Color("9be7ba").lerp(Color("ef9f6b"), float(population.y) / population.x)
		if track_lineage and _lineage_alive:
			color = Color("ffe694") if related_cells.has(cell) else color.darkened(0.65)
		_colonies.multimesh.set_instance_color(marker_index, color)
		marker_index += 1
	_bodies.multimesh.instance_count = alive.size()
	_nuclei.multimesh.instance_count = alive.size()
	_tails.multimesh.instance_count = alive.size() * 3
	if selected_id >= 0 and not _visuals.has(selected_id):
		_follow = false

func select_creature(identity: int, follow: bool = false) -> void:
	stop_stroke()
	selected_id = identity
	tracked_lineage = int(_visuals[identity]["data"]["lineage"]) if _visuals.has(identity) else -1
	_follow = follow
	_refresh_lineage_selection()
	creature_selected.emit(selected_id)
	_update_vision()

func _lineage_representative(identity: int) -> int:
	for family: Dictionary in snapshot.get("lineages", []):
		if int(family["id"]) == identity and _visuals.has(int(family["representative"])):
			return int(family["representative"])
	return -1

func _refresh_lineage_selection() -> void:
	if _visuals.has(selected_id):
		tracked_lineage = int(_visuals[selected_id]["data"]["lineage"])
	var representative := _lineage_representative(tracked_lineage)
	_lineage_alive = representative >= 0
	if not _visuals.has(selected_id) and track_lineage and _lineage_alive:
		selected_id = representative
		creature_selected.emit(selected_id)

func set_lineage_tracking(enabled: bool) -> void:
	track_lineage = enabled
	_refresh_lineage_selection()
	if enabled and _visuals.has(selected_id):
		_follow = true

func focus_lineage(identity: int) -> bool:
	var representative := _lineage_representative(identity)
	if representative < 0:
		return false
	track_lineage = true
	select_creature(representative, true)
	_target_altitude = 1.2
	return true

func _tangent_basis(uv: Vector2) -> Basis:
	var normal := Geometry.direction(uv)
	var longitude := (uv.x - 0.5) * TAU
	var east := Vector3(cos(longitude), 0, -sin(longitude))
	return Basis(east, normal, east.cross(normal)).orthonormalized()

func _update_plants() -> void:
	var transforms: Array[Transform3D] = []
	var colors: Array[Color] = []
	for i in range(_geometry.width * _geometry.height):
		if float(snapshot["elevation"][i]) <= _geometry.sea:
			continue
		var grass := float(snapshot["food"][i])
		var leaves := float(snapshot["leaves"][i])
		var seeds := float(snapshot["seeds"][i])
		var jitter := fposmod(sin(i * 137.31) * 43758.54, 1.0)
		var uv := Vector2((i % _geometry.width + 0.2 + jitter * 0.6) / _geometry.width, (float(i / _geometry.width) + 0.3 + jitter * 0.4) / _geometry.height)
		var drought := clampf((0.30 - float(snapshot["moisture"][i])) / 0.30, 0.0, 1.0)
		# Fixed representative glyphs per tile, not independent simulated plants/seeds.
		for kind in range(3):
			var amount: float = [grass, leaves, seeds][kind]
			if amount < [0.15, 0.10, 0.02][kind]:
				continue
			var site := uv + Vector2(float(kind) * 0.12, 0) / Vector2(_geometry.width, _geometry.height)
			var height: float = [0.008 + grass * 0.012, 0.025 + leaves * 0.04, 0.004][kind]
			var width: float = [0.003, 0.012 + leaves * 0.01, 0.003 + seeds * 0.006][kind]
			var basis := _tangent_basis(site) * Basis.from_scale(Vector3(width, height, width))
			transforms.append(Transform3D(basis, _geometry.point(site, height * 0.5)))
			var color: Color = [Color("7aa44d"), Color("235c43"), Color("e4b95b")][kind]
			colors.append(color.lerp(Color("a28a52"), drought * 0.6))
	_plants.multimesh.instance_count = transforms.size()
	for i in range(transforms.size()):
		_plants.multimesh.set_instance_transform(i, transforms[i])
		_plants.multimesh.set_instance_color(i, colors[i])

func _process(delta: float) -> void:
	if _camera == null:
		return
	_update_camera(delta)
	_update_brush(delta)
	_clouds.visible = show_weather and _altitude > 0.4
	_update_rain_effect(delta)
	_colonies.visible = _altitude > 1.5
	var index := 0
	var smoothing := 1.0 - exp(-delta * 12.0)
	_selection.visible = false
	for identity: int in _visuals:
		var visual: Dictionary = _visuals[identity]
		var c: Dictionary = visual["data"]
		var current: Vector3 = visual["position"]
		var target: Vector3 = visual["target"]
		var radius := lerpf(current.length(), target.length(), smoothing)
		current = current.lerp(target, smoothing).normalized() * radius
		visual["position"] = current
		var uv := Geometry.coordinates(current)
		visual["heading"] = lerp_angle(float(visual["heading"]), float(visual["target_heading"]), smoothing)
		if not snapshot.get("paused", true):
			visual["motion"] = lerpf(float(visual["motion"]), float(visual["target_motion"]), smoothing)
			visual["phase"] = fposmod(float(visual["phase"]) + delta * (2.0 + float(visual["motion"]) * 8.0) * minf(float(snapshot.get("speed", 1)), 5.0), TAU)
		elif float(visual["motion"]) == 0.0:
			visual["motion"] = visual["target_motion"]
		var motion := float(visual["motion"])
		var phase := float(visual["phase"]) / TAU
		var basis := _tangent_basis(uv) * Basis(Vector3.UP, float(visual["heading"]))
		var scale := float(c["size"]) * ORGANISM_VISUAL_SCALE
		var color := Color.from_hsv(float(c["hue"]), 0.49, 0.88)
		if c["diet"] == "carnivore":
			color = color.lerp(Color("e89c72"), 0.35)
		if track_lineage and _lineage_alive:
			color = color.lerp(Color("ffe694"), 0.55) if int(c["lineage"]) == tracked_lineage else color.darkened(0.65)
		var shape := float(c["elongation"])
		var armor := float(c["armor"])
		var girth := 1.0 / sqrt(shape)
		var body_scale := Vector3(0.012 * girth, 0.009 * girth * (1.0 + armor * 0.3), 0.020 * shape) * scale
		_bodies.multimesh.set_instance_transform(index, Transform3D(basis * Basis.from_scale(body_scale), current))
		_bodies.multimesh.set_instance_color(index, color)
		_bodies.multimesh.set_instance_custom_data(index, Color(phase, float(c["health"]) / 100, armor, motion))
		var nucleus_scale := Vector3.ONE * 0.0045 * scale
		_nuclei.multimesh.set_instance_transform(index, Transform3D(basis * Basis.from_scale(nucleus_scale), current + basis.y * 0.010 * scale * girth * (1.0 + armor * 0.3)))
		_nuclei.multimesh.set_instance_color(index, Color("ffd8a2") if c["diet"] == "carnivore" else Color("a9efda"))
		for segment in range(3):
			var offset := Vector3(sin(float(identity) + segment) * 0.002, 0, -0.020 * shape - segment * 0.014) * scale
			var tail_basis := basis * Basis(Vector3.RIGHT, PI * 0.5)
			_tails.multimesh.set_instance_transform(index * 3 + segment, Transform3D(tail_basis * Basis.from_scale(Vector3(0.0012, 0.018, 0.0012) * scale), current + basis * offset))
			_tails.multimesh.set_instance_color(index * 3 + segment, color.lightened(0.1))
			_tails.multimesh.set_instance_custom_data(index * 3 + segment, Color(phase, float(c["health"]) / 100, 0, motion))
		if identity == selected_id:
			_selection.visible = true
			_selection.transform = Transform3D(basis * Basis.from_scale(Vector3(girth, 1.0, shape) * scale), current - basis.y * 0.007 * scale)
		index += 1

func _update_camera(delta: float) -> void:
	if _follow and _visuals.has(selected_id):
		var data: Dictionary = _visuals[selected_id]["data"]
		_aim_at(Vector2(data["x"], data["y"]) / Vector2(_geometry.width, _geometry.height))
	var smoothing := 1.0 - exp(-delta * 9.0)
	_longitude = lerp_angle(_longitude, _target_longitude, smoothing)
	_latitude = lerpf(_latitude, _target_latitude, smoothing)
	_altitude = lerpf(_altitude, _target_altitude, smoothing)
	var uv := Vector2(_longitude / TAU + 0.5, 0.5 - _latitude / PI)
	var distance := _geometry.radius(uv) + _altitude
	_camera.near = clampf(_altitude * 0.02, 0.0005, 0.2)
	_camera.position = Geometry.direction(uv) * distance
	_camera.look_at(Vector3.ZERO, Vector3.UP)
	var description := "ОРБИТА" if _altitude > 4 else ("РЕГИОН" if _altitude > 0.4 else "МИКРОМИР")
	if _follow:
		description += " · СЛЕЖЕНИЕ #%d" % selected_id
	if track_lineage and tracked_lineage >= 0:
		description += " · ЛИНИЯ #%d%s" % [tracked_lineage, "" if _lineage_alive else " (ИСЧЕЗЛА)"]
	_hud.text = description + "  /  ×%.0f" % (13.0 / _altitude)
	if not snapshot.is_empty():
		var x := posmod(floori(uv.x * _geometry.width), _geometry.width)
		var y := clampi(floori(uv.y * _geometry.height), 0, _geometry.height - 1)
		var tile: int = y * _geometry.width + x
		var label := "ОКЕАН" if float(snapshot["elevation"][tile]) <= _geometry.sea else "ВЛАГА %.0f%%" % (float(snapshot["moisture"][tile]) * 100)
		_hud.text += "\nПОД КАМЕРОЙ / %s · ОСАДКИ %.0f%%" % [label, float(snapshot["rain"][tile]) * 100]
	if description != _last_scale:
		_last_scale = description
		scale_changed.emit(description)

func _aim_at(uv: Vector2) -> void:
	_target_longitude = (uv.x - 0.5) * TAU
	_target_latitude = clampf((0.5 - uv.y) * PI, -1.568, 1.568)

func set_scale_level(level: int) -> void:
	stop_stroke()
	_follow = false
	_target_altitude = [13.0, 1.2, 0.10][clampi(level, 0, 2)]
	if level == 2 and not snapshot.is_empty() and not snapshot["creatures"].is_empty():
		if not _visuals.has(selected_id):
			select_creature(int(snapshot["creatures"][0]["id"]))
		_follow = true
	_update_vision()

func clear_population_visuals() -> void:
	stop_stroke()
	_rain_sites.clear()
	_rain.multimesh.instance_count = 0
	_rain_timer = 0.0
	_rain_clock = 0.0
	_visuals.clear()
	_plants_initialized = false
	_follow = false
	selected_id = -1
	tracked_lineage = -1
	_lineage_alive = false
	_vision.mesh = null
	_selection.visible = false

func reset_view(reset_population: bool = false) -> void:
	stop_stroke()
	if reset_population:
		clear_population_visuals()
	_follow = false
	_target_altitude = 13.0
	_initial_focus = true

func _update_vision() -> void:
	if not _visuals.has(selected_id):
		_vision.mesh = null
		return
	var c: Dictionary = _visuals[selected_id]["data"]
	var mesh := ImmediateMesh.new()
	mesh.surface_begin(Mesh.PRIMITIVE_LINE_STRIP)
	for step in range(97):
		var angle: float = TAU * step / 96.0
		var uv := (Vector2(c["x"], c["y"]) + Vector2(cos(angle), sin(angle)) * float(c["vision"])) / Vector2(_geometry.width, _geometry.height)
		uv.y = clampf(uv.y, 0.001, 0.999)
		mesh.surface_add_vertex(_geometry.point(uv, 0.006))
	mesh.surface_end()
	_vision.mesh = mesh

func _pick_creature(position_on_view: Vector2) -> int:
	var best := 22.0
	var identity := -1
	for id: int in _visuals:
		var point: Vector3 = _visuals[id]["position"]
		if point.normalized().dot(_camera.position - point) <= 0 or _camera.is_position_behind(point):
			continue
		var projected := _camera.unproject_position(point)
		var distance := projected.distance_to(position_on_view)
		if distance < best:
			identity = id
			best = distance
	return identity

func set_brush(kind: String, radius: float, strength: float, count: int) -> void:
	stop_stroke()
	brush_kind = kind
	brush_radius = radius
	brush_strength = strength
	brush_count = count
	if kind != "observe":
		_follow = false

func stop_stroke() -> void:
	_painting = false
	_brush_timer = 0.0

func finish_brush(success: bool) -> void:
	_brush_pending = false
	if not success:
		stop_stroke()

func _update_brush(delta: float) -> void:
	_brush_timer = maxf(0.0, _brush_timer - delta)
	_brush_cursor.visible = false
	if not brush_enabled or brush_kind == "observe" or snapshot.is_empty() or _dragging:
		stop_stroke()
		return
	var mouse := get_local_mouse_position()
	if not Rect2(Vector2.ZERO, size).has_point(mouse):
		stop_stroke()
		return
	var hit = _geometry.pick(_camera.project_ray_origin(mouse), _camera.project_ray_normal(mouse))
	if not hit is Vector2:
		stop_stroke()
		return
	var mesh := ImmediateMesh.new()
	mesh.surface_begin(Mesh.PRIMITIVE_LINE_STRIP)
	for step in range(65):
		var angle: float = TAU * step / 64.0
		var uv: Vector2 = hit + Vector2(cos(angle), sin(angle)) * brush_radius / Vector2(_geometry.width, _geometry.height)
		uv.y = clampf(uv.y, 0.001, 0.999)
		mesh.surface_add_vertex(_geometry.point(uv, 0.008))
	mesh.surface_end()
	_brush_cursor.mesh = mesh
	_brush_cursor.visible = true
	if _painting and not Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
		stop_stroke()
	if _painting and not _brush_pending and _brush_timer <= 0.0:
		_brush_pending = true
		_brush_timer = 0.45 if brush_kind in ["uplift", "lower"] else 0.18
		brush_requested.emit({"kind": brush_kind, "x": hit.x * _geometry.width, "y": hit.y * _geometry.height,
			"radius": brush_radius, "strength": brush_strength, "count": brush_count, "stroke": _stroke_id})

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_WINDOW_FOCUS_OUT:
		_dragging = false
		stop_stroke()

func _input(event: InputEvent) -> void:
	if event is InputEventMouseButton and not event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		stop_stroke()
	if event is InputEventMouseButton and not event.pressed and event.button_index in [MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_MIDDLE]:
		_dragging = false


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index in [MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_MIDDLE]:
			_dragging = event.pressed
			stop_stroke()
			_follow = false
			accept_event()
		if event.pressed and event.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN]:
			stop_stroke()
			grab_focus()
			if _altitude > 2:
				var hit = _geometry.pick(_camera.project_ray_origin(event.position), _camera.project_ray_normal(event.position))
				if hit is Vector2:
					_aim_at(hit)
			_target_altitude = clampf(_target_altitude * (0.77 if event.button_index == MOUSE_BUTTON_WHEEL_UP else 1.30), 0.045, 30.0)
			accept_event()
		if event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
			grab_focus()
			if brush_kind != "observe":
				if brush_enabled and not _brush_pending:
					_stroke_id += 1
					_painting = true
					_brush_timer = 0.0
					_update_brush(0.0)
				accept_event()
				return
			select_creature(_pick_creature(event.position), _follow)
			if event.double_click:
				if selected_id >= 0:
					set_scale_level(2)
				else:
					var hit = _geometry.pick(_camera.project_ray_origin(event.position), _camera.project_ray_normal(event.position))
					if hit is Vector2:
						_aim_at(hit)
						_target_altitude = 0.25
			accept_event()
	elif event is InputEventMouseMotion and _dragging:
		var speed := 0.004 * clampf(_altitude / 5.0, 0.012, 1.5)
		_target_longitude -= event.relative.x * speed
		_target_latitude = clampf(_target_latitude + event.relative.y * speed, -1.568, 1.568)
		accept_event()
