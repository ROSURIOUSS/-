/** Engine-independent controller, not an installed mod.
 * Adapters provide atomic take(resource) and put(cell, record) operations.
 * A failed operation MUST leave the world unchanged. */
const MAX_CAPACITY = 1000000;
const PHASES = new Set(['mining', 'delivering', 'unloading']);
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be ${min}..${max}`);
  return value;
}
function position(value) {
  if (!value || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y))
    throw new TypeError('Select an integer cell position');
  return { x: value.x, y: value.y };
}
function resourceId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new TypeError('Select a resource');
  return value;
}
function cloneRecord(record, resource) {
  if (!record || record.resource !== resource) throw new Error('Invalid adapter record');
  // Cargo must round-trip through JSON without dropping or altering data.
  const text = JSON.stringify(record);
  if (!text || text.length > 65536) throw new Error('Invalid cargo record size');
  const parsed = JSON.parse(text);
  // The adapter owns full fidelity; reject obviously non-JSON payloads.
  function check(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      Object.values(value).forEach(check); return;
    }
    throw new TypeError('Cargo must contain only JSON-safe data');
  }
  check(record);
  return parsed;
}
export class ResourceBot {
  constructor(adapter, { capacity = 10000, batchSize = 64, worldId = 'unbound' } = {}) {
    for (const name of ['take', 'moveTo', 'put'])
      if (typeof adapter?.[name] !== 'function') throw new TypeError(`Missing adapter.${name}`);
    if (typeof worldId !== 'string' || !worldId || worldId.length > 256) throw new TypeError('Invalid worldId');
    this.adapter = adapter;
    this.capacity = integer(capacity, 1, MAX_CAPACITY, 'capacity');
    this.batchSize = integer(batchSize, 1, 1024, 'batchSize');
    this.worldId = worldId;
    this.cargo = [];
    this.resource = null;
    this.destination = null;
    this.phase = 'stopped';
    this.resumePhase = 'mining';
    this.busy = false;
  }
  configure({ resource = this.resource, destination = this.destination, capacity = this.capacity } = {}) {
    if (this.phase !== 'stopped' || this.busy) throw new Error('Stop before configuring');
    resourceId(resource);
    const cell = position(destination);
    integer(capacity, 1, MAX_CAPACITY, 'capacity');
    if (capacity < this.cargo.length) throw new Error('Capacity cannot be smaller than current cargo');
    if (this.cargo.length && resource !== this.resource) throw new Error('Unload cargo before switching resource');
    this.resource = resource;
    this.destination = cell;
    this.capacity = capacity;
    this.resumePhase = this.cargo.length ? 'delivering' : 'mining';
  }
  start() {
    if (this.busy) throw new Error('Cannot start inside an adapter callback');
    if (!this.resource || !this.destination) throw new Error('Configure first');
    if (this.phase !== 'stopped') return;
    this.phase = this.cargo.length ? 'delivering' : this.resumePhase;
  }
  stop() {
    if (this.phase !== 'stopped') this.resumePhase = this.phase;
    this.phase = 'stopped';
  }
  tick() {
    if (this.busy) throw new Error('Reentrant tick');
    if (this.phase === 'stopped') return;
    this.busy = true;
    try {
      if (this.phase === 'mining') {
        let exhausted = false;
        for (let i = 0; i < this.batchSize && this.cargo.length < this.capacity && this.phase === 'mining'; i++) {
          const record = this.adapter.take(this.resource);
          if (record === null) { exhausted = true; break; }
          // Keep custody even if validation detects an adapter contract violation.
          this.cargo.push(record);
          this.cargo[this.cargo.length - 1] = cloneRecord(record, this.resource);
        }
        if (this.phase === 'mining' && this.cargo.length && (exhausted || this.cargo.length === this.capacity))
          this.phase = 'delivering';
        return;
      }
      if (this.phase === 'delivering') {
        const arrived = this.adapter.moveTo({ ...this.destination });
        if (this.phase === 'delivering' && arrived === true) this.phase = 'unloading';
        return;
      }
      if (this.phase === 'unloading') {
        for (let i = 0; i < this.batchSize && this.cargo.length && this.phase === 'unloading'; i++) {
          const record = cloneRecord(this.cargo[this.cargo.length - 1], this.resource);
          if (this.adapter.put({ ...this.destination }, record) !== true) break;
          this.cargo.pop();
        }
        if (this.phase === 'unloading' && !this.cargo.length) this.phase = 'mining';
      }
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  snapshot() {
    if (this.busy) throw new Error('Cannot snapshot during a world mutation');
    return { version: 1, worldId: this.worldId, resource: this.resource,
      destination: this.destination && { ...this.destination }, capacity: this.capacity,
      batchSize: this.batchSize, cargo: this.cargo.map(record => cloneRecord(record, this.resource)),
      phase: this.phase, resumePhase: this.resumePhase };
  }
  /** Validate everything before exposing a bot. Restored bots always start stopped.
   * This does NOT atomically restore the game world: integration must restore both. */
  static restore(adapter, data, { worldId } = {}) {
    if (!data || data.version !== 1) throw new Error('Unsupported snapshot version');
    if (!worldId || data.worldId !== worldId) throw new Error('Snapshot belongs to a different world');
    if (data.phase !== 'stopped' && !PHASES.has(data.phase)) throw new Error('Invalid phase');
    if (!PHASES.has(data.resumePhase)) throw new Error('Invalid resume phase');
    const bot = new ResourceBot(adapter, { capacity: data.capacity, batchSize: data.batchSize, worldId });
    if (!Array.isArray(data.cargo) || data.cargo.length > bot.capacity) throw new Error('Invalid cargo size');
    if (data.resource === null && data.destination === null && data.cargo.length === 0 && data.phase === 'stopped') return bot;
    bot.configure({ resource: data.resource, destination: data.destination });
    bot.cargo = data.cargo.map(record => cloneRecord(record, data.resource));
    bot.resumePhase = bot.cargo.length ? 'delivering' : 'mining';
    return bot;
  }
}
