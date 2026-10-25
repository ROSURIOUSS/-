#!/usr/bin/env python3
"""Render an offline schematic from a Sandustry export. Never writes the save.
Dependencies: numpy, Pillow. Coordinates in grid cells, not game world pixels.
Native terrain/material colors are schematic unless identified below.
"""
import argparse, gzip, json, re, hashlib
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def decode_runs(runs, width, height):
    if len(runs) % 2:
        raise ValueError('Odd RLE length')
    grid = np.empty(width * height, dtype=np.int32)
    offset = 0
    for value, count in zip(runs[::2], runs[1::2]):
        if type(count) is not int or count < 1 or offset + count > grid.size:
            raise ValueError('Invalid RLE count')
        if isinstance(value, dict):
            code = 100 + int(value['type'])
        elif type(value) is int:
            # Legacy save encoding for damaged terrain: -(terrainId*10000 + hp).
            code = (-value) // 10000 if value < 0 else value
        else:
            raise ValueError('Unknown matrix record')
        grid[offset:offset + count] = code
        offset += count
    if offset != grid.size:
        raise ValueError(f'RLE size mismatch: {offset} != {grid.size}')
    return grid.reshape(height, width)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('save')
    parser.add_argument('output')
    args = parser.parse_args()
    source = Path(args.save)
    original = source.read_bytes()
    metadata, compressed = original.split(b'\n', 1)
    meta = json.loads(metadata)
    data = json.loads(gzip.decompress(compressed))
    store = data['store']
    w, h = (store['world']['size'][k] for k in ['width', 'height'])
    grid = decode_runs(data['matrix'], w, h)
    # Fog is a placeholder for an empty cavern, water, or lava in the game's matrix.
    # Do not apply mods.map.fogBuffer: it is the exploration visibility overlay.
    cave = (13, 23, 34)
    colors = {0: cave, 1: cave, 2:(146,111,68),3:(83,112,62),
        4:cave,5:cave,6:(46,132,207),7:(161,202,217),8:(133,93,57),
        9:(93,168,77),10:(71,142,67),11:(210,177,66),12:(127,153,85),
        13:(241,99,43),14:(174,100,228),15:(199,184,119),16:(199,184,119),
        17:(199,184,119),18:(199,184,119),19:(199,184,119),20:(199,184,119),
        21:(199,184,119),22:(199,184,119),23:(113,132,148),24:(199,184,119),
        25:(154,213,230),26:(199,184,119),27:(46,132,207),28:(128,147,81),
        29:(81,65,94),30:(116,97,113),101:(218,192,124),103:(46,132,207),
        104:(148,130,81),107:(242,209,71),110:(142,180,192),111:(246,148,65),
        112:(164,217,233),113:(246,148,65),119:(241,99,43),120:(84,70,85)}
    rgb = np.empty((h,w,3),dtype=np.uint8)
    for code in np.unique(grid):
        code = int(code)
        # Native material IDs are preserved spatially but not labeled as known ores.
        default = (93 + (code*13)%44, 98 + (code*19)%43, 106 + (code*7)%45)
        rgb[grid==code] = colors.get(code, default)
    # Draw all structures at recorded cells, independent of exploration visibility.
    for s in store.get('structures',[]):
        x,y=int(s['x']),int(s['y'])
        if 0<=x<w and 0<=y<h:
            rgb[y,x]=(212,189,119)
    map_image = Image.fromarray(rgb)
    margin, top, bottom = 128, 230, 300
    canvas=Image.new('RGB',(w+2*margin,h+top+bottom),(9,16,25))
    canvas.paste(map_image,(margin,top))
    draw=ImageDraw.Draw(canvas)
    fontpath='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    boldpath='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    def font(size,bold=False): return ImageFont.truetype(boldpath if bold else fontpath,size)
    draw.text((margin,40),'SANDUSTRY / ПОЛНАЯ КАРТА',font=font(48,True),fill='#f0e4b9')
    draw.text((margin,112),f'{meta["worldName"]}    ·    Сид {meta["seed"]}    ·    {w} × {h} клеток',font=font(30),fill='#c0d1df')
    draw.text((margin,163),'Схема из сохранения · без маски исследования · не игровой скриншот',font=font(26),fill='#829aaa')
    # Subtle coordinate grid, labeled in cells. y grows downward as in the save.
    overlay=Image.new('RGBA',canvas.size,(0,0,0,0)); od=ImageDraw.Draw(overlay)
    for x in range(0,w,512):
        od.line((margin+x,top,margin+x,top+h),fill=(192,216,239,28),width=1)
        draw.text((margin+x,top-40),str(x),font=font(22),fill='#8fa9bb')
    for y in range(0,h,512):
        od.line((margin,top+y,margin+w,top+y),fill=(192,216,239,28),width=1)
        draw.text((18,top+y),str(y),font=font(22),fill='#8fa9bb')
    canvas=Image.alpha_composite(canvas.convert('RGBA'),overlay).convert('RGB');draw=ImageDraw.Draw(canvas)
    px,py=store['player']['x']/4,store['player']['y']/4
    cx,cy=margin+px,top+py
    draw.ellipse((cx-17,cy-17,cx+17,cy+17),fill='#101b28',outline='#ffec84',width=4)
    draw.ellipse((cx-5,cy-5,cx+5,cy+5),fill='#ffec84')
    label=f'ТЫ В СЕЙВЕ  ({px:.0f}, {py:.0f})'
    draw.line((cx+18,cy,cx+65,cy-45),fill='#ffec84',width=3)
    bbox=draw.textbbox((cx+75,cy-70),label,font=font(25,True))
    draw.rectangle((bbox[0]-12,bbox[1]-9,bbox[2]+12,bbox[3]+9),fill='#101b28')
    draw.text((cx+75,cy-70),label,font=font(25,True),fill='#ffec84')
    base=top+h+40
    legend=[('Пустоты и пещеры',cave),('Грунт',(146,111,68)),('Камень',(113,132,148)),
        ('Вода',(46,132,207)),('Лёд',(154,213,230)),('Лава',(241,99,43)),('Постройки',(212,189,119))]
    lx=margin
    for label,color in legend:
        draw.rectangle((lx,base,lx+25,base+25),fill=color)
        draw.text((lx+38,base-3),label,font=font(23),fill='#c0d1df')
        lx += int(draw.textlength(label,font=font(23)))+90
    draw.text((margin,base+64),'Геометрия — из матрицы сейва. Цвета условные; не все новые материалы определены.',font=font(26),fill='#91a7b8')
    draw.text((margin,base+108),'Тёмные полости — не туман. Детали, создаваемые при раскрытии, заранее не дорисованы.',font=font(26),fill='#91a7b8')
    draw.text((margin,base+152),f'Координаты: клетки, Y вниз. Снимок: {meta["timestamp"]} · Исходное сохранение не изменено.',font=font(24),fill='#71899c')
    Path(args.output).parent.mkdir(parents=True,exist_ok=True)
    canvas.save(args.output)
    assert source.read_bytes()==original
    print(json.dumps({'output':args.output,'size':canvas.size,'grid':[w,h],
        'source_sha256':hashlib.sha256(original).hexdigest(),'player_cell':[px,py],
        'rle_cells':int(grid.size)},ensure_ascii=False))

if __name__=='__main__': main()
