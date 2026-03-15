import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaItem, User } from '../api';
import { api } from '../api';
import Hls from 'hls.js';
import YarlLightbox, { type Slide } from 'yet-another-react-lightbox';
import Inline from 'yet-another-react-lightbox/plugins/inline';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import 'yet-another-react-lightbox/styles.css';
import Comments from './Comments';
import styles from './Lightbox.module.css';

interface Props {
  items: MediaItem[];
  index: number;
  user: User;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onDelete: (id: number) => void;
  onLikeToggle: (id: number, liked: boolean) => void;
  onFavoriteToggle: (id: number, favorited: boolean) => void;
  onDateChange: (id: number, createdAt: string) => void;
  initialSlideshow?: boolean;
}

function toSlides(items: MediaItem[]): Slide[] {
  return items.map(item => {
    if (item.type === 'video') {
      return { src: api.thumbUrl(item.id, item.filename), mediaItem: item } as any;
    }
    return { src: api.fileUrl(item.id, item.filename), alt: item.originalName };
  });
}

function HlsVideoSlide({ item, onEnded }: { item: MediaItem; onEnded?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const hlsUrl = api.hlsUrl(item.id);

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          hls.destroy();
          hlsRef.current = null;
          video.src = api.fileUrl(item.id, item.filename);
          video.play().catch(() => {});
        }
      });
      return () => { hls.destroy(); hlsRef.current = null; };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(() => {});
      }, { once: true });
    } else {
      video.src = api.fileUrl(item.id, item.filename);
    }
  }, [item.id]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      {loading && (
        <div className={styles.videoLoadingOverlay}>
          <div className={styles.videoLoadingSpinner} />
          <span>영상 불러오는 중...</span>
        </div>
      )}
      <video
        ref={videoRef}
        controls
        playsInline
        poster={api.thumbUrl(item.id, item.filename)}
        onCanPlay={() => setLoading(false)}
        onEnded={onEnded}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </div>
  );
}

