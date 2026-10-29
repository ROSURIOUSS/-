extends RefCounted
## Shared projection for terrain, agents, camera picking, and habitat decorations.
const RADIUS: float = 6.0
const RELIEF: float = 0.65
var heights: Array = []
var width: int = 80
var height: int = 48
var sea: float = 0.42
var _north_height: float = 0.42
var _south_height: float = 0.42

func configure(data: Dictionary) -> void:
	width = int(data["width"])
	height = int(data["height"])
	sea = float(data["config"]["sea_level"])
	heights = data["elevation"]
	_north_height = 0.0
	_south_height = 0.0
	for x in range(width):
		_north_height += float(heights[x]) / width
		_south_height += float(heights[(height - 1) * width + x]) / width

static func direction(uv: Vector2) -> Vector3:
	var longitude := (uv.x - 0.5) * TAU
	var latitude := (0.5 - uv.y) * PI
	return Vector3(cos(latitude) * sin(longitude), sin(latitude), cos(latitude) * cos(longitude))

static func coordinates(point: Vector3) -> Vector2:
	var n := point.normalized()
	return Vector2(fposmod(atan2(n.x, n.z) / TAU + 0.5, 1.0), 0.5 - asin(clampf(n.y, -1, 1)) / PI)

func sample(uv: Vector2) -> float:
	if heights.is_empty():
		return sea
	var x := fposmod(uv.x, 1.0) * width - 0.5
	var y := clampf(uv.y, 0, 1) * height - 0.5
	var x0 := floori(x)
	var y0 := floori(y)
	var a: float = float(heights[clampi(y0, 0, height - 1) * width + posmod(x0, width)])
	var b: float = float(heights[clampi(y0, 0, height - 1) * width + posmod(x0 + 1, width)])
	var c: float = float(heights[clampi(y0 + 1, 0, height - 1) * width + posmod(x0, width)])
	var d: float = float(heights[clampi(y0 + 1, 0, height - 1) * width + posmod(x0 + 1, width)])
	var interpolated := lerpf(lerpf(a, b, x - floor(x)), lerpf(c, d, x - floor(x)), y - floor(y))
	# All longitudes meet at a pole: collapse the cap to one radius, not spikes.
	var blend := smoothstep(0.0, 1.0 / height, minf(uv.y, 1.0 - uv.y))
	return lerpf(_north_height if uv.y < 0.5 else _south_height, interpolated, blend)

func radius(uv: Vector2) -> float:
	return RADIUS + maxf(0, sample(uv) - sea) * RELIEF

func point(uv: Vector2, lift: float = 0.0) -> Vector3:
	return direction(uv) * (radius(uv) + lift)

func make_mesh() -> ArrayMesh:
	const LONGITUDES := 192
	const LATITUDES := 112
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	for y in range(LATITUDES + 1):
		for x in range(LONGITUDES + 1):
			var uv := Vector2(float(x) / LONGITUDES, float(y) / LATITUDES)
			vertices.append(point(uv))
			uvs.append(uv)
			var east := point(uv + Vector2(0.001, 0)) - point(uv - Vector2(0.001, 0))
			var south := point(Vector2(uv.x, minf(0.9999, uv.y + 0.001))) - point(Vector2(uv.x, maxf(0.0001, uv.y - 0.001)))
			var normal := south.cross(east)
			normals.append(normal.normalized() if normal.length_squared() > 0.00000001 else direction(uv))
	for y in range(LATITUDES):
		for x in range(LONGITUDES):
			var a: int = y * (LONGITUDES + 1) + x
			var b: int = a + LONGITUDES + 1
			indices.append_array(PackedInt32Array([a, a + 1, b, a + 1, b + 1, b]))
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh

func pick(origin: Vector3, ray: Vector3) -> Variant:
	var sphere_radius := RADIUS
	var hit := Vector3.ZERO
	for _iteration in range(6):
		var b := origin.dot(ray)
		var c := origin.length_squared() - sphere_radius * sphere_radius
		var discriminant := b * b - c
		if discriminant < 0:
			return null
		var distance := -b - sqrt(discriminant)
		if distance < 0:
			return null
		hit = origin + ray * distance
		var uv := coordinates(hit)
		sphere_radius = radius(uv)
	return coordinates(hit)
