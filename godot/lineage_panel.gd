extends VBoxContainer
## Living family groups from the core. A family is NOT a biological species.
signal lineage_selected(identity: int)
signal tracking_changed(enabled: bool)
var _summary: Label
var _status: Label
var _list: ItemList
var _tracking: CheckButton
var _signature: Array = []

func _ready() -> void:
	var toggle := CheckButton.new()
	toggle.text = "Линии и наследование"
	add_child(toggle)
	var content := VBoxContainer.new()
	content.visible = false
	toggle.toggled.connect(func(enabled: bool): content.visible = enabled)
	add_child(content)
	_summary = Label.new()
	_summary.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	content.add_child(_summary)
	_tracking = CheckButton.new()
	_tracking.text = "Следить за родственной линией"
	_tracking.add_theme_font_size_override("font_size", 12)
	_tracking.toggled.connect(func(enabled: bool): tracking_changed.emit(enabled))
	content.add_child(_tracking)
	_list = ItemList.new()
	_list.custom_minimum_size.y = 160
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list.fixed_column_width = 215
	_list.add_theme_font_size_override("font_size", 12)
	_list.item_selected.connect(func(index: int): lineage_selected.emit(int(_list.get_item_metadata(index))))
	content.add_child(_list)
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_font_size_override("font_size", 11)
	content.add_child(_status)

func set_tracking(enabled: bool) -> void:
	_tracking.set_pressed_no_signal(enabled)

func update_world(data: Dictionary, selected_lineage: int) -> void:
	if _summary == null:
		return
	var families: Array = data.get("lineages", [])
	var evolution: Dictionary = data.get("evolution", {})
	_summary.text = "Живых линий: %d · Панцирь: %.0f%%\nСредняя вытянутость: %.2f" % [families.size(), float(evolution.get("mean_armor", 0)) * 100, float(evolution.get("mean_elongation", 0))]
	var signature: Array = []
	for family: Dictionary in families:
		signature.append([family["id"], family["population"], family["generation"], family["complete"]])
	if signature != _signature:
		var scroll := _list.get_v_scroll_bar().value
		_list.clear()
		for family: Dictionary in families:
			var suffix := "" if family["complete"] else "?"
			var index := _list.add_item("#%d%s · %d живых · покол. %d" % [family["id"], suffix, family["population"], family["generation"]])
			_list.set_item_metadata(index, int(family["id"]))
		_list.get_v_scroll_bar().value = scroll
		_signature = signature
	_list.deselect_all()
	var selected: Dictionary = {}
	for index in range(families.size()):
		var family: Dictionary = families[index]
		_list.set_item_tooltip(index, "%s · панцирь %.0f%% · вытянутость %.2f\n%s" % ["Хищники" if family["diet"] == "carnivore" else "Травоядные", float(family["mean_armor"]) * 100, family["mean_elongation"], "Известна линия основателя" if family["complete"] else "В старом файле часть предков отсутствует; ID — известный родитель-якорь"])
		if int(family["id"]) == selected_lineage:
			_list.select(index, false)
			selected = family
	if not selected.is_empty():
		_status.text = "Линия #%d: %d живых. Щелчок по строке — к представителю.\n? — неполная старая родословная. Линии — не виды." % [selected_lineage, selected["population"]]
	elif selected_lineage >= 0:
		_status.text = "Линия #%d исчезла. Чужая линия не выбирается автоматически." % selected_lineage
	else:
		_status.text = "Выберите организм или линию.\nЭто родственные группы, не виды."