export default function Lightbox({ items, index, user, onClose, onNavigate, onDelete, onLikeToggle, onFavoriteToggle, onDateChange, initialSlideshow }: Props) {
  const item = items[index];
  const slides = toSlides(items);
  const viewedRef = useRef<Set<number>>(new Set());
  const mediaSectionRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [slideshow, setSlideshow] = useState(!!initialSlideshow);

  // 조회 기록
  useEffect(() => {
    if (!viewedRef.current.has(item.id)) {
      viewedRef.current.add(item.id);
      api.recordView(item.id).catch(() => {});
    }
  }, [item.id]);

  // body 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Escape로 닫기
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (slideshow) setSlideshow(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, slideshow]);

  // 슬라이드쇼 (영상일 땐 타이머 안 돌림 — onEnded로 넘김)
  const isVideo = item?.type === 'video';
  useEffect(() => {
    if (!slideshow || isVideo) return;
    const timer = setInterval(() => {
      onNavigate(index >= items.length - 1 ? 0 : index + 1);
    }, initialSlideshow ? 3000 : 5000);
    return () => clearInterval(timer);
  }, [slideshow, index, items.length, onNavigate, initialSlideshow, isVideo]);

  const handleVideoEnded = useCallback(() => {
    if (!slideshow) return;
    onNavigate(index >= items.length - 1 ? 0 : index + 1);
  }, [slideshow, index, items.length, onNavigate]);

  const toggleFullscreen = useCallback(() => {
    const el = mediaSectionRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const handleLike = useCallback(async () => {
    const result = await api.toggleLike(item.id);
    onLikeToggle(item.id, result.liked);
  }, [item.id, onLikeToggle]);

  const handleFavorite = useCallback(async () => {
    const result = await api.toggleFavorite(item.id);
    onFavoriteToggle(item.id, result.favorited);
  }, [item.id, onFavoriteToggle]);

  const handleDelete = useCallback(async () => {
    if (!confirm('정말 삭제할까요?')) return;
    await onDelete(item.id);
  }, [item.id, onDelete]);

  const canEdit = item.uploaderId === user.id || user.role === 'master';

  const handleDateEdit = useCallback(() => {
    setDateValue(item.createdAt.slice(0, 16).replace(' ', 'T'));
    setEditingDate(true);
  }, [item.createdAt]);

  const handleDateSave = useCallback(async () => {
    if (!dateValue) return;
    const newDate = dateValue.replace('T', ' ');
    try {
      const result = await api.updateMediaDate(item.id, newDate);
      onDateChange(item.id, result.createdAt);
    } catch {}
    setEditingDate(false);
  }, [item.id, dateValue, onDateChange]);

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} />

      <div className={styles.content}>
        {/* 미디어 영역 — YARL Inline */}
        <div className={styles.mediaSection} ref={mediaSectionRef}>
          <button onClick={onClose} className={styles.closeBtn}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <button onClick={toggleFullscreen} className={styles.fullscreenBtn}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
              {isFullscreen ? (
                <><polyline points="4 14 4 20 10 20"/><polyline points="20 10 20 4 14 4"/><line x1="14" y1="10" x2="20" y2="4"/><line x1="4" y1="20" x2="10" y2="14"/></>
              ) : (
                <><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></>
              )}
            </svg>
          </button>

          {initialSlideshow && (
            <div className={styles.slideshowCounter}>
              {index + 1} / {items.length}
            </div>
          )}

          <YarlLightbox
            plugins={[Inline, Zoom, Counter]}
            slides={slides}
            index={index}
            inline={{ style: { width: '100%', height: '100%', background: 'transparent' } }}
            on={{ view: ({ index: i }) => onNavigate(i) }}
            carousel={{ finite: !slideshow }}
            render={{
              slide: ({ slide, offset }) => {
                const mi = (slide as any).mediaItem as MediaItem | undefined;
                if (mi && offset === 0) return <HlsVideoSlide key={mi.id} item={mi} onEnded={handleVideoEnded} />;
                return undefined;
              },
            }}
            zoom={{ maxZoomPixelRatio: 3, doubleClickMaxStops: 2 }}
            className="yarl__lightbox--inline-custom"
          />
        </div>

        {/* 사이드 패널 — 전체화면 슬라이드쇼에선 숨김 */}
        {!initialSlideshow && <div className={styles.sidePanel}>
          <div className={styles.uploaderRow}>
            <div className={styles.uploaderAvatar}>
              {item.uploaderImage
                ? <img src={item.uploaderImage} alt="" />
                : <span>{item.uploaderName[0]}</span>
              }
            </div>
            <div>
              <div className={styles.uploaderName}>{item.uploaderName}</div>
              {editingDate ? (
                <div className={styles.dateEdit}>
                  <input
                    type="datetime-local"
                    value={dateValue}
                    onChange={e => setDateValue(e.target.value)}
                    className={styles.dateInput}
                  />
                  <button onClick={handleDateSave} className={styles.dateSaveBtn}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>
                  </button>
                  <button onClick={() => setEditingDate(false)} className={styles.dateCancelBtn}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ) : (
                <div className={styles.uploadTime}>
                  {item.createdAt.slice(2, 10).replace(/-/g, '.')}
                  {canEdit && (
                    <button onClick={handleDateEdit} className={styles.dateEditBtn}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={styles.actionBar}>
            <button className={`${styles.likeBtn} ${item.liked ? styles.liked : ''}`} onClick={handleLike}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill={item.liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              <span>{item.likeCount}</span>
            </button>
            <button className={`${styles.actionBtn} ${item.favorited ? styles.favorited : ''}`} onClick={handleFavorite}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill={item.favorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              {item.favorited ? '저장됨' : '저장'}
            </button>
            <button className={`${styles.actionBtn} ${slideshow ? styles.slideshowActive : ''}`} onClick={() => setSlideshow(!slideshow)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill={slideshow ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {slideshow
                  ? <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>
                  : <polygon points="5 3 19 12 5 21 5 3" />
                }
              </svg>
              {slideshow ? '정지' : '슬라이드쇼'}
            </button>
            <a href={api.downloadUrl(item.id)} className={styles.actionBtn}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              다운로드
            </a>
            {canEdit && (
              <button onClick={handleDelete} className={`${styles.actionBtn} ${styles.deleteBtn}`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                삭제
              </button>
            )}
          </div>

          <div className={styles.peopleSection}>
            {item.viewers.length > 0 && (
              <div className={styles.peopleRow}>
                <span className={styles.peopleIcon}>👁</span>
                <span className={styles.peopleNames}>{item.viewers.map(v => v.name).join(', ')}</span>
              </div>
            )}
            {item.downloaders.length > 0 && (
              <div className={styles.peopleRow}>
                <span className={styles.peopleIcon}>⬇</span>
                <span className={styles.peopleNames}>{item.downloaders.map(d => d.name).join(', ')}</span>
              </div>
            )}
            {item.shareCount > 0 && (
              <div className={styles.peopleRow}>
                <span className={styles.peopleIcon}>📤</span>
                <span className={styles.peopleNames}>공유 {item.shareCount}회</span>
              </div>
            )}
          </div>

          <div className={styles.commentsWrap}>
            <Comments mediaId={item.id} user={user} />
          </div>
        </div>}
      </div>
    </div>
  );
}
