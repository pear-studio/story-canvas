"""解码并核验本机视频，生成封面、带时间的审阅拼图和媒体元数据。"""
import sys, json
from pathlib import Path
import av
from PIL import Image, ImageDraw

source, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
with av.open(str(source)) as container:
    stream = container.streams.video[0]
    fps = float(stream.average_rate)
    audio = len(container.streams.audio)
    frames = [f.to_image() for f in container.decode(stream)]
if not frames or audio or abs(fps - 24) > .01:
    raise ValueError('视频须完整解码、24 fps、无音频')
frames[0].save(out / 'image.png')
indices = sorted(set([0, 1, *[round(i*(len(frames)-1)/7) for i in range(8)], len(frames)-2, len(frames)-1]))
width, height = 240, round(frames[0].height*240/frames[0].width)
sheet = Image.new('RGB',(width*4,(height+24)*((len(indices)+3)//4)), '#171717')
draw = ImageDraw.Draw(sheet)
for j,i in enumerate(indices):
    x,y = (j%4)*width,(j//4)*(height+24)
    sheet.paste(frames[i].resize((width,height)),(x,y))
    draw.text((x+5,y+height+4), f'{i/fps:.2f}s / frame {i}',fill='white')
sheet.save(out/'review.jpg',quality=90)
meta={'width':frames[0].width,'height':frames[0].height,'frames':len(frames),'fps':fps,'duration_seconds':len(frames)/fps,'audio_streams':audio,'review_frames':indices}
(out/'video.json').write_text(json.dumps(meta),encoding='utf8')
