"""冻结成品原片派生 EH WebP 或离线 MP4，校验完整播放时间轴。"""
import json
import math
import sys
from fractions import Fraction
from pathlib import Path
import av
from PIL import Image
from video_processing import read_video, require_new_target

source, target, metadata = map(Path, sys.argv[1:4])
settings, profile = map(json.loads, sys.argv[4:6])
require_new_target(source, target)
frames, rate = read_video(source, settings)
duration = len(frames) / float(rate)
if profile['format'] == 'mp4':
    # H.264 4:2:0 要求偶数边；不足一像素的边补齐，不裁掉原画。
    width, height = frames[0].width, frames[0].height
    padded = width % 2 or height % 2
    with av.open(str(target), 'w', format='mp4', options={'movflags': '+faststart'}) as container:
        stream = container.add_stream('libx264', rate=rate)
        stream.width, stream.height = width + width % 2, height + height % 2
        stream.pix_fmt = 'yuv420p'
        stream.options = {'crf': str(profile['crf']), 'preset': profile['preset']}
        for i, frame in enumerate(frames):
            if padded:
                image = Image.new('RGB', (stream.width, stream.height))
                image.paste(frame.to_image(), (0, 0))
                frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base, frame.pict_type = i, Fraction(1, 1) / rate, 0
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    with av.open(str(target)) as container:
        stream = container.streams.video[0]
        count = sum(1 for _ in container.decode(stream))
        actual = count / float(stream.average_rate)
        if count != len(frames) or abs(actual - duration) > .001:
            raise ValueError('MP4 帧数或时长不符')
        result = {'width': stream.width, 'height': stream.height, 'frames': count, 'duration_seconds': actual}
else:
    count = max(1, math.ceil(duration * min(profile['target_fps'], float(rate))))
    times = [round(i * duration * 1000 / count) for i in range(count + 1)]
    delays = [times[i + 1] - times[i] for i in range(count)]
    if min(delays) <= 10:
        raise ValueError('WebP 帧时长过短')
    images = []
    for i in range(count):
        image = frames[min(len(frames) - 1, math.floor(i * len(frames) / count))].to_image()
        width = min(profile['max_width'], image.width)
        if width != image.width:
            image = image.resize((width, max(1, round(image.height * width / image.width))), Image.Resampling.LANCZOS)
        images.append(image)
    images[0].save(target, format='WEBP', save_all=True, append_images=images[1:], duration=delays,
                   loop=0, quality=profile['quality'], method=4)
    with Image.open(target) as image:
        elapsed = 0
        for i in range(image.n_frames):
            image.seek(i)
            image.load()
            elapsed += image.info.get('duration', times[-1])
        if abs(elapsed / 1000 - duration) > .001:
            raise ValueError('WebP 时长不符')
        result = {'width': image.width, 'height': image.height, 'frames': image.n_frames, 'duration_seconds': elapsed / 1000}
metadata.write_text(json.dumps({**result, 'bytes': target.stat().st_size}), encoding='utf8')
