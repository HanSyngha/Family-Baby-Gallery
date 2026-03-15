import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import path from 'path';
import fs from 'fs';
import { registerAuthRoutes } from './auth.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerInteractionRoutes } from './routes/interaction.js';
import { registerUserRoutes } from './routes/user.js';
import { registerPushRoutes } from './push.js';

const app = Fastify({ logger: true });

// 플러그인 등록
await app.register(fastifyCors, { origin: true, credentials: true });
await app.register(fastifyCookie);
await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB

// 캐시 제어
app.addHook('onSend', (request, reply, _payload, done) => {
  if (request.url.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Cookie');
  }
  if (request.url === '/sw.js') {
    reply.header('Cache-Control', 'no-cache, no-store');
  }
  done();
});

// API 라우트 등록
registerAuthRoutes(app);
registerMediaRoutes(app);
registerInteractionRoutes(app);
registerUserRoutes(app);
registerPushRoutes(app);

// SPA 정적 파일 서빙 (production)
const publicDir = path.resolve('dist/public');
if (fs.existsSync(publicDir)) {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
  });

  // SPA fallback: API가 아닌 모든 요청을 index.html로
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

// 임시 파일 정리 (30분마다) - DB에 없는 고아 파일 삭제
import db from './db.js';

function cleanupOrphanFiles() {
  const originalsDir = path.resolve('data/originals');
  const thumbsDir = path.resolve('data/thumbnails');
  const hlsDir = path.resolve('data/hls');
  if (!fs.existsSync(originalsDir)) return;

  const dbFiles = new Set(
    (db.prepare('SELECT filename FROM media').all() as { filename: string }[]).map(r => r.filename)
  );

  const now = Date.now();
  const THIRTY_MIN = 30 * 60 * 1000;

  for (const file of fs.readdirSync(originalsDir)) {
    if (dbFiles.has(file)) continue;

    const filePath = path.join(originalsDir, file);
    const stat = fs.statSync(filePath);

    // 30분 이상 된 고아 파일만 삭제 (업로드 처리 중일 수 있으므로)
    if (now - stat.mtimeMs > THIRTY_MIN) {
      fs.unlinkSync(filePath);
      const thumbPath = path.join(thumbsDir, file + '.webp');
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      const hlsPath = path.join(hlsDir, file);
      if (fs.existsSync(hlsPath)) fs.rmSync(hlsPath, { recursive: true });
      console.log('Cleaned orphan file:', file);
    }
  }

  // HLS 디렉토리 중 원본도 없고 DB에도 없는 고아 정리
  // (원본이 있으면 아직 처리 중일 수 있으므로 건너뜀)
  if (fs.existsSync(hlsDir)) {
    for (const dir of fs.readdirSync(hlsDir)) {
      if (!dbFiles.has(dir) && !fs.existsSync(path.join(originalsDir, dir))) {
        fs.rmSync(path.join(hlsDir, dir), { recursive: true });
        console.log('Cleaned orphan HLS dir:', dir);
      }
    }
  }
}

setInterval(cleanupOrphanFiles, 30 * 60 * 1000);

const port = parseInt(process.env.PORT || '2280');
await app.listen({ port, host: '0.0.0.0' });
console.log(`Server running on port ${port}`);
