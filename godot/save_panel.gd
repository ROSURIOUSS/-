extends VBoxContainer
## Desktop session guard. The core owns files; this panel owns consent and scheduling.
signal command_requested(command: String, data: Dictionary)
signal readiness_changed
signal notice(message: String)
const INTERVALS = [30, 60, 180]
var directory: String = ""
var settings_path: String = "user://preferences.cfg"
var session_ready: bool = false
var has_user_world: bool = false
var interaction_busy: bool = false
var enabled: bool = true
var interval: int = 60
var _available: bool = false
var _phase: String = "initial"
var _elapsed: float = 0.0
var _version: int = 0
var _saved_version: int = -1
var _fingerprint: Array = []
var _saving: bool = false
var _save_ack: bool = false
var _refresh_choice: bool = false
var _choice: Dictionary = {}
var _records: Array = []
var _last_state: Dictionary = {}
var _startup_choice: bool = false
var _was_paused: bool = true
var _status_error: String = ""
var _enabled_toggle: CheckButton
var _interval_select: OptionButton
var _save_button: Button
var _restore_button: Button
var _refresh_button: Button
var _slots: OptionButton
var _status: Label
var _dialog: ConfirmationDialog

func _ready() -> void:
	var preferences := ConfigFile.new()
	if preferences.load(settings_path) == OK:
		var setting = preferences.get_value("autosave", "enabled", true)
		enabled = setting if typeof(setting) == TYPE_BOOL else true
		setting = preferences.get_value("autosave", "interval", 60)
		interval = setting if typeof(setting) == TYPE_INT and setting in INTERVALS else 60
	var title := Label.new()
	title.text = "ПРОГРЕСС / АВТОКОПИИ"
	title.add_theme_font_size_override("font_size", 12)
	add_child(title)
	_enabled_toggle = CheckButton.new()
	_enabled_toggle.text = "Автосохранение · 3 слота"
	_enabled_toggle.button_pressed = enabled
	_enabled_toggle.toggled.connect(func(value: bool): enabled = value; _elapsed = 0.0; _persist_settings())
	add_child(_enabled_toggle)
	_interval_select = OptionButton.new()
	for seconds: int in INTERVALS:
		_interval_select.add_item("Каждые %d сек. реального времени" % seconds, seconds)
		if seconds == interval:
			_interval_select.select(_interval_select.item_count - 1)
	_interval_select.item_selected.connect(func(index: int): interval = _interval_select.get_item_id(index); _elapsed = 0.0; _persist_settings())
	add_child(_interval_select)
	_save_button = Button.new()
	_save_button.text = "Сделать автокопию сейчас"
	_save_button.pressed.connect(request_save)
	add_child(_save_button)
	_slots = OptionButton.new()
	add_child(_slots)
	_restore_button = Button.new()
	_restore_button.text = "Восстановить выбранную…"
	_restore_button.pressed.connect(request_restore)
	add_child(_restore_button)
	_refresh_button = Button.new()
	_refresh_button.text = "Обновить список копий"
	_refresh_button.pressed.connect(func(): command_requested.emit("autosave_info", {"directory": directory}))
	add_child(_refresh_button)
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_font_size_override("font_size", 11)
	add_child(_status)
	_dialog = ConfirmationDialog.new()
	_dialog.title = "Восстановление прогресса"
	_dialog.ok_button_text = "Восстановить"
	_dialog.min_size = Vector2i(580, 240)
	_dialog.get_label().autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dialog.add_button("Обновить копии", false, "refresh")
	_dialog.confirmed.connect(_confirm_restore)
	_dialog.canceled.connect(_cancel_restore)
	_dialog.custom_action.connect(func(action: StringName):
		if action == "refresh":
			_refresh_choice = true
			command_requested.emit("autosave_info", {"directory": directory})
	)
	add_child(_dialog)
	set_available(false)

func begin_session() -> void:
	_phase = "initial"
	session_ready = false
	has_user_world = false
	_saving = false
	_save_ack = false
	_elapsed = 0.0
	_version = 0
	_saved_version = -1
	_fingerprint.clear()
	_records.clear()
	_last_state.clear()
	_choice.clear()
	_status_error = ""
	_refresh_choice = false
	_dialog.hide()
	_slots.clear()
	_status.text = "Проверяем возможность восстановления…"
	set_available(false)
	readiness_changed.emit()

func set_available(value: bool) -> void:
	_available = value
	var usable := value and session_ready and not _saving
	_save_button.disabled = not usable
	_restore_button.disabled = not usable or _records.is_empty()
	_refresh_button.disabled = not usable
	_slots.disabled = not usable or _records.is_empty()

func core_failed(message: String) -> void:
	session_ready = false
	_saving = false
	_phase = "disconnected"
	_dialog.hide()
	_status_error = "Ядро недоступно. Автокопии на диске не изменены.\n" + message
	_status.text = _status_error
	set_available(false)

func _persist_settings() -> void:
	var preferences := ConfigFile.new()
	preferences.load(settings_path)
	preferences.set_value("autosave", "enabled", enabled)
	preferences.set_value("autosave", "interval", interval)
	var folder := ProjectSettings.globalize_path(settings_path).get_base_dir()
	DirAccess.make_dir_recursive_absolute(folder)
	if preferences.save(settings_path) != OK:
		notice.emit("Не удалось записать настройки. Они действуют только в текущем окне.")

func _process(delta: float) -> void:
	if not session_ready or not enabled or _saving or not _available or _last_state.is_empty():
		return
	_elapsed = minf(_elapsed + delta, float(interval))
	if _elapsed >= interval and _version != _saved_version and not interaction_busy and _last_state.get("error") == null:
		request_save()

