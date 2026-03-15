# Family Baby Gallery

가족/친척과 함께 쓰는 사진·영상 공유 웹앱.

업로드하면 자동으로 썸네일 생성, 영상은 HLS 스트리밍 변환. PWA로 설치하면 네이티브 앱처럼 사용 가능합니다.

## 주요 기능

- **사진/영상 업로드** — 드래그 앤 드롭, 다중 업로드, 10GB까지
- **자동 썸네일** — Sharp로 300px WebP 생성
- **HLS 스트리밍** — 영상 자동 변환, 적응형 스트리밍
- **인터랙션** — 좋아요, 댓글, 즐겨찾기, 다운로드
- **푸시 알림** — 새 사진 업로드 시 Web Push 알림
- **카카오/네이버 로그인** — OAuth 소셜 로그인
- **EXIF 기반 정렬** — 촬영일 기준 타임라인

## 빠른 시작

### 1. 클론

```bash
git clone git@github.com:HanSyngha/Family-Baby-Gallery.git
cd Family-Baby-Gallery
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열고 값을 채웁니다:

| 변수 | 설명 | 필수 |
|------|------|------|
| `KAKAO_CLIENT_ID` | [Kakao Developers](https://developers.kakao.com) REST API 키 | O |
| `KAKAO_CLIENT_SECRET` | Kakao 클라이언트 시크릿 | O |
| `NAVER_CLIENT_ID` | [Naver Developers](https://developers.naver.com) Client ID | - |
| `NAVER_CLIENT_SECRET` | Naver Client Secret | - |
| `JWT_SECRET` | JWT 서명용 랜덤 문자열 | O |
| `BASE_URL` | 서비스 접속 URL (예: `https://my.domain:2280`) | O |
| `VAPID_PUBLIC_KEY` | Web Push 공개키 | - |
| `VAPID_PRIVATE_KEY` | Web Push 비밀키 | - |

> **VAPID 키 생성**: `npx web-push generate-vapid-keys`

### 3. 실행

```bash
docker compose up -d
```

`http://localhost:2280` 으로 접속합니다.

## OAuth 설정 가이드

### Kakao 로그인

1. [Kakao Developers](https://developers.kakao.com)에서 애플리케이션 생성
2. **앱 키** > REST API 키 → `KAKAO_CLIENT_ID`
3. **보안** > Client Secret 생성 → `KAKAO_CLIENT_SECRET`
4. **카카오 로그인** > 활성화
5. **Redirect URI** 추가: `{BASE_URL}/api/auth/kakao/callback`
6. **동의항목**: 프로필 정보, 닉네임 활성화

### Naver 로그인 (선택)

1. [Naver Developers](https://developers.naver.com)에서 애플리케이션 등록
2. **사용 API**: 네아로 (네이버 아이디로 로그인)
3. Client ID / Secret → `.env`에 입력
4. **Callback URL**: `{BASE_URL}/api/auth/naver/callback`

## 기술 스택

| 영역 | 기술 |
|------|------|
| Frontend | React 19 + Vite + TypeScript |
| Backend | Fastify + TypeScript |
| Database | SQLite (WAL mode, better-sqlite3) |
| 이미지 처리 | Sharp (WebP 썸네일) |
| 비디오 | ffmpeg (HLS 변환) |
| 인증 | Kakao/Naver OAuth → JWT |
| 배포 | Docker (단일 컨테이너) |

## 데이터

모든 데이터는 `./data/` 디렉토리에 저장됩니다:

```
data/
├── originals/     # 원본 사진/영상
├── thumbnails/    # WebP 썸네일
├── hls/           # HLS 비디오 세그먼트
└── peanut.db      # SQLite DB
```

## 관련 프로젝트

핵가족(4인) 전용 종합 앱이 필요하다면 [Family-Baby-Webapp](https://github.com/HanSyngha/Family-Baby-Webapp)을 확인하세요. 갤러리 + 육아 기록 + 캘린더 + 할일 + 노트를 포함한 올인원 가족 앱입니다.

## 로컬 개발

```bash
npm install

# 프론트엔드 (port 5174)
npm run dev

# 백엔드 (port 2280)
npm run dev:server
```

## 라이선스

MIT
