extends Control
## Native desktop application. Owns its Python worker through private OS pipes.

const WorldView = preload("res://world_view.gd")
const PopulationChart = preload("res://population_chart.gd")
const NeuralActivity = preload("res://neural_activity.gd")
const PythonBridge = preload("res://python_bridge.gd")
const ACCENT := Color("c6ee8b")
const MUTED := Color("899582")

var bridge: PythonBridge
var _quitting: bool = false
var _sync_parameters: bool = true
var _exit_after_save: bool = false
var exit_dialog: ConfirmationDialog
var save_button: Button
var load_button: Button
var restart_button: Button
var save_dialog: FileDialog
var load_dialog: FileDialog
var snapshot: Dictionary = {}
var inputs: Dictionary = {}
var map_view: WorldView
var chart: PopulationChart
var stats: Label
var connection: Label
var clock: Label
var inspector: Label
var neural_activity: NeuralActivity
var journal: Label
var error_label: Label
var pause_button: Button
var create_button: Button
var speed_select: OptionButton

func _ready() -> void:
	get_tree().auto_accept_quit = false
	build_ui()
	build_file_dialogs()
	bridge = PythonBridge.new()
	bridge.state_received.connect(receive_state)
	bridge.command_finished.connect(receive_command)
	bridge.failed.connect(core_failed)
	add_child(bridge)
	restart_core()

func restart_core() -> void:
	connection.text = "Запускаем локальное ядро…"
	error_label.visible = false
	snapshot.clear()
	map_view.update_world({})
	chart.history = []
	chart.queue_redraw()
	stats.text = "Запускаем симуляцию…"
	_sync_parameters = true
	map_view.selected_id = -1
	update_inspector()
	set_controls_enabled(false)
	restart_button.disabled = true
	bridge.start()

func core_failed(message: String) -> void:
	connection.text = "Ядро остановлено"
	set_controls_enabled(false)
	restart_button.disabled = false
	show_error(message)

func set_controls_enabled(enabled: bool) -> void:
	create_button.disabled = not enabled
	pause_button.disabled = not enabled
	speed_select.disabled = not enabled
	save_button.disabled = not enabled
	load_button.disabled = not enabled

func build_file_dialogs() -> void:
	var folder := ProjectSettings.globalize_path("user://worlds")
	DirAccess.make_dir_recursive_absolute(folder)
	save_dialog = FileDialog.new()
	save_dialog.title = "Сохранить мир"
	save_dialog.access = FileDialog.ACCESS_FILESYSTEM
	save_dialog.file_mode = FileDialog.FILE_MODE_SAVE_FILE
	save_dialog.filters = PackedStringArray(["*.biosphere ; Мир Биосферы"])
	save_dialog.current_dir = folder
	save_dialog.current_file = "world.biosphere"
	save_dialog.use_native_dialog = true
	save_dialog.file_selected.connect(func(path: String): send_command("save", {"path": path}))
	add_child(save_dialog)
	load_dialog = FileDialog.new()
	load_dialog.title = "Загрузить мир"
	load_dialog.access = FileDialog.ACCESS_FILESYSTEM
	load_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	load_dialog.filters = PackedStringArray(["*.biosphere ; Мир Биосферы"])
	load_dialog.current_dir = folder
	load_dialog.use_native_dialog = true
	load_dialog.file_selected.connect(func(path: String): send_command("load", {"path": path}))
	add_child(load_dialog)
	save_dialog.canceled.connect(func(): _exit_after_save = false)
	exit_dialog = ConfirmationDialog.new()
	exit_dialog.title = "Закрыть Биосферу?"
	exit_dialog.dialog_text = "Сохранить мир перед выходом?\nБез сохранения текущий прогресс будет потерян."
	exit_dialog.ok_button_text = "Сохранить и выйти"
	exit_dialog.cancel_button_text = "Остаться"
	exit_dialog.add_button("Выйти без сохранения", false, "discard")
	exit_dialog.confirmed.connect(func():
		_exit_after_save = true
		save_dialog.popup_centered_ratio(0.65)
	)
	exit_dialog.custom_action.connect(func(action: StringName):
		if action == &"discard":
			exit_dialog.hide()
			finish_quit()
	)
	add_child(exit_dialog)

