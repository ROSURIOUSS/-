extends Control
## A metric local patch, not giant cells rendered on the globe.
signal cell_selected(identity: int)
signal return_to_planet

var state: Dictionary = {}
var selected_id: int = -1
var zoom: float = 1.0
var center := Vector2(200, 120)
var _dragging: bool = false

func _ready() -> void:
	custom_minimum_size = Vector2(400, 360)
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	clip_contents = true
	resized.connect(queue_redraw)
	tooltip_text = "Колесо: масштаб · Средняя/правая кнопка: перемещение · ЛКМ: клетка\nКонтур выбора — условная отметка; тело клетки имеет размер в мкм."

func update_world(data: Dictionary) -> void:
	state = data.get("ocean", {}) if data.get("ocean") is Dictionary else {}
	queue_redraw()

func reset_view() -> void:
	zoom = 1.0
	center = Vector2(200, 120)
	selected_id = -1
	_dragging = false
	queue_redraw()

func pixels_per_um() -> float:
	return maxf(0.1, minf((size.x - 40) / 400.0, (size.y - 90) / 240.0)) * zoom

func screen_point(point: Vector2) -> Vector2:
	return Vector2(size.x / 2, (size.y + 20) / 2) + (point - center) * pixels_per_um()

func patch_point(point: Vector2) -> Vector2:
	return center + (point - Vector2(size.x / 2, (size.y + 20) / 2)) / pixels_per_um()

func pick_cell(point: Vector2) -> int:
	var best: float = INF
	var identity := -1
	for cell: Dictionary in state.get("cells", []):
		var distance := screen_point(Vector2(cell["x"], cell["y"])).distance_to(point)
		# Click tolerance is symbolic, never the drawn body's diameter.
		if distance <= maxf(8, float(cell["diameter_um"]) * pixels_per_um() / 2) and distance < best:
			best = distance
			identity = int(cell["id"])
	return identity

func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index in [MOUSE_BUTTON_MIDDLE, MOUSE_BUTTON_RIGHT]:
			_dragging = event.pressed
		elif event.pressed and event.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN]:
			if event.button_index == MOUSE_BUTTON_WHEEL_DOWN and zoom <= 1:
				return_to_planet.emit()
			else:
				var before := patch_point(event.position)
				zoom = clampf(zoom * (1.25 if event.button_index == MOUSE_BUTTON_WHEEL_UP else 0.8), 1, 24)
				center += before - patch_point(event.position)
				center = center.clamp(Vector2.ZERO, Vector2(400, 240))
				queue_redraw()
		elif event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
			selected_id = pick_cell(event.position)
			cell_selected.emit(selected_id)
			queue_redraw()
		accept_event()
	elif event is InputEventMouseMotion and _dragging:
		center = (center - event.relative / pixels_per_um()).clamp(Vector2.ZERO, Vector2(400, 240))
		queue_redraw()
		accept_event()

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_WINDOW_FOCUS_OUT:
		_dragging = false

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color("061319"))
	if state.is_empty():
		return
	var font: Font = ThemeDB.fallback_font
	var scale := pixels_per_um()
	var origin := screen_point(Vector2.ZERO)
	var extent := Vector2(400, 240) * scale
	var cols := int(state["cols"])
	var rows := int(state["rows"])
	var nutrients: Array = state["nutrients"]
	for y in range(rows):
		for x in range(cols):
			var food := float(nutrients[y * cols + x])
			var rect := Rect2(origin + Vector2(x * 400.0 / cols, y * 240.0 / rows) * scale, Vector2(400.0 / cols, 240.0 / rows) * scale)
			draw_rect(rect, Color("0b222d").lerp(Color("215b57"), food))
			draw_rect(rect, Color(0.4, 0.8, 0.8, 0.045), false, 1)
	draw_rect(Rect2(origin, extent), Color("498080"), false, 1)
	for cell: Dictionary in state["cells"]:
		var point := screen_point(Vector2(cell["x"], cell["y"]))
		var radius := float(cell["diameter_um"]) * scale / 2
		var reserve := clampf(float(cell["energy"]) / 100, 0, 1)
		var color := Color("82beb6").lerp(Color("d8f2aa"), reserve)
		draw_circle(point, radius, Color(color, 0.85), true, -1, true)
		draw_arc(point, radius, 0, TAU, 32, Color("e5f9de"), minf(1, radius * 0.2), true)
		if radius > 5:
			# Cytoplasmic texture only: no invented eukaryotic nucleus.
			for i in range(4):
				var angle: float = float(cell["id"]) + i * 2.4
				draw_circle(point + Vector2(cos(angle), sin(angle)) * radius * 0.45, radius * 0.1, Color(color, 0.45), true, -1, true)
		if int(cell["id"]) == selected_id:
			draw_arc(point, maxf(10, radius + 5), 0, TAU, 48, Color("f1d4a3"), 1, true)
			draw_string(font, point + Vector2(radius + 10, -5), "#%d" % cell["id"], HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color("f1d4a3"))
	# Fixed overlays remain readable at every physical zoom.
	draw_rect(Rect2(0, 0, size.x, 45), Color(0.02, 0.06, 0.08, 0.95))
	draw_string(font, Vector2(16, 20), "ВОДНЫЙ МИКРОКОСМ / 400 × 240 мкм / УЧАСТОК #%d" % state["anchor"], HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color("c6eece"))
	draw_string(font, Vector2(16, 38), "Зелёный фон: питание · Тела в масштабе · Колесо / перемещение ПКМ / выбор ЛКМ", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color("8aa9a9"))
	var bar_um := 20.0 if zoom < 3 else (5.0 if zoom < 10 else 1.0)
	var bar_y := size.y - 21
	draw_rect(Rect2(10, bar_y - 24, maxf(170, bar_um * scale + 35), 45), Color(0.02, 0.06, 0.08, 0.95))
	draw_line(Vector2(20, bar_y), Vector2(20 + bar_um * scale, bar_y), Color("dfefdf"), 2)
	draw_line(Vector2(20, bar_y - 4), Vector2(20, bar_y + 4), Color("dfefdf"), 1)
	draw_line(Vector2(20 + bar_um * scale, bar_y - 4), Vector2(20 + bar_um * scale, bar_y + 4), Color("dfefdf"), 1)
	draw_string(font, Vector2(20, bar_y - 8), "%.0f мкм · %.2f пикс/мкм" % [bar_um, scale], HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color("dfefdf"))
