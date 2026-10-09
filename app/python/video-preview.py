"""从原始 MP4 制作可重建的 WebP 预览，保持完整时间轴，不放大画面。"""
import sys
from pathlib import Path
import av
from PIL import Image

source, target, limit = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
frames = []
with av.open(str(source)) as container:
    stream = container.streams.video[0]
    fps = float(stream.average_rate)
    for frame in container.decode(stream):
        image = frame.to_image()
        if image.width > limit:
            image = image.resize((limit, round(image.height * limit / image.width)), Image.Resampling.LANCZOS)
        frames.append(image)
if not frames or fps <= 0:
    raise ValueError('视频没有可解码帧或帧率无效')
durations = [round((i + 1) * 1000 / fps) - round(i * 1000 / fps) for i in range(len(frames))]
frames[0].save(target, format='WEBP', save_all=True, append_images=frames[1:],
               duration=durations, loop=0, lossless=False, quality=75 if limit == 320 else 80, method=4)
