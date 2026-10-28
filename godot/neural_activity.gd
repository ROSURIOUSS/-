extends Control
## Actual recurrent state from the selected organism, NOT a decorative graph.
var activations: Array = []

func _ready() -> void:
	custom_minimum_size = Vector2(180, 30)
	resized.connect(queue_redraw)

func _draw() -> void:
	if activations.is_empty():
		return
	var middle := size.y / 2.0
	draw_line(Vector2(0, middle), Vector2(size.x, middle), Color("43503b"))
	var width := size.x / activations.size()
	for i in range(activations.size()):
		var value := clampf(float(activations[i]), -1, 1)
		var height := absf(value) * (middle - 2)
		var top := middle - height if value >= 0 else middle
		var color := Color("c6ee8b") if value >= 0 else Color("edab7c")
		draw_rect(Rect2(Vector2(i * width + 2, top), Vector2(maxf(1, width - 4), maxf(1, height))), color)
