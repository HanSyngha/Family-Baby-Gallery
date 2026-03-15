import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const DATA_DIR = path.resolve('data');

export interface ProcessResult {
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: string; // EXIF/메타데이터 촬영 시간 (ISO string)
}

function parseExifDate(exifDate: string | undefined): string | undefined {
  if (!exifDate) return undefined;
  // EXIF 형식: "2024:01:15 14:30:00" → "2024-01-15 14:30:00"
  // EXIF는 카메라 로컬시간(KST)이므로 변환 없이 그대로 포매팅
  const match = exifDate.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

export async function processImage(filename: string): Promise<ProcessResult> {
  const originalPath = path.join(DATA_DIR, 'originals', filename);
  const thumbPath = path.join(DATA_DIR, 'thumbnails', filename + '.webp');

  const metadata = await sharp(originalPath).metadata();

  await sharp(originalPath)
    .rotate() // EXIF 기반 자동 회전
    .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath);

  // EXIF 촬영 날짜 추출
  const exif = metadata.exif;
  let takenAt: string | undefined;
  if (exif) {
    try {
      const exifStr = exif.toString('utf8');
      // DateTimeOriginal 또는 DateTime 패턴 찾기
      const dateMatch = exifStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (dateMatch) {
        takenAt = parseExifDate(dateMatch[0]);
      }
    } catch {}
  }

  return {
    width: metadata.width,
    height: metadata.height,
    takenAt,
  };
}

export async function processVideo(filename: string): Promise<ProcessResult> {
  const originalPath = path.join(DATA_DIR, 'originals', filename);
  const thumbPath = path.join(DATA_DIR, 'thumbnails', filename + '.webp');

  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  let takenAt: string | undefined;

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      originalPath,
    ]);
    const probe = JSON.parse(stdout);
    const videoStream = probe.streams?.find((s: any) => s.codec_type === 'video');
    if (videoStream) {
      width = parseInt(videoStream.width);
      height = parseInt(videoStream.height);
    }
    if (probe.format?.duration) {
      duration = parseFloat(probe.format.duration);
    }

    // 영상 촬영 날짜: format.tags.creation_time
    const creationTime = probe.format?.tags?.creation_time
      || videoStream?.tags?.creation_time;
    if (creationTime) {
      const date = new Date(creationTime);
      if (!isNaN(date.getTime())) {
        // KST로 변환 (+9시간)
        const kst = new Date(date.getTime() + 9 * 3600000);
        takenAt = kst.toISOString().replace('T', ' ').slice(0, 19);
      }
    }
  } catch {
    // ffprobe 실패해도 계속 진행
  }

  // 첫 프레임 추출 → WebP 썸네일
  const tmpFrame = path.join(DATA_DIR, 'thumbnails', filename + '_tmp.jpg');
  try {
    await execFileAsync('ffmpeg', [
      '-i', originalPath,
      '-vframes', '1',
      '-vf', 'scale=300:-1',
      '-y',
      tmpFrame,
    ]);

    await sharp(tmpFrame)
      .webp({ quality: 80 })
      .toFile(thumbPath);
  } finally {
    if (fs.existsSync(tmpFrame)) fs.unlinkSync(tmpFrame);
  }

  // moov atom을 파일 앞으로 이동 (faststart) → 스트리밍 재생 시작 단축
  const tmpFaststart = originalPath + '.faststart.mp4';
  try {
    await execFileAsync('ffmpeg', [
      '-i', originalPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      tmpFaststart,
    ]);
    fs.renameSync(tmpFaststart, originalPath);
  } catch {
    if (fs.existsSync(tmpFaststart)) fs.unlinkSync(tmpFaststart);
  }

  // HLS 세그먼트 생성 (2초 단위, 재인코딩 없음)
  // cwd를 hlsDir로 설정 → m3u8에 상대경로(seg000.ts)가 기록됨
  const hlsDir = path.join(DATA_DIR, 'hls', filename);
  try {
    fs.mkdirSync(hlsDir, { recursive: true });
    await execFileAsync('ffmpeg', [
      '-i', originalPath,
      '-c', 'copy',
      '-hls_time', '2',
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_segment_filename', 'seg%03d.m4s',
      '-y',
      'playlist.m3u8',
    ], { cwd: hlsDir });
  } catch {
    // HLS 생성 실패해도 원본 재생은 가능하므로 무시
    if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });
  }

  return { width, height, duration, takenAt };
}
