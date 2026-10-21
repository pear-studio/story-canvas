"""从冻结原片生成独立 MP4、首帧封面与实际媒体信息。"""
import json
import sys
from fractions import Fraction
from pathlib import Path
import av
from video_processing import read_video, require_new_target

source, target, poster, metadata = map(Path, sys.argv[1:5])
for output in (target, poster, metadata):
    require_new_target(source, output)
frames, rate = read_video(source, json.loads(sys.argv[5]))
frames[0].to_image().save(poster)
with av.open(str(target), 'w', format='mp4', options={'movflags': '+faststart'}) as container:
    stream = container.add_stream('libx264', rate=rate)
    stream.width, stream.height = frames[0].width, frames[0].height
    stream.pix_fmt = 'yuv420p'
    stream.options = {'crf': '18', 'preset': 'fast'}
    time_base = Fraction(1, 1) / rate
    for index, frame in enumerate(frames):
        # 原片可能含 B 帧；重新指定顺序、时间基准和帧类型。
        frame.pts, frame.time_base, frame.pict_type = index, time_base, 0
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
with av.open(str(target)) as container:
    actual = container.streams.video[0]
    decoded = list(container.decode(actual))
    if len(decoded) != len(frames) or abs(float(actual.average_rate) - float(rate)) > .001:
        raise ValueError('后处理输出帧数或帧率不符')
metadata.write_text(json.dumps({
    'width': frames[0].width, 'height': frames[0].height,
    'frames': len(frames), 'fps': float(rate),
    'duration_seconds': float(len(frames) / rate), 'audio_streams': 0,
}), encoding='utf8')
