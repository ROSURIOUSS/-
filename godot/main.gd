extends Control
## Native desktop application. Owns its Python worker through private OS pipes.

const WorldView = preload("res://world_view.gd")
const PopulationChart = preload("res://population_chart.gd")
const SavePanel = preload("res://save_panel.gd")
const LineagePanel = preload("res://lineage_panel.gd")
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
var lineage_panel: LineagePanel
var save_panel: SavePanel
# Optional paths let native tests isolate recovery/settings from real user data.
var autosave_directory: String = ""
var preferences_path: String = "user://preferences.cfg"
var journal: Label
var details_panel: HBoxContainer
var analytics_button: CheckButton
var ecosystem_label: Label
var weather_label: Label
var error_label: Label
var pause_button: Button
var earth_button: Button
var earth_dialog: ConfirmationDialog
var scale_select: OptionButton
var create_button: Button
var speed_select: OptionButton
const BRUSHES = ["observe", "spawn_herbivore", "spawn_carnivore", "plant", "fertilize", "warm", "cool", "uplift", "lower", "dry", "heal", "erase_life", "rain"]
var brush_select: OptionButton
var brush_radius: SpinBox
var brush_strength: SpinBox
var brush_count: SpinBox
var undo_button: Button
var single_step_button: Button
var sandbox_status: Label
var _controls_ready: bool = false
var _blocking_requests: int = 0

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
	lineage_panel.update_world({}, -1)
	chart.history = []
	chart.queue_redraw()
	stats.text = "Запускаем симуляцию…"
	_sync_parameters = true
	_blocking_requests = 0
	save_panel.begin_session()
	map_view.finish_brush(false)
	brush_select.select(0)
	update_brush()
	map_view.selected_id = -1
	update_inspector()
	set_controls_enabled(false)
	restart_button.disabled = true
	bridge.start()

func core_failed(message: String) -> void:
	connection.text = "Ядро остановлено"
	set_controls_enabled(false)
	restart_button.disabled = false
	save_panel.core_failed(message)
	show_error(message)

