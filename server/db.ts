import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'peanut.db');

// 데이터 디렉토리 생성
fs.mkdirSync(path.join(DATA_DIR, 'originals'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'thumbnails'), { recursive: true });

const db = new Database(DB_PATH);

// WAL 모드 + 성능 설정
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// 테이블 생성
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    providerId TEXT NOT NULL,
    name TEXT NOT NULL,
    profileImage TEXT,
    role TEXT DEFAULT 'member',
    createdAt TEXT DEFAULT (datetime('now', '+9 hours')),
    UNIQUE(provider, providerId)
  );

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uploaderId INTEGER NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    originalName TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    hash TEXT,
    createdAt TEXT DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    userId INTEGER NOT NULL REFERENCES users(id),
    createdAt TEXT DEFAULT (datetime('now', '+9 hours')),
    UNIQUE(mediaId, userId)
  );

  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    userId INTEGER NOT NULL REFERENCES users(id),
    createdAt TEXT DEFAULT (datetime('now', '+9 hours')),
    UNIQUE(mediaId, userId)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    userId INTEGER NOT NULL REFERENCES users(id),
    createdAt TEXT DEFAULT (datetime('now', '+9 hours')),
    UNIQUE(mediaId, userId)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    userId INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_created ON media(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploaderId);
  CREATE INDEX IF NOT EXISTS idx_views_media ON views(mediaId);
  CREATE INDEX IF NOT EXISTS idx_downloads_media ON downloads(mediaId);
  CREATE INDEX IF NOT EXISTS idx_likes_media ON likes(mediaId);
  CREATE INDEX IF NOT EXISTS idx_comments_media ON comments(mediaId);
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdAt TEXT DEFAULT (datetime('now', '+9 hours')),
    UNIQUE(mediaId, userId)
  );

  CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    userId INTEGER NOT NULL REFERENCES users(id),
    createdAt TEXT DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(userId);
  CREATE INDEX IF NOT EXISTS idx_favorites_media ON favorites(mediaId);
  CREATE INDEX IF NOT EXISTS idx_shares_media ON shares(mediaId);
`);

// 마이그레이션: 기존 DB에 hash 컬럼 추가
try {
  db.exec('ALTER TABLE media ADD COLUMN hash TEXT');
} catch {
  // 이미 존재하면 무시
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash)'); } catch {}

// 마이그레이션: users에 banned 컬럼 추가
try { db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0'); } catch {}

// 마이그레이션: media에 uploadedAt 컬럼 추가 (실제 업로드 시각)
try { db.exec('ALTER TABLE media ADD COLUMN uploadedAt TEXT'); } catch {}

// 마이그레이션: media에 source 컬럼 추가 ('local' | 'family')
try { db.exec("ALTER TABLE media ADD COLUMN source TEXT DEFAULT 'local'"); } catch {}

// 마이그레이션: comments에 parentId(대댓글), editedAt(수정 표시) 컬럼 추가
try { db.exec('ALTER TABLE comments ADD COLUMN parentId INTEGER REFERENCES comments(id) ON DELETE CASCADE'); } catch {}
try { db.exec('ALTER TABLE comments ADD COLUMN editedAt TEXT'); } catch {}

// 마이그레이션: views 테이블 UNIQUE 제약 제거 (조회할 때마다 카운트)
try {
  const hasUnique = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='views'").get() as { sql: string } | undefined;
  if (hasUnique && hasUnique.sql.includes('UNIQUE')) {
    db.exec(`
      CREATE TABLE views_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mediaId INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        userId INTEGER NOT NULL REFERENCES users(id),
        createdAt TEXT DEFAULT (datetime('now', '+9 hours'))
      );
      INSERT INTO views_new SELECT * FROM views;
      DROP TABLE views;
      ALTER TABLE views_new RENAME TO views;
      CREATE INDEX IF NOT EXISTS idx_views_media ON views(mediaId);
    `);
    console.log('Migrated views table: removed UNIQUE constraint');
  }
} catch {}

// 기존 파일들의 해시를 채워넣기 (quick hash: head+tail+size)
import crypto from 'crypto';
const CHUNK = 4 * 1024 * 1024;
const unhashed = db.prepare('SELECT id, filename FROM media WHERE hash IS NULL').all() as { id: number; filename: string }[];
if (unhashed.length > 0) {
  const update = db.prepare('UPDATE media SET hash = ? WHERE id = ?');
  for (const row of unhashed) {
    try {
      const filePath = path.join(DATA_DIR, 'originals', row.filename);
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      const hash = crypto.createHash('sha256');
      if (stat.size <= CHUNK) {
        hash.update(fs.readFileSync(filePath));
      } else {
        const fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(CHUNK);
        const tail = Buffer.alloc(CHUNK);
        fs.readSync(fd, head, 0, CHUNK, 0);
        fs.readSync(fd, tail, 0, CHUNK, stat.size - CHUNK);
        fs.closeSync(fd);
        hash.update(head);
        hash.update(tail);
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeDoubleBE(stat.size);
        hash.update(sizeBuf);
      }
      update.run(hash.digest('hex'), row.id);
    } catch {}
  }
  console.log(`Backfilled hash for ${unhashed.length} existing files`);
}

// 땅콩페밀리 DB 연결 (볼륨 마운트 시)
const FAMILY_DATA_DIR = process.env.FAMILY_DATA_DIR || '';
let familyDb: InstanceType<typeof Database> | null = null;

if (FAMILY_DATA_DIR) {
  const familyDbPath = path.join(FAMILY_DATA_DIR, 'peanut-family.db');
  if (fs.existsSync(familyDbPath)) {
    familyDb = new Database(familyDbPath);
    familyDb.pragma('journal_mode = WAL');
    familyDb.pragma('busy_timeout = 5000');
    console.log('[DB] Connected to peanut-family.db (땅콩페밀리)');
  }
}

export { familyDb };
export default db;
