#!/usr/bin/env python3
"""Offline, copy-only editor for the inspected Sandustry 0.6.0 export.
Adds three gulper entities under verified empty ceilings. No game code is executed.
"""
import argparse
import bisect
import copy
import gzip
import hashlib
import json
import math
from pathlib import Path
import secrets

class Matrix:
    def __init__(self, runs, width, height):
        self.width, self.height = width, height
        self.ends, self.values = [], []
        total = 0
        if len(runs) % 2: raise ValueError('Invalid matrix')
        for value, count in zip(runs[::2], runs[1::2]):
            if type(count) is not int or count <= 0: raise ValueError('Invalid RLE')
            total += count
            self.ends.append(total)
            self.values.append(value)
        if total != width * height: raise ValueError('Wrong matrix dimensions')
    def at(self, x, y):
        if not (0 <= x < self.width and 0 <= y < self.height): return None
        return self.values[bisect.bisect_right(self.ends, y * self.width + x)]

class Authorization:
    def __init__(self, data, width, height):
        if data['width'] != width or data['height'] != height: raise ValueError('Wrong authorization dimensions')
        self.columns = math.ceil(width / 16)
        self.sections = data['sections']
        self.indices = []
        for value, count in zip(data['data'][::2], data['data'][1::2]):
            self.indices.extend([value] * count)
        if len(self.indices) != self.columns * math.ceil(height / 16): raise ValueError('Invalid authorization')
    def at(self, x, y):
        section = self.indices[(y // 16) * self.columns + x // 16]
        return self.sections[section][(y % 16) * 16 + x % 16]


def find_ceilings(data, count=3):
    store = data['store']
    w, h = (store['world']['size'][key] for key in ['width', 'height'])
    grid = Matrix(data['matrix'], w, h)
    auth = Authorization(data['authorization'], w, h)
    structures = {(s['x'], s['y']) for s in store['structures']}
    player = store['player']
    px, py = player['x'] / 4, player['y'] / 4
    candidates = []
    # Only known natural, solid terrain IDs. Never use fog, fluids or a building as roof.
    for y in range(max(1, int(py)-150), min(h-8, int(py)+151)):
        for x in range(max(3, int(px)-150), min(w-4, int(px)+151)):
            if grid.at(x, y) not in (2, 7, 23, 25, 28, 29, 30): continue
            if any(grid.at(xx, yy) != 0 or auth.at(xx, yy) != 0 or (xx, yy) in structures
                   for yy in range(y+1, y+8) for xx in range(x-3, x+4)): continue
            wx, wy = x*4+2, (y+1)*4+8
            # Avoid overlapping player or other existing creatures.
            if abs(wx-player['x']) < 28 and abs(wy-player['y']) < 44: continue
            if any((entity['x']-wx)**2 + (entity['y']-wy)**2 < 24**2
                   for entity in store['mods']['entities']['list']): continue
            candidates.append(((x-px)**2 + (y+3-py)**2, x, y))
    chosen = []
    for _, x, y in sorted(candidates):
        if all((x-a)**2 + (y-b)**2 >= 36 for a,b in chosen): chosen.append((x,y))
        if len(chosen) == count: return chosen
    raise ValueError('Not enough safe nearby ceilings; no save written')


def patch(metadata, data, world_id):
    if data['store']['version'] != '0.6.0': raise ValueError('Only inspected version 0.6.0 is supported')
    if world_id == data['store']['meta']['worldId']: raise ValueError('Copy requires a NEW world ID')
    positions = find_ceilings(data)
    result, header = copy.deepcopy(data), copy.deepcopy(metadata)
    store = result['store']
    entities = store['mods']['entities']
    ids = [e['id'] for e in entities['list']]
    if len(ids) != len(set(ids)): raise ValueError('Duplicate existing entity IDs')
    next_id = max(entities.get('nextId', 1), max(ids, default=0)+1)
    added = []
    for i, (x, y) in enumerate(positions):
        wx, wy = x*4+2, (y+1)*4+8
        # Common entity fields from Sandkit's registration adapter + jE.spawn/normalize.
        entity = dict(id=next_id+i, type='gulper', x=wx, y=wy, vx=0, vy=0,
            targetX=wx, targetY=wy, targetTimer=0, phase=i*2.0943951023931953,
            maxSpeed=0, particleAccum=0, age=0,
            motionState=1, hopTimer=0.7, breathTimer=3+i*0.5,
            facing=-1 if i%2 else 1, rotationRadians=0, gulpPulseTimer=0,
            petBoostTimer=0, petHeartFadeTimer=0, petPlayerOverlapping=False)
        entities['list'].append(entity)
        added.append({'entity_id':entity['id'], 'world_pixels':[wx,wy],
            'cell':[wx/4,wy/4], 'ceiling_cell':[x,y]})
    entities['nextId'] = next_id + len(added)
    name = metadata['worldName'] + ' — Oxyblob (копия)'
    header.update(id=world_id+'-exitsave', worldId=world_id, worldName=name,
                  name='Тест: добавлены 3 Oxyblob')
    store['meta'].update(worldId=world_id, worldName=name)
    validate_changes(metadata, data, header, result, added)
    return header, result, added


def validate_changes(old_header, old, header, new, added):
    expected = copy.deepcopy(old)
    expected['store']['meta']['worldId'] = new['store']['meta']['worldId']
    expected['store']['meta']['worldName'] = new['store']['meta']['worldName']
    before = old['store']['mods']['entities']
    after = new['store']['mods']['entities']
    assert after['list'][:len(before['list'])] == before['list']
    assert len(after['list']) == len(before['list']) + 3
    assert all(e['type']=='gulper' for e in after['list'][-3:])
    expected['store']['mods']['entities']['list'].extend(after['list'][-3:])
    expected['store']['mods']['entities']['nextId'] = after['nextId']
    assert expected == new, 'Unexpected change to original world data'
    permitted_header = copy.deepcopy(old_header)
    for key in ['id','worldId','worldName','name']: permitted_header[key] = header[key]
    assert permitted_header == header
    assert len({e['id'] for e in after['list']}) == len(after['list'])
    assert after['nextId'] > max(e['id'] for e in after['list'])
    assert header['worldId'] == new['store']['meta']['worldId'] != old_header['worldId']


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('source'); parser.add_argument('output')
    parser.add_argument('--expected-md5', required=True)
    args=parser.parse_args()
    source, output=Path(args.source), Path(args.output)
    if source.resolve()==output.resolve(): raise ValueError('Never overwrite the source')
    original=source.read_bytes()
    if hashlib.md5(original).hexdigest()!=args.expected_md5: raise ValueError('Wrong source file')
    head, compressed=original.split(b'\n',1)
    old_header=json.loads(head); old=json.loads(gzip.decompress(compressed))
    world_id='oxy'+secrets.token_hex(4)
    header, new, added=patch(old_header,old,world_id)
    content=json.dumps(header,ensure_ascii=False,separators=(',',':')).encode()+b'\n'+gzip.compress(
        json.dumps(new,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode(),mtime=0)
    # Round-trip and exhaustive comparison before creating the deliverable.
    h,b=content.split(b'\n',1)
    validate_changes(old_header,old,json.loads(h),json.loads(gzip.decompress(b)),added)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('xb') as file: file.write(content)
    assert source.read_bytes()==original
    print(json.dumps({'source_md5':args.expected_md5,'output':str(output),
        'output_sha256':hashlib.sha256(content).hexdigest(),'world_id':world_id,
        'world_name':header['worldName'],'added':added,'original_unchanged':True},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
