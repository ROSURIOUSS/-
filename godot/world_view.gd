extends Control
## Renders the authoritative Python snapshot; no simulation runs in the client.

signal creature_selected(id: int)

var snapshot: Dictionary = {}
var selected_id: int = -1
var layer: int = 0

func _ready() -> void:
	custom_minimum_size = Vector2(400, 280)
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	mouse_default_cursor_shape = Control.CURSOR_CROSS
	resized.connect(queue_redraw)

func update_world(data: Dictionary) -> void:
	snapshot = data
	queue_redraw()

func map_rect() -> Rect2:
	var ratio: float = 80.0 / 48.0
	var dimensions := Vector2(minf(size.x, size.y * ratio), minf(size.y, size.x / ratio))
	return Rect2((size - dimensions) / 2.0, dimensions)

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color("122020"))
	if snapshot.is_empty():
		return
	var rect := map_rect()
	var w: int = int(snapshot["width"])
	var h: int = int(snapshot["height"])
	var cell := rect.size / Vector2(w, h)
	var heights: Array = snapshot["elevation"]
	var food: Array = snapshot["food"]
	var meat: Array = snapshot["meat"]
	var sea: float = float(snapshot["config"]["sea_level"])
	for i in range(w * h):
		var elevation: float = float(heights[i])
		var color: Color
		if elevation <= sea:
			color = Color("142b31").lerp(Color("345758"), elevation / sea)
		elif layer == 1:
			color = Color("593924").lerp(Color("add158"), float(food[i]))
		elif layer == 2:
			var temp: float = float(snapshot["temperature"]) - 12.0 * absf(float(i / w) / h * 2.0 - 1.0)
			color = Color("366f9f").lerp(Color("d07940"), clampf((temp + 15.0) / 60.0, 0, 1))
		elif layer == 3:
			color = Color("303d30").lerp(Color("d49b72"), minf(1.0, float(meat[i])))
		else:
			color = Color("736f48").lerp(Color("43683e"), float(food[i]))
			if elevation - sea < 0.025:
				color = color.lerp(Color("a59b6a"), 0.6)
			if elevation > 0.68:
				color = color.lerp(Color("8b907f"), minf(1, (elevation - 0.68) * 3))
		var position_on_map := rect.position + Vector2(i % w, floori(float(i) / w)) * cell
		draw_rect(Rect2(position_on_map, cell + Vector2(0.5, 0.5)), color)
	for creature: Dictionary in snapshot["creatures"]:
		var position_on_map := rect.position + Vector2(float(creature["x"]), float(creature["y"])) * cell
		var radius := maxf(2.5, cell.x * 0.27 * float(creature["size"]))
		draw_circle(position_on_map + Vector2(1, 2), radius + 1, Color(0, 0, 0, 0.3))
		var color := Color.from_hsv(float(creature["hue"]), 0.4, 0.95)
		if creature["diet"] == "carnivore":
			var triangle := PackedVector2Array([position_on_map + Vector2(0, -radius * 1.5), position_on_map + Vector2(radius * 1.2, radius), position_on_map + Vector2(-radius * 1.2, radius)])
			draw_colored_polygon(triangle, color)
			triangle.append(triangle[0])
			draw_polyline(triangle, Color("e8a67d"), 1.0, true)
		else:
			draw_circle(position_on_map, radius, color)
		if float(creature["health"]) < 45:
			draw_arc(position_on_map, radius + 2, 0, TAU, 20, Color("dc7668"), 1.0, true)
		if int(creature["id"]) == selected_id:
			draw_arc(position_on_map, float(creature["vision"]) * cell.x, 0, TAU, 64, Color(0.78, 0.93, 0.55, 0.25), 1.0, true)
			draw_arc(position_on_map, radius + 5, 0, TAU, 24, Color("e7ffd3"), 1.5, true)

func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT and not snapshot.is_empty():
		var rect := map_rect()
		if not rect.has_point(event.position):
			return
		var point: Vector2 = (event.position - rect.position) / rect.size * Vector2(snapshot["width"], snapshot["height"])
		var best_distance: float = 2.5
		selected_id = -1
		for creature: Dictionary in snapshot["creatures"]:
			var distance := point.distance_to(Vector2(creature["x"], creature["y"]))
			if distance < best_distance:
				best_distance = distance
				selected_id = int(creature["id"])
		creature_selected.emit(selected_id)
		queue_redraw()