func label_for(text: String, font_size: int = 14, color: Color = Color("e6e9dc")) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	return label

func box_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color("171d17")
	style.border_color = Color("2b3429")
	style.set_border_width_all(1)
	style.set_corner_radius_all(8)
	style.content_margin_left = 18
	style.content_margin_right = 18
	style.content_margin_top = 14
	style.content_margin_bottom = 14
	return style

func panel_for(parent: Node) -> VBoxContainer:
	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override("panel", box_style())
	parent.add_child(panel)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 10)
	panel.add_child(column)
	return column

func build_ui() -> void:
	var ui_theme := Theme.new()
	ui_theme.default_font_size = 14
	theme = ui_theme
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 22)
	add_child(margin)
	var root := VBoxContainer.new()
	root.add_theme_constant_override("separation", 18)
	margin.add_child(root)
	var header := HBoxContainer.new()
	root.add_child(header)
	var brand := label_for("◉  Б И О С Ф Е Р А    /    лаборатория эволюции", 22, ACCENT)
	brand.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(brand)
	connection = label_for("Запускаем локальное ядро…", 13, MUTED)
	header.add_child(connection)
	restart_button = Button.new()
	restart_button.text = "Перезапустить ядро"
	restart_button.pressed.connect(restart_core)
	header.add_child(restart_button)
	var layout := HBoxContainer.new()
	layout.size_flags_vertical = Control.SIZE_EXPAND_FILL
	layout.add_theme_constant_override("separation", 22)
	root.add_child(layout)
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size.x = 285
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	layout.add_child(scroll)
	var sidebar := panel_for(scroll)
	sidebar.custom_minimum_size.x = 265
	sidebar.add_child(label_for("01 / СОЗДАНИЕ МИРА", 12, MUTED))
	sidebar.add_child(label_for("Всё начинается\nс условий.", 27))
	sidebar.add_child(label_for("Настройте планету.\nДайте жизни найти свой путь.", 13, MUTED))
	add_parameter(sidebar, "Семя мира", "seed", -2147483648, 2147483647, 1, 42)
	add_parameter(sidebar, "Температура, °C", "temperature", -15, 45, 1, 18)
	add_parameter(sidebar, "Осадки (0.05–1)", "rainfall", 0.05, 1, 0.01, 0.65)
	add_parameter(sidebar, "Уровень моря", "sea_level", 0.15, 0.75, 0.01, 0.42)
	add_parameter(sidebar, "Начальная популяция", "population", 2, 300, 1, 90)
	add_parameter(sidebar, "Вероятность мутации", "mutation", 0, 0.5, 0.01, 0.12)
	add_parameter(sidebar, "Доля хищников (0–0.5)", "predator_ratio", 0, 0.5, 0.01, 0.16)
	create_button = Button.new()
	create_button.text = "Создать новый мир ↗"
	create_button.custom_minimum_size.y = 43
	create_button.modulate = ACCENT
	create_button.pressed.connect(create_world)
	sidebar.add_child(create_button)
	sidebar.add_child(label_for("Заменит текущую симуляцию.\nПараметры применяются при создании.\n\nНейросеть: 16 → 8 ↺ → 4.\n8 состояний кратковременной памяти.\nПотомки наследуют её с мутациями.\n\nПробел — пауза. F11 — полный экран.\nCtrl+S / Ctrl+O — сохранить / загрузить.", 12, MUTED))
	var main := VBoxContainer.new()
	main.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	main.add_theme_constant_override("separation", 12)
	layout.add_child(main)
	main.add_child(label_for("02 / НАБЛЮДЕНИЕ", 12, MUTED))
	main.add_child(label_for("Мир, который живёт сам.", 28))
	stats = label_for("Ожидаем состояние мира…", 16, ACCENT)
	main.add_child(stats)
	var toolbar := HBoxContainer.new()
	main.add_child(toolbar)
	clock = label_for("День 0", 14, MUTED)
	clock.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	toolbar.add_child(clock)
	pause_button = Button.new()
	pause_button.text = "Пауза"
	pause_button.pressed.connect(toggle_pause)
	toolbar.add_child(pause_button)
	speed_select = OptionButton.new()
	for speed in [1, 2, 5, 10]:
		speed_select.add_item("%d×" % speed, speed)
	speed_select.item_selected.connect(func(index: int): send_command("control", {"speed": speed_select.get_item_id(index)}))
	toolbar.add_child(speed_select)
	var layer_select := OptionButton.new()
	for title in ["Биосфера", "Запасы пищи", "Температура", "Останки"]:
		layer_select.add_item(title)
	layer_select.item_selected.connect(func(index: int): map_view.layer = index; map_view.queue_redraw())
	toolbar.add_child(layer_select)
	save_button = Button.new()
	save_button.text = "Сохранить"
	save_button.pressed.connect(func(): save_dialog.popup_centered_ratio(0.65))
	toolbar.add_child(save_button)
	load_button = Button.new()
	load_button.text = "Загрузить"
	load_button.pressed.connect(func(): load_dialog.popup_centered_ratio(0.65))
	toolbar.add_child(load_button)
	map_view = WorldView.new()
	map_view.creature_selected.connect(func(_id: int): update_inspector())
	main.add_child(map_view)
	error_label = label_for("", 13, Color("f0cc9e"))
	error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	error_label.visible = false
	main.add_child(error_label)
	var details := HBoxContainer.new()
	details.add_theme_constant_override("separation", 15)
	main.add_child(details)
	var graph_box := panel_for(details)
	(graph_box.get_parent() as Control).size_flags_horizontal = Control.SIZE_EXPAND_FILL
	graph_box.add_child(label_for("Популяция / последние 240 дней", 13, MUTED))
	graph_box.add_child(label_for("Серый: все · Зелёный: травоядные · Рыжий: хищники", 11, MUTED))
	chart = PopulationChart.new()
	graph_box.add_child(chart)
	var inspect_box := panel_for(details)
	(inspect_box.get_parent() as Control).size_flags_horizontal = Control.SIZE_EXPAND_FILL
	inspect_box.add_child(label_for("Под микроскопом", 14, ACCENT))
	inspector = label_for("Нажмите на существо на карте,\nчтобы узнать его историю.", 13)
	inspect_box.add_child(inspector)
	inspect_box.add_child(label_for("Память сети: 8 реальных состояний (−1…1)", 11, MUTED))
	neural_activity = NeuralActivity.new()
	inspect_box.add_child(neural_activity)
	journal = label_for("ЖУРНАЛ МИРА / ожидаем первые наблюдения", 12, MUTED)
	journal.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	main.add_child(journal)

