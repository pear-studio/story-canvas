"""使用本地 IS-Net 移除背景，输出独立透明 PNG；不覆盖原图、不自动下载模型。"""
import argparse
import hashlib
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    source, output = args.input.resolve(), args.output.resolve()
    if not source.is_file():
        parser.error('输入图片不存在')
    if output == source or output.exists() or output.suffix.lower() != '.png':
        parser.error('输出必须是尚不存在的 PNG 文件，不能覆盖原图')
    root = Path(__file__).resolve().parents[2]
    config = json.loads((root / 'Config/local.json').read_text(encoding='utf-8-sig'))
    manifest = json.loads((root / 'library/material-tools/isnet-general-use.json').read_text(encoding='utf-8'))
    model_root = config.get('models_root')
    if not model_root:
        parser.error('请配置 models_root')
    model = root / model_root / manifest['relative_path']
    if not model.is_file() or model.stat().st_size != manifest['size_bytes']:
        parser.error('本地 IS-Net 模型缺失或大小不符，请按模型清单安装')
    if hashlib.sha256(model.read_bytes()).hexdigest() != manifest['sha256']:
        parser.error('本地 IS-Net 模型 SHA256 不符')
    os.environ['U2NET_HOME'] = str(model.parent)
    os.environ.setdefault('OMP_NUM_THREADS', '4')
    from PIL import Image, ImageOps
    from rembg import new_session, remove
    session = new_session('isnet-general-use', providers=['CPUExecutionProvider'])
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original).convert('RGBA')
        result = remove(image, session=session)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as handle:
            result.save(handle, format='PNG')
    print(json.dumps({'output': str(output), 'width': result.width, 'height': result.height, 'mode': result.mode}))


if __name__ == '__main__':
    main()
