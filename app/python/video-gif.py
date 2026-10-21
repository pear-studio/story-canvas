"""从冻结原片制作 GIF 和裁剪首帧；在最终播放时间轴上取样，不插帧。"""
import sys
import json
import math
from pathlib import Path
from PIL import Image
from video_processing import read_video, require_new_target

source, target, poster, metadata = map(Path, sys.argv[1:5])
require_new_target(source, target)
frames, rate = read_video(source, json.loads(sys.argv[5]))
fps = float(rate)
duration = len(frames) / fps
frames[0].to_image().save(poster)
# GIF 的单位是 10ms。均匀分配舍入误差，避免末尾留下 <=10ms 的短帧。
ticks = round(duration * 100)
if ticks < 2:
    raise ValueError('片段不足 20ms，GIF 无法保证播放时长，请保留更多帧或降低倍率')
count = max(1, min(round(duration * min(12, fps)), ticks // 2))
indices = [min(len(frames) - 1, math.floor(i * len(frames) / count)) for i in range(count)]
images = []
for index in indices:
    image = frames[index].to_image().convert('RGB')
    if image.width > 480:
        image = image.resize((480, max(1, round(image.height * 480 / image.width))), Image.Resampling.LANCZOS)
    images.append(image)
# 一个全局色盘；无抖动，减少噪点和文件体积。
tiles = Image.new('RGB', (32 * min(32, count), 32 * math.ceil(count / 32)))
for i, image in enumerate(images):
    tiles.paste(image.resize((32, 32)), ((i % 32) * 32, (i // 32) * 32))
palette = tiles.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
quantized = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
delays = [(round((i + 1) * ticks / count) - round(i * ticks / count)) * 10 for i in range(count)]
quantized[0].save(target, format='GIF', save_all=True, append_images=quantized[1:], duration=delays,
                  loop=0, disposal=1, optimize=True)
with Image.open(target) as encoded:
    actual_count, actual_ms = encoded.n_frames, 0
    for i in range(actual_count):
        encoded.seek(i)
        encoded.load()
        delay = encoded.info.get('duration', 0)
        if delay <= 10:
            raise ValueError('GIF 编码产生无法正确播放的短帧')
        actual_ms += delay
    if actual_ms != ticks * 10:
        raise ValueError('GIF 编码后的时长不符')
    gif = dict(width=encoded.width, height=encoded.height, encoded_frames=actual_count,
               duration_seconds=actual_ms / 1000, bytes=target.stat().st_size)
warnings = []
if gif['bytes'] > 16 * 1024 * 1024:
    warnings.append('GIF 超过 16 MB，发布前请检查平台文件限制')
if actual_count > 500:
    warnings.append('GIF 超过 500 帧，发布前请检查平台帧数限制')
metadata.write_text(json.dumps(dict(width=frames[0].width, height=frames[0].height, frames=len(frames),
                                  fps=fps, duration_seconds=duration, gif=gif, warnings=warnings)), encoding='utf-8')
