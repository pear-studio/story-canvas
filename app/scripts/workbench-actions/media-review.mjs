export const mediaReviewHint = '图片用 read_image(file_path=absolute_file)；视频用 read_image(file_path=absolute_review)。视频封面不是审阅拼图；抽帧不能验证播放速度、全程稳定性或循环接缝，这些需实际播放确认。';

export function mediaReview(row) {
  return { ...row, review: row.media_kind === 'video'
    ? { kind: 'sampled_frames', file: row.absolute_review ?? null, limitation: '仅抽帧；速度、全程稳定性与循环接缝未验证' }
    : { kind: 'image', file: row.absolute_file ?? null } };
}
