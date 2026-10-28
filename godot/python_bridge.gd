extends Node
## Local child-process IPC. No HTTP, TCP ports, browser, or remote services.

signal state_received(state: Dictionary)
signal command_finished(command: String, success: bool, message: String)
signal failed(message: String)

var is_ready: bool = false
var _pid: int = -1
var _stdio: FileAccess
var _stderr: FileAccess
var _buffer := PackedByteArray()
var _diagnostics: String = ""
var _queue: Array[Dictionary] = []
var _pending_id: int = -1
var _pending_command: String = ""
var _next_id: int = 1
var _elapsed: float = 0.0
var _waiting: float = 0.0
var _closing: bool = false
var _broken: bool = false

func start() -> void:
	_dispose()
	_closing = false
	_broken = false
	is_ready = false
	_buffer.clear()
	_queue.clear()
	_pending_id = -1
	_diagnostics = ""
	_elapsed = 0.0
	_waiting = 0.0
	var folder := OS.get_executable_path().get_base_dir()
	var binary := folder.path_join("core/biosphere-core.exe" if OS.get_name() == "Windows" else "core/biosphere-core")
	if FileAccess.file_exists(binary):
		_launch(binary, PackedStringArray())
		return
	var script := folder.path_join("core/simulator/worker.py")
	if OS.has_feature("editor"):
		script = ProjectSettings.globalize_path("res://../simulator/worker.py").simplify_path()
	if not FileAccess.file_exists(script):
		_fail("Не найдено Python-ядро. В исходниках папки godot и simulator должны лежать рядом. В сборке нужна папка core рядом с программой.")
		return
	var explicit := OS.get_environment("BIOSPHERE_PYTHON")
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--python="):
			explicit = argument.trim_prefix("--python=")
	var candidates: Array[Dictionary] = []
	if not explicit.is_empty():
		candidates.append({"path": explicit, "prefix": PackedStringArray()})
	elif OS.get_name() == "Windows":
		candidates.append({"path": "py", "prefix": PackedStringArray(["-3"])})
		candidates.append({"path": "python", "prefix": PackedStringArray()})
	else:
		candidates.append({"path": "python3", "prefix": PackedStringArray()})
		candidates.append({"path": "python", "prefix": PackedStringArray()})
	for candidate: Dictionary in candidates:
		var prefix: PackedStringArray = candidate["prefix"]
		var output: Array = []
		var check := prefix + PackedStringArray(["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"])
		if OS.execute(str(candidate["path"]), check, output, true, false) == 0:
			_launch(str(candidate["path"]), prefix + PackedStringArray(["-u", script]))
			return
	_fail("Не найден Python 3.11 или новее. Установите Python и перезапустите ядро. Если он уже установлен, задайте путь через BIOSPHERE_PYTHON или --python=полный_путь.")

func _launch(executable: String, arguments: PackedStringArray) -> void:
	var process := OS.execute_with_pipe(executable, arguments, false)
	if process.is_empty():
		_fail("Не удалось запустить ядро: " + executable)
		return
	_pid = int(process["pid"])
	_stdio = process["stdio"]
	_stderr = process["stderr"]

func submit(command: String, data: Dictionary = {}) -> void:
	if not is_ready or _closing or _broken:
		command_finished.emit(command, false, "Ядро ещё не готово.")
		return
	if _queue.size() >= 32:
		command_finished.emit(command, false, "Слишком много команд. Дождитесь завершения предыдущих.")
		return
	_queue.append({"command": command, "data": data})

func _process(delta: float) -> void:
	if _pid < 0 or _broken:
		return
	if _stderr != null:
		var errors := _stderr.get_buffer(8192)
		if not errors.is_empty():
			_diagnostics = (_diagnostics + errors.get_string_from_utf8()).right(4000)
	# Non-blocking pipes: get_buffer returns only bytes already available.
	for _attempt in range(8):
		var chunk := _stdio.get_buffer(65536)
		if chunk.is_empty():
			break
		_buffer.append_array(chunk)
	if _buffer.size() > 2 * 1024 * 1024:
		_fail("Ответ ядра превышает допустимый размер.")
		return
	var newline := _buffer.find(10)
	while newline >= 0:
		var line := _buffer.slice(0, newline).get_string_from_utf8()
		_buffer = _buffer.slice(newline + 1)
		_receive(line)
		if _broken:
			return
		newline = _buffer.find(10)
	if _closing:
		return
	if not OS.is_process_running(_pid):
		_fail("Python-ядро завершилось. " + _diagnostics)
		return
	_waiting += delta
	if (not is_ready and _waiting > 45.0) or (_pending_id >= 0 and _waiting > 30.0):
		_fail("Ядро не отвечает. " + _diagnostics)
		return
	_elapsed += delta
	if not is_ready or _pending_id >= 0:
		return
	if not _queue.is_empty():
		var request: Dictionary = _queue.pop_front()
		_send(str(request["command"]), request["data"])
	elif _elapsed >= 0.1:
		_elapsed = 0.0
		_send("step", {})

func _send(command: String, data: Dictionary) -> void:
	_pending_id = _next_id
	_next_id += 1
	_pending_command = command
	_waiting = 0.0
	var line := JSON.stringify({"id": _pending_id, "command": command, "data": data}) + "\n"
	var bytes := line.to_utf8_buffer()
	if bytes.size() > 4096:
		_pending_id = -1
		command_finished.emit(command, false, "Слишком большой запрос.")
		return
	if not _stdio.store_buffer(bytes):
		_fail("Не удалось передать команду Python-ядру.")

func _receive(line: String) -> void:
	var packet = JSON.parse_string(line)
	if not packet is Dictionary:
		_fail("Повреждённый ответ Python-ядра.")
		return
	if packet.get("type") == "ready":
		if packet.get("protocol") != 2:
			_fail("Несовместимая версия Python-ядра. Обновите папку core или пересоберите программу из текущих исходников.")
			return
		is_ready = true
		_waiting = 0.0
		_queue.push_front({"command": "state", "data": {}})
		return
	if _closing:
		return
	if packet.get("id") == null or int(packet["id"]) != _pending_id:
		_fail("Нарушен порядок ответов Python-ядра.")
		return
	var command := _pending_command
	_pending_id = -1
	var success: bool = packet.get("ok", false) == true
	var message: String = str(packet.get("message", "")) if success else str(packet.get("error", "Ошибка ядра"))
	command_finished.emit(command, success, message)
	if success and packet.get("state") is Dictionary:
		state_received.emit(packet["state"])

func shutdown() -> void:
	_closing = true
	is_ready = false
	_queue.clear()
	if _stdio != null and _pid >= 0 and OS.is_process_running(_pid):
		_stdio.store_line(JSON.stringify({"id": _next_id, "command": "quit"}))
		var deadline := Time.get_ticks_msec() + 2000
		while OS.is_process_running(_pid) and Time.get_ticks_msec() < deadline:
			await get_tree().process_frame
	_dispose()

func _fail(message: String) -> void:
	_broken = true
	is_ready = false
	_dispose()
	failed.emit(message)

func _dispose() -> void:
	if _pid >= 0 and OS.is_process_running(_pid):
		OS.kill(_pid)
	_pid = -1
	if _stdio != null:
		_stdio.close()
		_stdio = null
	if _stderr != null:
		_stderr.close()
		_stderr = null

func _exit_tree() -> void:
	_dispose()
