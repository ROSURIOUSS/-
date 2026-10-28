extends Control

var history: Array = []

func _ready() -> void:
	custom_minimum_size = Vector2(200, 100)
	resized.connect(queue_redraw)

func _draw() -> void:
	for j in range(1, 4):
		draw_line(Vector2(0, size.y * j / 4.0), Vector2(size.x, size.y * j / 4.0), Color("303c2c"))
	if history.is_empty():
		return
	var peak: float = 10.0
	for sample: Dictionary in history:
		peak = maxf(peak, float(sample["population"]) * 1.15)
	for series in ["population", "herbivores", "carnivores"]:
		var points := PackedVector2Array()
		for i in range(history.size()):
			points.append(Vector2(4 + (size.x - 8) * i / maxf(1, history.size() - 1), size.y - 5 - float(history[i][series]) / peak * (size.y - 10)))
		if points.size() == 1:
			points.append(Vector2(size.x - 4, points[0].y))
		var color := Color("899582")
		if series == "herbivores":
			color = Color("c6ee8b")
		elif series == "carnivores":
			color = Color("edab7c")
		draw_polyline(points, color, 1.0 if series == "population" else 2.0, true)
