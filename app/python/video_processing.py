"""视频派生物共用的帧选择与时间轴；只读来源，禁止覆盖原片。"""
import math
from fractions import Fraction
from pathlib import Path
import av


def read_video(source, settings):
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        fps = Fraction(stream.average_rate)
        if fps <= 0 or container.streams.audio:
            raise ValueError('视频帧率无效或含音频')
        frames = list(container.decode(stream))
    start = math.floor(settings.get('trim_start_seconds', 0) * float(fps) + .5)
    end = len(frames) - math.floor(settings.get('trim_end_seconds', 0) * float(fps) + .5)
    if start < 0 or end <= start or end > len(frames):
        raise ValueError('裁剪后至少需要保留一帧')
    rate = fps * Fraction(str(settings.get('speed', 1)))
    return frames[start:end], rate


def require_new_target(source, target):
    if Path(source).resolve() == Path(target).resolve():
        raise ValueError('后处理不能覆盖来源视频')
