"""生成无人物的逐帧变色视频，并检查输出时间轴，供后处理集成测试使用。"""
import json
import hashlib
import sys
from fractions import Fraction
from pathlib import Path
import av
from PIL import Image

mode, file = sys.argv[1], Path(sys.argv[2])
if mode == 'create':
    with av.open(str(file), 'w') as container:
        stream = container.add_stream('libx264', rate=24)
        width = int(sys.argv[3]) if len(sys.argv) > 3 else 64
        stream.width, stream.height, stream.pix_fmt = width, 48, 'yuv420p'
        stream.options = {'crf': '10'}
        for i in range(48):
            frame = av.VideoFrame.from_image(Image.new('RGB', (width, 48), (i * 4, 80, 200 - i * 3)))
            frame.pts, frame.time_base = i, Fraction(1, 24)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
elif mode == 'webp':
    with Image.open(file) as image:
        duration = 0
        hashes = []
        durations = []
        for i in range(image.n_frames):
            image.seek(i)
            image.load()
            duration += image.info['duration']
            durations.append(image.info['duration'])
            hashes.append(hashlib.sha256(image.convert('RGBA').tobytes()).hexdigest())
        image.seek(0)
        print(json.dumps({'frames': image.n_frames, 'duration_ms': duration, 'durations_ms': durations, 'first_pixel': image.convert('RGB').getpixel((0, 0)), 'frame_sha256': hashes}))
elif mode == 'video':
    with av.open(str(file)) as container:
        stream = container.streams.video[0]
        frames = list(container.decode(stream))
        print(json.dumps({'frames': len(frames), 'fps': float(stream.average_rate),
                          'duration_seconds': float(stream.duration * stream.time_base),
                          'first_pixel': frames[0].to_image().getpixel((0, 0))}))