func set_controls_enabled(enabled: bool) -> void:
	enabled = enabled and save_panel.session_ready
	_controls_ready = enabled
	save_panel.set_available(enabled)
	var geological := snapshot.get("earth") is Dictionary
	brush_select.disabled = not enabled or geological
	brush_radius.editable = enabled
	brush_strength.editable = enabled
	brush_count.editable = enabled
	single_step_button.disabled = not enabled
	undo_button.disabled = not enabled or not snapshot.get("sandbox", {}).get("can_undo", false)
	map_view.brush_enabled = enabled and not geological
	if not enabled:
		map_view.stop_stroke()
	create_button.disabled = not enabled
	earth_button.disabled = not enabled
	pause_button.disabled = not enabled or (geological and snapshot["earth"]["complete"])
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
	build_sandbox(sidebar)
	lineage_panel = LineagePanel.new()
	lineage_panel.lineage_selected.connect(focus_lineage)
	lineage_panel.tracking_changed.connect(func(enabled: bool):
		if enabled:
			brush_select.select(0)
			update_brush()
		map_view.set_lineage_tracking(enabled)
		lineage_panel.update_world(snapshot, map_view.tracked_lineage)
	)
	sidebar.add_child(lineage_panel)
	var weather_toggle := CheckButton.new()
	weather_toggle.text = "Облака и дождь"
	weather_toggle.button_pressed = true
	weather_toggle.tooltip_text = "Только отображение. Погода и водный баланс рассчитываются и без эффектов."
	weather_toggle.toggled.connect(func(enabled: bool): map_view.show_weather = enabled)
	sidebar.add_child(weather_toggle)
	sidebar.add_child(HSeparator.new())
	save_panel = SavePanel.new()
	save_panel.directory = autosave_directory if not autosave_directory.is_empty() else ProjectSettings.globalize_path("user://worlds/autosaves")
	save_panel.settings_path = preferences_path
	save_panel.command_requested.connect(send_command)
	save_panel.readiness_changed.connect(func(): set_controls_enabled(_blocking_requests == 0 and bridge != null and bridge.is_ready))
	save_panel.notice.connect(show_error)
	sidebar.add_child(save_panel)
	sidebar.add_child(HSeparator.new())
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
	earth_button = Button.new()
	earth_button.text = "Ранняя Земля · начать без жизни…"
	earth_button.tooltip_text = "Заданный сценарий первых 600 млн лет: остывание и океан. Происхождение жизни пока не моделируется. Заменит текущий мир."
	earth_button.pressed.connect(func(): earth_dialog.popup_centered())
	sidebar.add_child(earth_button)
	earth_dialog = ConfirmationDialog.new()
	earth_dialog.title = "Начать раннюю Землю?"
	earth_dialog.dialog_text = "Это заменит текущий мир без переноса существ.\nСначала сохраните важный прогресс.\n\nСценарий: 0–600 млн лет после формирования, без жизни.\nОстывание задано формулой, это не полная история Земли."
	earth_dialog.confirmed.connect(func(): send_command("earth", {"seed": int(inputs["seed"].value)}))
	add_child(earth_dialog)
	sidebar.add_child(label_for("Заменит текущую симуляцию.\nПараметры применяются при создании.\n\nНейросеть: 16 → 8 ↺ → 4.\n8 состояний кратковременной памяти.\nПотомки наследуют её с мутациями.\n\nПробел — пауза. F11 — полный экран.\nCtrl+S / Ctrl+O — сохранить / загрузить.", 12, MUTED))
	var main := VBoxContainer.new()
	main.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	main.add_theme_constant_override("separation", 12)
	layout.add_child(main)
	main.add_child(label_for("02 / НАБЛЮДЕНИЕ", 12, MUTED))
	main.add_child(label_for("Мир, который живёт сам.", 28))
	stats = label_for("Ожидаем состояние мира…", 16, ACCENT)
	main.add_child(stats)
	ecosystem_label = label_for("ПОЧВЫ / ЛЕСА / РАССЕЛЕНИЕ — ожидаем мир", 12, MUTED)
	main.add_child(ecosystem_label)
	weather_label = label_for("ПОГОДА / ожидаем климатические данные", 12, MUTED)
	main.add_child(weather_label)
	var toolbar := HBoxContainer.new()
	main.add_child(toolbar)
	clock = label_for("День 0", 14, MUTED)
	clock.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	toolbar.add_child(clock)
	scale_select = OptionButton.new()
	for title in ["Орбита", "Регион", "Микромир"]:
		scale_select.add_item(title)
	scale_select.item_selected.connect(func(index: int): map_view.set_scale_level(index))
	toolbar.add_child(scale_select)
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
	for title in ["Биосфера", "Трава", "Температура", "Останки", "Почвы", "Влажность", "Осадки", "Листва", "Семена"]:
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
	map_view.brush_requested.connect(submit_brush)
	map_view.creature_selected.connect(func(identity: int):
		_toggle_analytics(identity >= 0)
		analytics_button.set_pressed_no_signal(identity >= 0)
		update_inspector()
		lineage_panel.update_world(snapshot, map_view.tracked_lineage)
	)
	main.add_child(map_view)
	error_label = label_for("", 13, Color("f0cc9e"))
	error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	error_label.visible = false
	main.add_child(error_label)
	analytics_button = CheckButton.new()
	analytics_button.text = "Аналитика и организм"
	main.add_child(analytics_button)
	var details := HBoxContainer.new()
	details_panel = details
	details.visible = false
	analytics_button.toggled.connect(_toggle_analytics)
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
	var organism_scroll := ScrollContainer.new()
	organism_scroll.custom_minimum_size.y = 200
	organism_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	organism_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	inspect_box.add_child(organism_scroll)
	inspector.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	inspector.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	organism_scroll.add_child(inspector)
	inspect_box.add_child(label_for("Память сети: 8 реальных состояний (−1…1)", 11, MUTED))
	neural_activity = NeuralActivity.new()
	inspect_box.add_child(neural_activity)
	journal = label_for("ЖУРНАЛ МИРА / ожидаем первые наблюдения", 12, MUTED)
	journal.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	main.add_child(journal)

