import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { api, type User, type MediaItem } from '../api';
import { useUploadQueue } from '../hooks/useUploadQueue';
import { useProcessingStatus } from '../hooks/useProcessingStatus';
import { usePinchColumns } from '../hooks/usePinchColumns';
import { usePushNotification } from '../hooks/usePushNotification';
import MediaGrid from '../components/MediaGrid';
import Lightbox from '../components/Lightbox';
import UploadModal from '../components/UploadModal';
import Admin from './Admin';
import styles from './Gallery.module.css';

interface Props {
  user: User;
  onLogout: () => void;
}

type SortMode = 'recent' | 'likes' | 'views' | 'favorites';

// 설이 생일 계산
const BIRTH = new Date(2026, 1, 19);
BIRTH.setHours(0, 0, 0, 0);
const MILESTONES = [50, 100, 200, 300, 365, 500, 730, 1000];

function getDaysSinceBirth() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - BIRTH.getTime()) / 86400000) + 1;
}

export default function Gallery({ user, onLogout }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [sort, setSort] = useState<SortMode>('recent');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sharing, setSharing] = useState(false);
  const [shuffledItems, setShuffledItems] = useState<{ id: number; filename: string; type: string }[] | null>(null);
  const initialLoad = useRef(false);

  const daysSinceBirth = getDaysSinceBirth();
  const isMilestone = MILESTONES.includes(daysSinceBirth);
  const isBirthday = (() => {
    const today = new Date();
    return today.getMonth() === BIRTH.getMonth() && today.getDate() === BIRTH.getDate();
  })();

  const loadMore = useCallback(async (cursor?: string | null, sortMode?: SortMode) => {
    const s = sortMode ?? sort;
    const data = await api.getMedia(cursor, s);
    if (cursor) {
      setItems(prev => [...prev, ...data.items]);
    } else {
      setItems(data.items);
    }
    setNextCursor(data.nextCursor);
  }, [sort]);

  const [pollingActive, setPollingActive] = useState(false);
  const processing = useProcessingStatus(pollingActive);

  const handleUploaded = useCallback(() => {
    setPollingActive(true);
    setTimeout(() => loadMore(null, sort), 1500);
  }, [loadMore, sort]);

  const uploadQueue = useUploadQueue(handleUploaded);
  const { columns, bind: bindPinch } = usePinchColumns();
  const { pushState, togglePush } = usePushNotification(true);
  const gridRef = useRef<HTMLElement>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  useEffect(() => {
    // 이미 설치된 경우 표시 안 함
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    loadMore().finally(() => setLoading(false));
  }, [loadMore]);

  useEffect(() => {
    return bindPinch(gridRef.current);
  }, [bindPinch]);

  useEffect(() => {
    if (processing.justFinished) {
      loadMore(null, sort);
      setPollingActive(false);
    }
  }, [processing.justFinished, loadMore, sort]);

  const handleSortChange = useCallback((newSort: SortMode) => {
    if (newSort === sort) return;
    setSort(newSort);
    setLoading(true);
    loadMore(null, newSort).finally(() => setLoading(false));
  }, [sort, loadMore]);

  const handleLoadMore = useCallback(() => {
    if (nextCursor) loadMore(nextCursor);
  }, [nextCursor, loadMore]);

  const handleDelete = useCallback(async (id: number) => {
    await api.deleteMedia(id);
    setItems(prev => prev.filter(i => i.id !== id));
    setLightboxIndex(null);
  }, []);

  const handleLikeToggle = useCallback((id: number, liked: boolean) => {
    setItems(prev =>
      prev.map(item =>
        item.id === id
          ? { ...item, liked, likeCount: item.likeCount + (liked ? 1 : -1) }
          : item
      )
    );
  }, []);

  const handleFavoriteToggle = useCallback((id: number, favorited: boolean) => {
    setItems(prev =>
      prev.map(item =>
        item.id === id ? { ...item, favorited } : item
      )
    );
  }, []);

  const handleDateChange = useCallback((id: number, createdAt: string) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, createdAt } : item));
  }, []);

  // 선택 모드
  const enterSelectMode = useCallback((firstId?: number) => {
    setSelectMode(true);
    if (firstId) setSelectedIds(new Set([firstId]));
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleItemClick = useCallback((index: number) => {
    if (selectMode) {
      toggleSelect(items[index].id);
    } else {
      openLightbox(index);
    }
  }, [selectMode, items]);

  // 공유
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;

  const handleShare = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setSharing(true);
    try {
      const files = await Promise.all(
        Array.from(selectedIds).map(async (id) => {
          const item = items.find(i => i.id === id)!;
          const res = await fetch(api.fileUrl(id, item.filename), { credentials: 'include' });
          const blob = await res.blob();
          return new File([blob], item.originalName, { type: item.mimeType });
        })
      );
      await navigator.share({ files } as any);
      // 공유 성공 시 기록
      Array.from(selectedIds).forEach(id => api.recordShare(id).catch(() => {}));
    } catch (e: any) {
      if (e.name !== 'AbortError') console.error('Share failed:', e);
    } finally {
      setSharing(false);
    }
  }, [selectedIds, items]);

  // 월별 타임라인
  const months = useMemo(() => {
    if (sort !== 'recent') return [];
    const seen = new Set<string>();
    return items.reduce<string[]>((acc, item) => {
      const m = item.createdAt.slice(0, 7);
      if (!seen.has(m)) { seen.add(m); acc.push(m); }
      return acc;
    }, []);
  }, [items, sort]);

  const scrollToMonth = useCallback((month: string) => {
    document.getElementById(`month-${month}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // 뒤로가기로 라이트박스/모달 닫기
  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
    history.pushState({ modal: 'lightbox' }, '');
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
    setShuffledItems(null);
    if (history.state?.modal === 'lightbox') history.back();
  }, []);

  const startRandomSlideshow = useCallback(async () => {
    const data = await api.getMediaIds();
    const arr = data.items;
    if (arr.length === 0) return;
    // Fisher-Yates shuffle x3
    for (let round = 0; round < 3; round++) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }
    setShuffledItems(arr);
    setLightboxIndex(0);
    history.pushState({ modal: 'lightbox' }, '');
  }, []);

  const openUpload = useCallback(() => {
    setShowUpload(true);
    history.pushState({ modal: 'upload' }, '');
  }, []);

  const closeUpload = useCallback(() => {
    setShowUpload(false);
    if (history.state?.modal === 'upload') history.back();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setLightboxIndex(null);
      setShowUpload(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <img src="/땅땅로고.png" alt="" className={styles.headerLogo} />
          <span className={styles.headerTitle}>땅콩땅콩땅콩콩땅</span>
        </div>
        <div className={styles.headerRight}>
          {!selectMode && items.length > 0 && (
            <button className={styles.selectBtn} onClick={startRandomSlideshow} title="랜덤 재생">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </button>
          )}
          {canShare && !selectMode && (
            <button className={styles.selectBtn} onClick={() => enterSelectMode()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M17.5 14v7M14 17.5h7" />
              </svg>
            </button>
          )}
          {selectMode && (
            <button className={styles.selectCancelBtn} onClick={exitSelectMode}>취소</button>
          )}
          <button className={styles.uploadBtn} onClick={() => openUpload()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            올리기
          </button>
          <div className={styles.menuWrap}>
            <button className={styles.avatar} onClick={() => setShowMenu(!showMenu)}>
              {user.profileImage
                ? <img src={user.profileImage} alt="" />
                : <span>{user.name[0]}</span>
              }
            </button>
            {showMenu && (
              <div className={styles.menu}>
                <div className={styles.menuName}>{user.name}</div>
                {pushState !== 'unsupported' && (
                  <button onClick={(e) => { e.stopPropagation(); togglePush(); }} className={styles.menuItem}>
                    <span>알림</span>
                    <span className={`${styles.toggle} ${pushState === 'on' ? styles.toggleOn : ''}`}>
                      <span className={styles.toggleKnob} />
                    </span>
                  </button>
                )}
                {pushState === 'denied' && (
                  <div className={styles.menuHint}>브라우저 설정에서 알림을 허용해주세요</div>
                )}
                {user.role === 'master' && (
                  <button onClick={() => { setShowMenu(false); setShowAdmin(true); }}>사용자 관리</button>
                )}
                <button onClick={() => { setShowMenu(false); onLogout(); }}>로그아웃</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={styles.main} ref={gridRef as React.RefObject<HTMLElement>}>
        {/* 앱 설치 배너 */}
        {installPrompt && (
          <div className={styles.pushBanner}>
            <span>땅콩땅콩 앱을 다운로드 해보세요</span>
            <button className={styles.pushBannerBtn} onClick={() => { installPrompt.prompt(); installPrompt.userChoice.then(() => setInstallPrompt(null)); }}>설치하기</button>
          </div>
        )}
        {/* 알림 배너 */}
        {pushState === 'off' && (
          <div className={styles.pushBanner}>
            <span>새 사진/영상이 올라오면 알림을 받아보세요</span>
            <button onClick={togglePush} className={styles.pushBannerBtn}>알림 켜기</button>
          </div>
        )}

        {/* 설이 배너 */}
        <div className={`${styles.babyBanner} ${isBirthday || isMilestone ? styles.babyMilestone : ''}`}>
          {isBirthday
            ? <>🎂 오늘은 설이 생일이에요! <strong>{daysSinceBirth === 1 ? '첫째 날' : `${Math.floor((daysSinceBirth - 1) / 365) + 1}번째 생일`}</strong> 🎉</>
            : isMilestone
              ? <>설이가 태어난지 <strong>{daysSinceBirth}일</strong> 되는 특별한 날이에요! 🎉</>
              : <>오늘은 설이가 태어난지 <strong>{daysSinceBirth}일</strong>째 되는 날이에요!</>
          }
        </div>

        {!loading && (items.length > 0 || sort !== 'recent') && (
          <div className={styles.sortBar}>
            <button
              className={`${styles.sortBtn} ${sort === 'recent' ? styles.sortActive : ''}`}
              onClick={() => handleSortChange('recent')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
              {sort === 'recent' && <span>최신순</span>}
            </button>
            <button
              className={`${styles.sortBtn} ${sort === 'likes' ? styles.sortActive : ''}`}
              onClick={() => handleSortChange('likes')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              {sort === 'likes' && <span>좋아요순</span>}
            </button>
            <button
              className={`${styles.sortBtn} ${sort === 'views' ? styles.sortActive : ''}`}
              onClick={() => handleSortChange('views')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {sort === 'views' && <span>조회순</span>}
            </button>
            <button
              className={`${styles.sortBtn} ${sort === 'favorites' ? styles.sortActive : ''}`}
              onClick={() => handleSortChange('favorites')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              {sort === 'favorites' && <span>즐겨찾기</span>}
            </button>
          </div>
        )}

        {/* 월별 타임라인 점프 */}
        {months.length > 1 && (
          <div className={styles.monthBar}>
            {months.map(m => (
              <button key={m} className={styles.monthChip} onClick={() => scrollToMonth(m)}>
                {m.slice(2).replace('-', '.')}
              </button>
            ))}
          </div>
        )}

        {processing.isProcessing && (
          <div className={styles.processingBanner}>
            <div className={styles.processingSpinner} />
            <span>
              {processing.current
                ? `'${processing.current.originalName}' 처리 중...`
                : '처리 대기 중...'}
              {processing.queueCount > 0 && ` (대기 ${processing.queueCount}개)`}
            </span>
          </div>
        )}

        {processing.recentErrors.map(err => (
          <div key={err.filename} className={styles.errorBanner}>
            <span>'{err.originalName}' 처리 실패</span>
            <button className={styles.errorDismiss} onClick={() => processing.dismissError(err.filename)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}

        {loading ? (
          <div className={styles.loading}>불러오는 중...</div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>
            <p>{sort === 'favorites' ? '즐겨찾기한 사진이 없어요' : '아직 사진이 없어요'}</p>
            {sort !== 'favorites' && <button onClick={() => openUpload()}>첫 사진 올리기</button>}
          </div>
        ) : (
          <MediaGrid
            items={items}
            onItemClick={handleItemClick}
            onLoadMore={handleLoadMore}
            hasMore={!!nextCursor}
            sort={sort}
            columns={columns}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onLongPress={canShare ? enterSelectMode : undefined}
            onLikeToggle={handleLikeToggle}
          />
        )}
      </main>

      {/* 선택 모드 하단 바 */}
      {selectMode && (
        <div className={styles.selectBar}>
          <span className={styles.selectCount}>{selectedIds.size}개 선택됨</span>
          <button
            className={styles.shareBtn}
            onClick={handleShare}
            disabled={selectedIds.size === 0 || sharing}
          >
            {sharing ? (
              <><div className={styles.shareBtnSpinner} />공유 중...</>
            ) : (
              <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>공유</>
            )}
          </button>
        </div>
      )}

      {/* 모바일 FAB */}
      {!selectMode && (
        <button className={styles.fab} onClick={() => openUpload()}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {/* 업로드 진행 미니 토스트 (모달 닫은 후에도 표시) */}
      {!showUpload && uploadQueue.activeCount > 0 && (
        <div className={styles.uploadToast} onClick={() => openUpload()}>
          <div className={styles.toastSpinner} />
          <span>
            {uploadQueue.doneCount}/{uploadQueue.totalCount} 업로드 중...
          </span>
          {uploadQueue.currentFile && (
            <div className={styles.toastProgress}>
              <div className={styles.toastProgressFill} style={{ width: `${uploadQueue.currentFile.progress}%` }} />
            </div>
          )}
        </div>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          items={(shuffledItems as any) ?? items}
          index={lightboxIndex}
          user={user}
          onClose={closeLightbox}
          onNavigate={setLightboxIndex}
          onDelete={handleDelete}
          onLikeToggle={handleLikeToggle}
          onFavoriteToggle={handleFavoriteToggle}
          onDateChange={handleDateChange}
          initialSlideshow={!!shuffledItems}
        />
      )}

      {showUpload && (
        <UploadModal
          uploadQueue={uploadQueue}
          onClose={closeUpload}
        />
      )}

      {showAdmin && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'var(--color-bg)', overflowY: 'auto' }}>
          <Admin user={user} onBack={() => setShowAdmin(false)} />
        </div>
      )}
    </div>
  );
}
