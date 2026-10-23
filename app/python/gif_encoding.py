"""GIF 有界降级编码；每档从原帧采样，保持最终播放时长。"""
import json
import math
from pathlib import Path
from PIL import Image

POLICY = json.loads((Path(__file__).resolve().parents[1] / 'shared/gif-policy.json').read_text())


def encode_tier(frames, fps, target, tier, ticks):
    count = max(1, min(round(len(frames) / fps * min(tier['target_fps'], fps)), ticks // 2))
    images = []
    for i in range(count):
        image = frames[min(len(frames) - 1, math.floor(i * len(frames) / count))].to_image().convert('RGB')
        if image.width > tier['max_width']:
            image = image.resize((tier['max_width'], max(1, round(image.height * tier['max_width'] / image.width))), Image.Resampling.LANCZOS)
        images.append(image)
    tiles = Image.new('RGB', (32 * min(32, count), 32 * math.ceil(count / 32)))
    for i, image in enumerate(images):
        tiles.paste(image.resize((32, 32)), ((i % 32) * 32, (i // 32) * 32))
    palette = tiles.quantize(colors=tier['colors'], method=Image.Quantize.MEDIANCUT)
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
        return dict(width=encoded.width, height=encoded.height, encoded_frames=actual_count,
                    duration_seconds=actual_ms / 1000, bytes=target.stat().st_size)


def encode_gif(frames, fps, target, policy=POLICY):
    ticks = round(len(frames) / fps * 100)
    if ticks < 2:
        raise ValueError('片段不足 20ms，GIF 无法保证播放时长，请保留更多帧或降低倍率')
    attempts = []
    for tier in policy['tiers']:
        gif = encode_tier(frames, fps, target, tier, ticks)
        attempts.append({**tier, 'bytes': gif['bytes']})
        if gif['bytes'] <= policy['max_bytes']:
            gif['encoding'] = dict(policy=policy['version'], max_bytes=policy['max_bytes'],
                                   tier=len(attempts) - 1, **tier, original_bytes=attempts[0]['bytes'], attempts=attempts)
            return gif
    target.unlink(missing_ok=True)
    raise ValueError(f"GIF 已尝试全部 {len(attempts)} 档仍超过 {policy['max_bytes']} 字节，未发布新成品；请人工调整。各档大小：" + ', '.join(str(a['bytes']) for a in attempts))