func build_sandbox(parent: VBoxContainer) -> void:
	parent.add_child(label_for("ПЕСОЧНИЦА / ИНСТРУМЕНТЫ", 12, ACCENT))
	brush_select = OptionButton.new()
	for title in ["Наблюдать / выбирать", "Заселить травоядных", "Заселить хищников", "Озеленить", "Удобрить почву", "Нагреть", "Охладить", "Поднять сушу", "Опустить сушу", "Иссушить", "Лечить и кормить", "Убрать организмы", "Вызвать дождь"]:
		brush_select.add_item(title)
	brush_select.item_selected.connect(func(_index: int): update_brush())
	parent.add_child(brush_select)
	var row := HBoxContainer.new()
	parent.add_child(row)
	brush_radius = sandbox_number(row, "Радиус, уч.", 0.75, 8.0, 0.25, 2.5)
	brush_strength = sandbox_number(row, "Сила", 0.1, 1.0, 0.1, 0.6)
	brush_count = sandbox_number(parent, "Организмов за касание", 1, 30, 1, 5)
	brush_radius.value_changed.connect(func(_value: float): update_brush())
	brush_strength.value_changed.connect(func(_value: float): update_brush())
	brush_count.value_changed.connect(func(_value: float): update_brush())
	undo_button = Button.new()
	undo_button.text = "Отменить мазок · Ctrl+Z"
	undo_button.pressed.connect(undo_sandbox)
	parent.add_child(undo_button)
	single_step_button = Button.new()
	single_step_button.text = "Один шаг и пауза · N"
	single_step_button.pressed.connect(func(): send_command("single_step", {}))
	parent.add_child(single_step_button)
	sandbox_status = label_for("Наблюдение: жизнь автономна.", 12, MUTED)
	sandbox_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	parent.add_child(sandbox_status)
	var note := label_for("ЛКМ / удержание — кисть. Esc — наблюдать.\nОтмена возвращает весь мир к началу\nмазка, включая автономные события,\nи ставит время на паузу.", 11, MUTED)
	parent.add_child(note)
	parent.add_child(HSeparator.new())

func sandbox_number(parent: Node, title: String, low: float, high: float, step_value: float, initial: float) -> SpinBox:
	var column := VBoxContainer.new()
	column.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(column)
	column.add_child(label_for(title, 11, MUTED))
	var spin := SpinBox.new()
	spin.min_value = low
	spin.max_value = high
	spin.step = step_value
	spin.value = initial
	column.add_child(spin)
	return spin

func update_brush() -> void:
	if map_view == null:
		return
	map_view.set_brush(BRUSHES[brush_select.selected], brush_radius.value, brush_strength.value, int(brush_count.value))
	sandbox_status.text = "Наблюдение: жизнь автономна." if brush_select.selected == 0 else "ЛКМ на планете: " + brush_select.get_item_text(brush_select.selected)

func submit_brush(data: Dictionary) -> void:
	if not _controls_ready or bridge == null or not bridge.is_ready:
		map_view.finish_brush(false)
		return
	bridge.submit("brush", data)

