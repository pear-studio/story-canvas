"""从冻结原片制作自适应 GIF 和裁剪首帧，不插帧、不改变时长。"""
import sys
import json
from pathlib import Path
from video_processing import read_video, require_new_target
from gif_encoding import encode_gif, POLICY

source, target, poster, metadata = map(Path, sys.argv[1:5])
require_new_target(source, target)
frames, rate = read_video(source, json.loads(sys.argv[5]))
fps = float(rate)
gif = encode_gif(frames, fps, target, json.loads(sys.argv[6]) if len(sys.argv) > 6 else POLICY)
frames[0].to_image().save(poster)
warnings = ['GIF 超过 500 帧，发布前请检查平台帧数限制'] if gif['encoded_frames'] > 500 else []
metadata.write_text(json.dumps(dict(width=frames[0].width, height=frames[0].height, frames=len(frames),
                                  fps=fps, duration_seconds=len(frames) / fps, gif=gif, warnings=warnings)), encoding='utf-8')
