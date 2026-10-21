"""从 MP4 制作可重建 WebP，按可选页面后处理裁剪及调速，不放大画面。"""
import sys
import json
import struct
from pathlib import Path
from PIL import Image
from video_processing import read_video, require_new_target

source, target, limit = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
frames = []
require_new_target(source, target)
decoded, rate = read_video(source, json.loads(sys.argv[4]) if len(sys.argv) > 4 else {})
fps = float(rate)
for frame in decoded:
    image = frame.to_image()
    if image.width > limit:
        image = image.resize((limit, round(image.height * limit / image.width)), Image.Resampling.LANCZOS)
    frames.append(image)
if not frames or fps <= 0:
    raise ValueError('视频没有可解码帧或帧率无效')
durations = [round((i + 1) * 1000 / fps) - round(i * 1000 / fps) for i in range(len(frames))]
frames[0].save(target, format='WEBP', save_all=True, append_images=frames[1:],
               duration=durations, loop=0, lossless=False, quality=75 if limit == 320 else 80, method=4)
# 缓存自带原时间轴，WebP 合并重复帧后仍能按原片帧边界裁剪，无需再读 MP4。
# SCVT: uint32 帧数 + float64 fps，小端；浏览器忽略此自定义 RIFF 块。
with target.open('r+b') as output:
    output.seek(0, 2)
    output.write(b'SCVT' + struct.pack('<IId', 12, len(decoded), fps))
    size = output.tell()
    output.seek(4)
    output.write(struct.pack('<I', size - 8))