func undo_sandbox() -> void:
	if not undo_button.disabled:
		send_command("undo", {})

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
			if key != "population" or data.get("earth") == null:
				inputs[key].value = data["config"][key]
		_sync_parameters = false
	connection.text = "● Локальная симуляция"
	set_controls_enabled(_blocking_requests == 0)
	undo_button.tooltip_text = "Вернуть весь мир к дню %.2f и остановить время" % float(data["sandbox"]["undo_day"]) if data["sandbox"]["can_undo"] else "Пока нечего отменять"
	if data.get("error") != null:
		show_error(str(data["error"]))
	elif int(data["population"]) == 0 and data.get("earth") == null:
		show_error("Популяция вымерла. Заселите планету кистью или создайте новый мир.")
	stats.text = "Живых %d   ·   Травоядных %d   ·   Хищников %d   ·   Поколение %d\nТемпература %.1f °C   ·   Трава %d%%   ·   Успешных охот %d" % [data["population"], data["herbivores"], data["carnivores"], data["generation"], data["temperature"], data["food_percent"], data["death_causes"]["predation"]]
	ecosystem_label.text = "ЛЕСА %d%%   /   ПЛОДОРОДИЕ %d%%   /   ЗАСЕЛЕНО %d УЧАСТКОВ   /   БИОМАССА %.1f" % [data["ecosystem"]["forest_percent"], data["ecosystem"]["fertility_percent"], data["ecosystem"]["occupied_tiles"], data["ecosystem"]["biomass"]]
	ecosystem_label.text += "\nКОРМА / ТРАВА %d%% · ЛИСТВА %d%% · СЕМЕНА %d%%" % [data["nutrition"]["grass_percent"], data["nutrition"]["leaves_percent"], data["nutrition"]["seeds_percent"]]
	weather_label.text = "ОСАДКИ %d%%   /   ВЛАГА ПОЧВЫ %d%%   /   ЗАСУХА НА %d%% СУШИ" % [data["weather"]["rain_percent"], data["weather"]["moisture_percent"], data["weather"]["drought_percent"]]
	clock.text = "День %d · %s" % [int(data["day"]), season_name(float(data["day"]))]
	var earth = data.get("earth")
	scale_select.set_item_text(2, "Поверхность" if earth is Dictionary else "Микромир")
	if earth is Dictionary:
		stats.text = "РАННЯЯ ЗЕМЛЯ · %.0f млн лет после формирования\n%.1f °C · Твёрдая кора %.0f%% · Океан %.0f%% поверхности" % [float(earth["age_myr"]), float(earth["temperature_c"]), float(earth["solid_fraction"]) * 100, float(earth["ocean_percent"])]
		ecosystem_label.text = "УПРОЩЁННЫЙ СЦЕНАРИЙ / " + str(earth["phase"])
		weather_label.text = "Радиус 6 371 км · Рельеф до 8 км · Без существ, растений и готовой почвы"
		clock.text = "%.2f млрд лет назад · 5 млн лет/шаг" % (float(earth["years_ago_myr"]) / 1000.0)
		if earth["complete"]:
			show_error("Конец реализованного сценария. Дальнейшее происхождение и развитие жизни ещё не добавлено.")
		brush_select.select(0)
		update_brush()
	pause_button.text = "Продолжить" if data["paused"] else "Пауза"
	for index in range(speed_select.item_count):
		if speed_select.get_item_id(index) == int(data["speed"]):
			speed_select.select(index)
	map_view.update_world(data)
	lineage_panel.update_world(data, map_view.tracked_lineage)
	chart.history = data["history"]
	chart.queue_redraw()
	var events: Array = data["events"]
	journal.text = "Родилось %d · Заселено %d · Погибло %d (голод %d / возраст %d / охота %d / вмешательство %d / старые %d)\n%s" % [data["births"], data["introduced"], data["deaths"], data["death_causes"]["starvation"], data["death_causes"]["age"], data["death_causes"]["predation"], data["death_causes"]["intervention"], data["death_causes"]["legacy"], str(events.back()) if not events.is_empty() else "Мир развивается."]
	update_inspector()
	save_panel.update_world(data)

