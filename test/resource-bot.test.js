import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceBot } from '../src/resource-bot.js';
function fixture(options) {
  const source = Array.from({length: 15}, (_, id) => ({ resource: 'sand', id, temperature: 20 }));
  const output = [];
  const adapter = {
    take: () => source.pop() ?? null,
    moveTo: () => true,
    put: (_, record) => { output.push(record); return true; },
  };
  const bot = new ResourceBot(adapter, options);
  bot.configure({resource: 'sand', destination: {x: 5, y: 6}});
  return {bot, adapter, source, output};
}
test('requires configuration and validates limits', () => {
  assert.throws(() => new ResourceBot({}, {capacity: -1}));
  const {adapter} = fixture();
  assert.throws(() => new ResourceBot(adapter).start(), /Configure first/);
});
test('conserves resources and metadata over multiple deliveries', () => {
  const {bot, source, output} = fixture({capacity: 5, batchSize: 2});
  bot.start();
  for (let i=0;i<30;i++) bot.tick();
  assert.equal(source.length, 0);
  assert.equal(output.length, 15);
  assert.equal(new Set(output.map(r=>r.id)).size, 15);
  assert.ok(output.every(r=>r.temperature===20));
});
test('blocked unload retains cargo, stopping never discards it', () => {
  const {bot, adapter, source} = fixture({capacity: 5});
  adapter.put = () => false;
  bot.start(); bot.tick();
  assert.equal(bot.cargo.length, 5);
  assert.equal(source.length, 10);
  bot.stop(); bot.tick();
  assert.equal(bot.cargo.length, 5);
  assert.throws(() => bot.configure({resource:'gold'}));
  bot.start(); bot.tick();
  assert.equal(bot.cargo.length, 5);
});
test('travel delays unloading', () => {
  const {bot, adapter, output} = fixture({capacity: 5});
  adapter.moveTo = () => false;
  bot.start(); bot.tick();
  assert.equal(bot.phase, 'delivering');
  assert.equal(output.length, 0);
});
test('snapshot does not expose mutable cargo', () => {
  const {bot, adapter} = fixture({capacity: 5});
  adapter.moveTo = () => false;
  bot.start(); bot.tick();
  const copy = bot.snapshot(); copy.cargo[0].temperature = 999;
  assert.equal(bot.cargo[0].temperature, 20);
});
test('adapter errors stop controller without discarding cargo', () => {
  const {bot, adapter} = fixture({capacity: 5});
  adapter.put = () => { throw new Error('blocked'); };
  bot.start(); bot.tick(); bot.tick(); assert.throws(() => bot.tick());
  assert.equal(bot.phase, 'stopped'); assert.equal(bot.cargo.length, 5);
});

test('JSON restore retains cargo and metadata, always stopped', () => {
  const {bot, adapter} = fixture({capacity: 5, worldId: 'test-world'});
  bot.start(); bot.tick();
  const restored = ResourceBot.restore(adapter, JSON.parse(JSON.stringify(bot.snapshot())), {worldId:'test-world'});
  assert.equal(restored.phase, 'stopped');
  assert.deepEqual(restored.cargo, bot.cargo);
  restored.start();
  assert.equal(restored.phase, 'delivering');
});
test('rejects cross-world, oversized and malformed snapshots before adapter calls', () => {
  const {bot, adapter} = fixture({capacity: 5, worldId:'test-world'});
  const data = bot.snapshot();
  assert.throws(() => ResourceBot.restore(adapter, data, {worldId:'another-world'}));
  assert.throws(() => ResourceBot.restore(adapter, {...data, cargo:Array(6).fill({resource:'sand'})}, {worldId:'test-world'}));
  assert.throws(() => ResourceBot.restore(adapter, {...data, phase:'bogus'}, {worldId:'test-world'}));
  assert.throws(() => ResourceBot.restore(adapter, {...data, version:2}, {worldId:'test-world'}));
});
test('capacity is configurable only when stopped and never below cargo size', () => {
  const {bot} = fixture({capacity:5});
  bot.configure({capacity:10}); bot.start();
  assert.throws(() => bot.configure({capacity:20}));
  bot.tick(); bot.stop();
  assert.throws(() => bot.configure({capacity:1}));
  bot.configure({capacity:20});
  assert.equal(bot.capacity,20);
});
test('failed put cannot mutate stored cargo or destination', () => {
  const {bot, adapter} = fixture({capacity:5});
  adapter.put = (cell, record) => { cell.x=900; record.temperature=999; return false; };
  bot.start(); bot.tick(); bot.tick(); bot.tick();
  assert.equal(bot.cargo[0].temperature,20);
  assert.deepEqual(bot.destination, {x:5,y:6});
});
test('stop inside take does not continue to movement or unloading', () => {
  const {bot, adapter} = fixture({capacity:5});
  const take=adapter.take;
  adapter.take = () => { bot.stop(); return take(); };
  bot.start(); bot.tick();
  assert.equal(bot.phase,'stopped'); assert.equal(bot.cargo.length,1);
});
test('reentrant ticks fail closed', () => {
  const {bot, adapter} = fixture();
  adapter.take = () => bot.tick();
  bot.start(); assert.throws(() => bot.tick(), /Reentrant/);
  assert.equal(bot.phase,'stopped');
});
test('unconfigured empty bot snapshot can be restored', () => {
  const {adapter} = fixture();
  const bot = new ResourceBot(adapter, {worldId:'test'});
  const restored = ResourceBot.restore(adapter, bot.snapshot(), {worldId:'test'});
  assert.equal(restored.resource,null);
  assert.equal(restored.phase,'stopped');
});
test('invalid adapter record remains in custody for diagnosis', () => {
  const {bot, adapter} = fixture();
  adapter.take = () => ({resource:'gold',id:99});
  bot.start(); assert.throws(() => bot.tick(), /Invalid adapter record/);
  assert.equal(bot.phase,'stopped'); assert.equal(bot.cargo.length,1);
});