func add_parameter(parent: VBoxContainer, title: String, key: String, low: float, high: float, step_value: float, initial: float) -> void:
	parent.add_child(label_for(title, 12, MUTED))
	var spin := SpinBox.new()
	spin.min_value = low
	spin.max_value = high
	spin.step = step_value
	spin.value = initial
	spin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(spin)
	inputs[key] = spin

func receive_state(data: Dictionary) -> void:
	snapshot = data
	if _sync_parameters:
		for key: String in inputs:
			inputs[key].value = data["config"][key]
		_sync_parameters = false
	connection.text = "● Локальная симуляция"
	set_controls_enabled(true)
	if data.get("error") != null:
		show_error(str(data["error"]))
	elif int(data["population"]) == 0:
		show_error("Популяция вымерла. Измените условия и создайте новый мир.")
	stats.text = "Живых %d   ·   Травоядных %d   ·   Хищников %d   ·   Поколение %d\nТемпература %.1f °C   ·   Растительность %d%%   ·   Успешных охот %d" % [data["population"], data["herbivores"], data["carnivores"], data["generation"], data["temperature"], data["food_percent"], data["death_causes"]["predation"]]
	clock.text = "День %d · %s" % [int(data["day"]), season_name(float(data["day"]))]
	pause_button.text = "Продолжить" if data["paused"] else "Пауза"
	for index in range(speed_select.item_count):
		if speed_select.get_item_id(index) == int(data["speed"]):
			speed_select.select(index)
	map_view.update_world(data)
	chart.history = data["history"]
	chart.queue_redraw()
	var events: Array = data["events"]
	journal.text = "Родилось %d · Погибло %d (голод %d / возраст %d / охота %d / старые %d)\n%s" % [data["births"], data["deaths"], data["death_causes"]["starvation"], data["death_causes"]["age"], data["death_causes"]["predation"], data["death_causes"]["legacy"], str(events.back()) if not events.is_empty() else "Мир развивается."]
	update_inspector()