func _toggle_analytics(enabled: bool) -> void:
	details_panel.visible = enabled
	map_view.custom_minimum_size.y = 250 if enabled else 360


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
			var ancestry := "" if creature["lineage_complete"] else " (частичная)"
			inspector.text = "%s #%d · Поколение %d\nЛиния #%d%s · Панцирь %.0f%%\nВытянутость %.2f · Подвижность %.2f\nЗдоровье %.0f%% · Энергия %.0f / 185\nВозраст %.1f дн. · Потомков %d · Охот %d\nСкорость %.2f · Размер %.2f · Обзор %.1f\nРодитель %s · Комфорт %.1f °C\nЗдесь %.1f °C · %s\nВлага %.0f%% · Осадки %.0f%%" % [diet, creature["id"], creature["generation"], creature["lineage"], ancestry, float(creature["armor"]) * 100, creature["elongation"], creature["mobility"], creature["health"], creature["energy"], creature["age"], creature["children"], creature["kills"], creature["speed"], creature["size"], creature["vision"], parent, creature["ideal_temp"], creature["local_temperature"], creature["action"], float(creature["local_moisture"]) * 100, float(creature["local_rain"]) * 100]
			var forage := float(creature["foraging"])
			var specialization := "Травник" if forage < 0.33 else ("Листоед" if forage > 0.67 else "Смешанное питание")
			inspector.text += "\nПищеварение: %s · ген %.2f" % [specialization if creature["diet"] == "herbivore" else "Хищник / падальщик", forage]
			var local_food: Dictionary = creature["local_food"]
			inspector.text += "\nЗдесь: трава %.0f%% · листва %.0f%%\nСемена %.0f%% · останки %.2f" % [float(local_food["grass"]) * 100, float(local_food["leaves"]) * 100, float(local_food["seeds"]) * 100, float(local_food["carrion"])]
			var intelligence: Dictionary = creature["intelligence"]
			inspector.text += "\n\nИНДИВИДУАЛЬНОЕ ОБУЧЕНИЕ · %s\nОпыт: %d шагов · Обратная связь %+.3f\nСредняя награда %+.3f · Изменение слоя %.3f" % ["включено" if intelligence["enabled"] else "выключено", int(intelligence["updates"]), float(intelligence["reward"]), float(intelligence["baseline"]), float(intelligence["adaptation"])]
			inspector.text += "\nУ каждого своя сеть, память и обучаемый слой.\nИзменение слоя — не оценка разума."
			inspector.text += behavior_text(creature)
			neural_activity.activations = creature["memory"]
			neural_activity.queue_redraw()
			return
	inspector.text = "Этот организм завершил свой путь.\nВыберите другое существо."
	neural_activity.queue_redraw()

func behavior_text(creature: Dictionary) -> String:
	var behavior = creature.get("behavior")
	if not behavior is Dictionary:
		return "\n\nПоведение: ещё нет шага наблюдения."
	var inputs: Array = behavior["inputs"]
	var outputs: Array = behavior["outputs"]
	var velocity := Vector2(float(behavior["velocity"][0]), float(behavior["velocity"][1]))
	var prey := "—" if behavior["prey"] == null else "#%d" % int(behavior["prey"])
	var threat := "—" if behavior["threat"] == null else "#%d" % int(behavior["threat"])
	var text := "\n\nПОСЛЕДНИЙ ШАГ · день %.2f\nДобыча %s · Угроза %s\nДвижение: X %+.2f / Y %+.2f клет./день\nБерег заблокировал ход: %s" % [float(behavior["day"]), prey, threat, velocity.x, velocity.y, "да" if behavior["blocked"] else "нет"]
	var meal = behavior.get("meal")
	if meal is Dictionary:
		var foods := {"grass": "трава", "leaves": "листва", "seeds": "семена", "carrion": "останки"}
		text += "\nСъедено: %s · %.3f биомассы · +%.2f энергии" % [foods[meal["food"]], float(meal["amount"]), float(meal["energy"])]
	else:
		text += "\nНа этом шаге корм не съеден."

	text += "\nВХОДЫ СЕТИ (не текущие показания):\nЭнергия %+.2f · Доступный корм %.2f\nКорм З/В/С/Ю: %.2f / %.2f / %.2f / %.2f\nСуша З/В/С/Ю: %+.0f / %+.0f / %+.0f / %+.0f\nТемп. отклонение %+.2f · Шум %+.2f\nДобыча X/Y: %+.2f / %+.2f\nУгроза X/Y: %+.2f / %+.2f" % inputs
	text += "\nВЫХОДЫ СЕТИ (−1…1):\nХод X %+.2f · Ход Y %+.2f\nЕсть %+.2f · Потомство %+.2f" % outputs
	text += "\nСигнал не гарантирует действие: еда > −0.4,\nпотомство > −0.5 + возраст/энергия/лимит.\nЦели отмечены на момент решения; это не мысли."
	return text