func request_save() -> void:
	if not session_ready or not _available or _saving:
		return
	if _last_state.get("error") != null:
		_status_error = "Расчёт остановлен с ошибкой. Прежние автокопии не заменяются."
		_status.text = _status_error
		return
	_saving = true
	_status_error = ""
	set_available(_available)
	command_requested.emit("autosave", {"directory": directory})

func receive_command(command: String, success: bool, message: String) -> void:
	if command == "autosave":
		_elapsed = 0.0
		if success:
			_save_ack = true  # Mark clean only AFTER receiving the saved state's snapshot.
		else:
			_saving = false
			_status_error = "Ошибка автокопии: " + message
			_status.text = _status_error
	elif command == "autosave_info":
		if success:
			_status_error = ""
			if _phase == "checking":
				_phase = "info_ready"
		else:
			_status_error = "Копии недоступны: " + message
			_status.text = _status_error
			if _phase == "checking":
				# Unknown disk state: don't overwrite anything automatically in this session.
				enabled = false
				_enabled_toggle.set_pressed_no_signal(false)
				_finish_startup(false)
	elif command == "recover":
		if success:
			_phase = "recovered"
		else:
			_status_error = "Не удалось восстановить: " + message
			_status.text = _status_error
			_phase = "choosing"
			_update_dialog()
			_dialog.popup_centered()
	elif success and command in ["world", "load", "undo"]:
		_version += 1

func update_world(data: Dictionary) -> void:
	_last_state = data
	var fingerprint: Array = [data["config"].duplicate(true), data["day"], data["sandbox"]["dabs"],
		data["births"], data["deaths"], data["introduced"], data["paused"], data["speed"]]
	if fingerprint != _fingerprint:
		_version += 1
		_fingerprint = fingerprint
	var info: Dictionary = data.get("autosaves", {})
	_update_records(info)
	if _save_ack:
		_save_ack = false
		_saving = false
		_saved_version = _version
		_status_error = ""
	if _phase == "initial":
		_phase = "checking"
		command_requested.emit("control", {"paused": true})
		command_requested.emit("autosave_info", {"directory": directory})
	elif _phase == "info_ready":
		if _records.is_empty():
			_finish_startup(true)
		else:
			_open_choice(_records[0], true)
	elif _phase == "recovered":
		_saved_version = _version
		_status_error = ""
		_finish_startup(false)
	if _refresh_choice:
		_refresh_choice = false
		_choice = _records[0].duplicate(true) if not _records.is_empty() else {}
		_update_dialog()
	if _phase == "checking":
		_status.text = "Проверяем автокопии. Мир на паузе…"
	elif not _status_error.is_empty():
		_status.text = _status_error
	elif not info.get("warnings", []).is_empty():
		_status.text = "Повреждённые/недоступные слоты пропущены:\n" + "\n".join(info["warnings"])
	elif not _records.is_empty():
		_status.text = "Последняя копия: день %.2f · живых %d\n%s\nКаталог: %s" % [_records[0]["day"], _records[0]["population"], _records[0]["utc"], directory]
	else:
		_status.text = "Автокопий пока нет.\nКаталог: " + directory
	set_available(_available)

func _update_records(info: Dictionary) -> void:
	var selected_generation := -1
	if _slots.selected >= 0:
		selected_generation = int(_slots.get_item_metadata(_slots.selected))
	var records: Array = info.get("records", [])
	if records != _records:
		_slots.clear()
		_records = records.duplicate(true)
		for record: Dictionary in _records:
			var index := _slots.item_count
			_slots.add_item("Копия %d · день %.2f · %d живых" % [record["generation"], record["day"], record["population"]])
			_slots.set_item_metadata(index, int(record["generation"]))
			if int(record["generation"]) == selected_generation:
				_slots.select(index)

func request_restore() -> void:
	if not session_ready or not _available or _slots.selected < 0:
		return
	_open_choice(_records[_slots.selected], false)

func _open_choice(record: Dictionary, startup: bool) -> void:
	_choice = record.duplicate(true)
	_startup_choice = startup
	_was_paused = bool(_last_state.get("paused", true))
	session_ready = false
	_phase = "choosing"
	set_available(_available)
	readiness_changed.emit()
	if not startup:
		command_requested.emit("control", {"paused": true})
	_update_dialog()
	_dialog.popup_centered()

func _update_dialog() -> void:
	_dialog.cancel_button_text = "Новый мир" if _startup_choice else "Отмена"
	_dialog.get_ok_button().disabled = _choice.is_empty()
	if _choice.is_empty():
		_dialog.dialog_text = "Исправных копий не найдено.\nТекущий мир не заменён."
	else:
		_dialog.dialog_text = "%s\nКопия %d · день %.2f · живых %d · семя %d\n%s\nВосстановление заменит текущий мир и включит паузу.\n%s" % ["Найден сохранённый прогресс." if _startup_choice else "Восстановить выбранный прогресс?", _choice["generation"], _choice["day"], _choice["population"], _choice["seed"], _choice["utc"], _status_error]

func _confirm_restore() -> void:
	if _choice.is_empty():
		return
	_phase = "restoring"
	command_requested.emit("recover", {"directory": directory, "slot": int(_choice["slot"]), "generation": int(_choice["generation"])})

func _cancel_restore() -> void:
	_finish_startup(_startup_choice or not _was_paused)

func _finish_startup(resume: bool) -> void:
	_phase = "ready"
	session_ready = true
	has_user_world = true
	_elapsed = 0.0
	readiness_changed.emit()
	if resume:
		command_requested.emit("control", {"paused": false})