func season_name(day: float) -> String:
	return ["Весна", "Лето", "Осень", "Зима"][int(fmod(day + 15, 120) / 30)]

func update_inspector() -> void:
	neural_activity.activations = []
	if map_view.selected_id == -1:
		inspector.text = "Нажмите на существо:\n○ травоядные / △ хищники."
		neural_activity.queue_redraw()
		return
	for creature: Dictionary in snapshot.get("creatures", []):
		if int(creature["id"]) == map_view.selected_id:
			var diet := "Хищник" if creature["diet"] == "carnivore" else "Травоядное"
			var parent := "—" if creature["parent"] == null else "#%d" % int(creature["parent"])
			inspector.text = "%s #%d · Поколение %d\nЗдоровье %.0f%% · Энергия %.0f / 185\nВозраст %.1f дн. · Потомков %d · Охот %d\nСкорость %.2f · Размер %.2f · Обзор %.1f\nРодитель %s · Комфорт %.1f °C\n%s" % [diet, creature["id"], creature["generation"], creature["health"], creature["energy"], creature["age"], creature["children"], creature["kills"], creature["speed"], creature["size"], creature["vision"], parent, creature["ideal_temp"], creature["action"]]
			neural_activity.activations = creature["memory"]
			neural_activity.queue_redraw()
			return
	inspector.text = "Этот организм завершил свой путь.\nВыберите другое существо."
	neural_activity.queue_redraw()

func create_world() -> void:
	var config: Dictionary = {}
	for key: String in inputs:
		config[key] = int(inputs[key].value) if key in ["seed", "population"] else inputs[key].value
	send_command("world", config)

func toggle_pause() -> void:
	if not snapshot.is_empty():
		send_command("control", {"paused": not snapshot["paused"]})

func send_command(command: String, data: Dictionary) -> void:
	if bridge == null or not bridge.is_ready:
		if command == "save":
			_exit_after_save = false
		show_error("Ядро не готово. Команда не отправлена.")
		return
	if command in ["world", "load", "save"]:
		set_controls_enabled(false)
	bridge.submit(command, data)

func receive_command(command: String, success: bool, message: String) -> void:
	if not success:
		if command == "save":
			_exit_after_save = false
		set_controls_enabled(true)
		show_error(message)
		return
	if command in ["world", "load"]:
		map_view.selected_id = -1
		_sync_parameters = true
	if command not in ["state", "step"]:
		error_label.visible = false
	if not message.is_empty():
		connection.text = message
		show_error(message)
	if command == "save" and _exit_after_save:
		_exit_after_save = false
		call_deferred("finish_quit")

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and not _quitting and not _exit_after_save:
		if bridge != null and bridge.is_ready and not snapshot.is_empty():
			exit_dialog.popup_centered()
		else:
			finish_quit()

func finish_quit() -> void:
	if _quitting:
		return
	_quitting = true
	set_controls_enabled(false)
	if bridge != null:
		await bridge.shutdown()
	get_tree().quit()

func show_error(text: String) -> void:
	error_label.text = text
	error_label.visible = true

func _unhandled_key_input(event: InputEvent) -> void:
	if not event is InputEventKey or not event.pressed or event.echo:
		return
	if event.keycode == KEY_F11:
		var fullscreen := DisplayServer.window_get_mode() == DisplayServer.WINDOW_MODE_FULLSCREEN
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED if fullscreen else DisplayServer.WINDOW_MODE_FULLSCREEN)
	elif (event.ctrl_pressed or event.meta_pressed) and event.keycode == KEY_S and not save_button.disabled:
		save_dialog.popup_centered_ratio(0.65)
	elif (event.ctrl_pressed or event.meta_pressed) and event.keycode == KEY_O and not load_button.disabled:
		load_dialog.popup_centered_ratio(0.65)
	elif event.keycode == KEY_SPACE and not get_viewport().gui_get_focus_owner() is LineEdit:
		toggle_pause()
	else:
		return
	get_viewport().set_input_as_handled()