func focus_lineage(identity: int) -> void:
	brush_select.select(0)
	update_brush()
	if map_view.focus_lineage(identity):
		lineage_panel.set_tracking(true)
		lineage_panel.update_world(snapshot, identity)

func create_world() -> void:
	var config: Dictionary = {}
	for key: String in inputs:
		config[key] = int(inputs[key].value) if key in ["seed", "population"] else inputs[key].value
	send_command("world", config)

func toggle_pause() -> void:
	if not snapshot.is_empty() and not pause_button.disabled:
		send_command("control", {"paused": not snapshot["paused"]})

func send_command(command: String, data: Dictionary) -> void:
	if bridge == null or not bridge.is_ready:
		if command == "save":
			_exit_after_save = false
		if command in ["autosave", "autosave_info", "recover"]:
			save_panel.receive_command(command, false, "Ядро не готово")
		show_error("Ядро не готово. Команда не отправлена.")
		return
	map_view.stop_stroke()
	if command in ["world", "earth", "load", "save", "undo", "autosave", "autosave_info", "recover"]:
		_blocking_requests += 1
		set_controls_enabled(false)
	bridge.submit(command, data)

func receive_command(command: String, success: bool, message: String) -> void:
	save_panel.receive_command(command, success, message)
	if command == "brush":
		map_view.finish_brush(success)
		if success:
			sandbox_status.text = message
			error_label.visible = false
			return
	if command in ["world", "earth", "load", "save", "undo", "autosave", "autosave_info", "recover"]:
		_blocking_requests = maxi(0, _blocking_requests - 1)
	if not success:
		if command == "save":
			_exit_after_save = false
		set_controls_enabled(_blocking_requests == 0)
		show_error(message)
		return
	if command in ["world", "earth", "load", "recover"]:
		brush_select.select(0)
		update_brush()
		map_view.selected_id = -1
		map_view.reset_view(true)
		_sync_parameters = true
	if command == "undo":
		map_view.clear_population_visuals()
		update_inspector()
	if command in ["autosave", "autosave_info"]:
		return
	if command not in ["state", "step"]:
		error_label.visible = false
	if not message.is_empty():
		connection.text = message
		show_error(message)
	if command == "save" and _exit_after_save:
		_exit_after_save = false
		call_deferred("finish_quit")

func _process(_delta: float) -> void:
	save_panel.interaction_busy = map_view._painting or map_view._brush_pending or save_dialog.visible or load_dialog.visible or exit_dialog.visible or earth_dialog.visible

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and not _quitting and not _exit_after_save:
		if bridge != null and bridge.is_ready and not snapshot.is_empty() and save_panel.has_user_world:
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
	if (event.ctrl_pressed or event.meta_pressed) and event.keycode == KEY_Z and not get_viewport().gui_get_focus_owner() is LineEdit:
		undo_sandbox()
	elif event.keycode == KEY_ESCAPE:
		brush_select.select(0)
		update_brush()
	elif event.keycode == KEY_N and not event.ctrl_pressed and not event.meta_pressed and not get_viewport().gui_get_focus_owner() is LineEdit and not single_step_button.disabled:
		send_command("single_step", {})
	elif event.keycode == KEY_HOME:
		map_view.reset_view()
	elif event.keycode == KEY_F11:
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
