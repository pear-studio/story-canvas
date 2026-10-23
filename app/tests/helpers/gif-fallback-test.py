"""真实编码验证：各档独立取源、首个达标即停、失败不留下超限输出。"""
import sys
import json
from pathlib import Path
from random import Random
from PIL import Image
import av

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
from gif_encoding import encode_gif, POLICY

directory=Path(sys.argv[1])
random=Random(7)
frames=[av.VideoFrame.from_image(Image.frombytes('RGB',(512,384),random.randbytes(512*384*3))) for _ in range(12)]
original=[frame.to_image().tobytes() for frame in frames]
sizes=[]
for i,tier in enumerate(POLICY['tiers']):
    result=encode_gif(frames,12,directory/f'tier-{i}.gif',{**POLICY,'tiers':[tier]})
    sizes.append(result['bytes'])
    assert result['duration_seconds']==1
assert all(sizes[i]<min(sizes[:i]) for i in range(1,len(sizes))), sizes
for i,limit in enumerate(sizes):
    target=directory/f'fallback-{i}.gif'
    result=encode_gif(frames,12,target,{**POLICY,'max_bytes':limit})
    assert result['encoding']['tier']==i
    assert len(result['encoding']['attempts'])==i+1
    assert result['duration_seconds']==1
    assert target.read_bytes()==(directory/f'tier-{i}.gif').read_bytes(), '每档须从原片独立编码'
    with Image.open(target) as image:
        assert image.info['loop']==0
        for n in range(image.n_frames):image.seek(n);image.load();assert image.info['duration']>10
target=directory/'failed.gif'
try:encode_gif(frames,12,target,{**POLICY,'max_bytes':1})
except ValueError as error:assert '全部 5 档' in str(error)
else:raise AssertionError('全部超限时必须失败')
assert not target.exists()
assert original==[frame.to_image().tobytes() for frame in frames]
print(json.dumps({'sizes':sizes,'tiers_verified':len(sizes)}))
