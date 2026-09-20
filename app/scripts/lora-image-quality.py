"""按行接收 PNG 的 base64，返回 MUSIQ 分数；一批只加载一次，不启动网络服务。"""
import argparse
import base64
import contextlib
import io
import json
import math
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        import pyiqa
        from PIL import Image
        torch.set_num_threads(4)
        torch.manual_seed(0)
        metric = pyiqa.create_metric('musiq', pretrained_model_path=args.model,
                                     device='cuda' if torch.cuda.is_available() else 'cpu')
        metric.eval()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with Image.open(io.BytesIO(base64.b64decode(request['image']))) as source:
                image = source.convert('RGB')
            tensor = torch.from_numpy(np.asarray(image).copy()).permute(2, 0, 1).float().unsqueeze(0) / 255
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                score = float(metric(tensor).item())
            if not math.isfinite(score):
                raise ValueError('MUSIQ returned a non-finite score')
            print(json.dumps({'score': score}), flush=True)
        except Exception as error:
            print(json.dumps({'error': str(error)}), flush=True)

if __name__ == '__main__':
    main()
