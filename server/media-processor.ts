import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const DATA_DIR = path.resolve('data');

// ffmpeg 트랜스코딩은 오래 걸리고 stderr 출력이 많으므로 maxBuffer 넉넉히
const FF_OPTS = { maxBuffer: 32 * 1024 * 1024 };

export interface ProcessResult {
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: string; // EXIF/메타데이터 촬영 시간 (ISO string)
}

interface VideoInfo {
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: string;
  codec?: string;
  bitRate?: number;
  fps?: number;
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

// 영상 메타데이터 추출 (코덱/해상도/비트레이트/촬영시간)
async function probeVideo(originalPath: string): Promise<VideoInfo> {
  const info: VideoInfo = {};
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      originalPath,
    ], FF_OPTS);
    const probe = JSON.parse(stdout);
    const v = probe.streams?.find((s: any) => s.codec_type === 'video');
    if (v) {
      info.width = parseInt(v.width);
      info.height = parseInt(v.height);
      info.codec = v.codec_name;
      if (v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
        const [n, d] = v.avg_frame_rate.split('/').map(Number);
        if (d) info.fps = n / d;
      }
      if (v.bit_rate) info.bitRate = parseInt(v.bit_rate);
    }
    if (probe.format?.duration) info.duration = parseFloat(probe.format.duration);
    if (!info.bitRate && probe.format?.bit_rate) info.bitRate = parseInt(probe.format.bit_rate);

    // 영상 촬영 날짜: format.tags.creation_time
    const creationTime = probe.format?.tags?.creation_time || v?.tags?.creation_time;
    if (creationTime) {
      const date = new Date(creationTime);
      if (!isNaN(date.getTime())) {
        const kst = new Date(date.getTime() + 9 * 3600000);
        info.takenAt = kst.toISOString().replace('T', ' ').slice(0, 19);
      }
    }
  } catch {
    // ffprobe 실패해도 계속 진행
  }
  return info;
}

// 트랜스코딩이 필요한지 판단.
// H.264 + 1080p 이내 + 적당한 비트레이트면 그대로 스트리밍 가능 → copy.
// HEVC / 4K / 고비트레이트는 가정용 회선으로 스트리밍 불가 → H.264 1080p로 재인코딩.
export function needsTranscode(info: VideoInfo): boolean {
  if (!info.codec || !info.width || !info.height) return false; // 정보 부족 시 안전하게 copy
  if (info.codec !== 'h264') return true;
  if (Math.max(info.width, info.height) > 1920 || Math.min(info.width, info.height) > 1080) return true;
  if (info.bitRate && info.bitRate > 12_000_000) return true;
  return false;
}

const even = (n: number) => Math.round(n / 2) * 2;

// 1080p(1920x1080) 박스 안에 들어가도록 짝수 해상도 계산. 이미 작으면 null.
function fitDims(w: number, h: number): { w: number; h: number } | null {
  const MAX_LONG = 1920, MAX_SHORT = 1080;
  const long = Math.max(w, h), short = Math.min(w, h);
  if (long <= MAX_LONG && short <= MAX_SHORT) return null;
  const scale = Math.min(MAX_LONG / long, MAX_SHORT / short);
  return { w: even(w * scale), h: even(h * scale) };
}

const HLS_ARGS = [
  '-hls_time', '4',
  '-hls_list_size', '0',
  '-hls_segment_type', 'fmp4',
  '-hls_segment_filename', 'seg%03d.m4s',
  '-y', 'playlist.m3u8',
];

// HLS 생성. transcode=false면 무손실 리먹스(copy), true면 H.264 1080p 재인코딩.
// 재인코딩은 하드웨어(VAAPI)를 먼저 쓰고, 실패하면 소프트웨어(libx264)로 폴백한다.
async function buildHls(filename: string, info: VideoInfo, transcode: boolean): Promise<void> {
  const originalPath = path.join(DATA_DIR, 'originals', filename);
  const hlsDir = path.join(DATA_DIR, 'hls', filename);

  if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });
  fs.mkdirSync(hlsDir, { recursive: true });

  if (!transcode) {
    // 코덱/해상도/비트레이트 모두 OK → 재인코딩 없이 컨테이너만 HLS로
    await execFileAsync('ffmpeg', [
      '-loglevel', 'error', '-nostats',
      '-i', originalPath, '-c', 'copy', ...HLS_ARGS,
    ], { cwd: hlsDir, timeout: 30 * 60 * 1000, ...FF_OPTS });
    return;
  }

  const fit = info.width && info.height ? fitDims(info.width, info.height) : null;
  const tw = fit ? fit.w : (info.width ? even(info.width) : 1920);
  const th = fit ? fit.h : (info.height ? even(info.height) : 1080);
  const KF = 'expr:gte(t,n_forced*4)'; // 4초마다 키프레임 → 세그먼트 경계 정렬

  // 1) 하드웨어 가속 (Intel VAAPI): HEVC 디코드 → 스케일 → H.264 인코드 모두 GPU
  try {
    await execFileAsync('ffmpeg', [
      '-loglevel', 'error', '-nostats',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-i', originalPath,
      '-vf', `scale_vaapi=w=${tw}:h=${th}:format=nv12`,
      '-c:v', 'h264_vaapi', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
      '-force_key_frames', KF,
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      ...HLS_ARGS,
    ], { cwd: hlsDir, timeout: 30 * 60 * 1000, ...FF_OPTS });
    return;
  } catch (err) {
    console.error(`[HLS] VAAPI 실패, 소프트웨어로 폴백: ${err instanceof Error ? err.message : err}`);
    fs.rmSync(hlsDir, { recursive: true });
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  // 2) 소프트웨어 폴백 (libx264) — 느리지만 드라이버 무관하게 동작
  await execFileAsync('ffmpeg', [
    '-loglevel', 'error', '-nostats',
    '-i', originalPath,
    '-vf', `scale=${tw}:${th}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
    '-force_key_frames', KF,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    ...HLS_ARGS,
  ], { cwd: hlsDir, timeout: 180 * 60 * 1000, ...FF_OPTS });
}

export async function processVideo(filename: string): Promise<ProcessResult> {
  const originalPath = path.join(DATA_DIR, 'originals', filename);
  const thumbPath = path.join(DATA_DIR, 'thumbnails', filename + '.webp');

  const info = await probeVideo(originalPath);

  // 첫 프레임 추출 → WebP 썸네일
  const tmpFrame = path.join(DATA_DIR, 'thumbnails', filename + '_tmp.jpg');
  try {
    await execFileAsync('ffmpeg', [
      '-i', originalPath,
      '-vframes', '1',
      '-vf', 'scale=300:-1',
      '-y',
      tmpFrame,
    ], FF_OPTS);

    await sharp(tmpFrame)
      .webp({ quality: 80 })
      .toFile(thumbPath);
  } finally {
    if (fs.existsSync(tmpFrame)) fs.unlinkSync(tmpFrame);
  }

  // HLS 생성 (실패해도 원본 재생 가능하므로 업로드 자체는 성공시킨다)
  // 원본 파일은 절대 건드리지 않는다 (다운로드 = 원본 보존). 스트리밍은 HLS 복사본이 담당.
  try {
    await buildHls(filename, info, needsTranscode(info));
  } catch (err) {
    console.error(`[HLS] 생성 실패: ${err instanceof Error ? err.message : err}`);
    const hlsDir = path.join(DATA_DIR, 'hls', filename);
    if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });
  }

  return { width: info.width, height: info.height, duration: info.duration, takenAt: info.takenAt };
}

// 기존 영상 HLS 재생성용 (마이그레이션 스크립트에서 사용). 원본/DB는 건드리지 않는다.
export async function regenerateHls(filename: string): Promise<'transcoded' | 'copied'> {
  const originalPath = path.join(DATA_DIR, 'originals', filename);
  const info = await probeVideo(originalPath);
  const transcode = needsTranscode(info);
  await buildHls(filename, info, transcode);
  return transcode ? 'transcoded' : 'copied';
}

export { probeVideo };
