import { useNavigate } from 'react-router-dom';
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { api, type User, type MediaItem, type GalleryEvent } from '../api';
import { useUploadQueue } from '../hooks/useUploadQueue';
import { useProcessingStatus } from '../hooks/useProcessingStatus';
import { usePinchColumns } from '../hooks/usePinchColumns';
import { usePushNotification } from '../hooks/usePushNotification';
import MediaGrid from '../components/MediaGrid';
import Lightbox from '../components/Lightbox';
import ShortsViewer from '../components/ShortsViewer';
import UploadModal from '../components/UploadModal';
import Admin from './Admin';
import DateScrubber from '../components/DateScrubber';
import styles from './Gallery.module.css';
import Icon from '../components/ui/Icon';

interface Props {
  user: User;
  onLogout: () => void;
}

type SortMode = 'recent' | 'likes' | 'views' | 'favorites';
const SHORTS_LAUNCH_KEY = 'peanut-share:shorts-launch:v1';

// 업로드 복원(#3): viewer(부모님·친척)가 구앱에 올리면 땅콩페밀리 땅땅&콩콩으로 동기화됨.
// 기본 활성. env VITE_UPLOAD_ENABLED='false'로만 비활성(kill-switch).
const UPLOAD_ENABLED = import.meta.env.VITE_UPLOAD_ENABLED !== 'false';

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
  const navigate = useNavigate();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [prevCursor, setPrevCursor] = useState<string | null>(null); // 날짜 점프 후 위(더 최근)로 이어 불러올 커서
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showShorts, setShowShorts] = useState(false);
  const [showShortsLaunch, setShowShortsLaunch] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [sort, setSort] = useState<SortMode>('recent');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sharing, setSharing] = useState(false);
  const [shuffledItems, setShuffledItems] = useState<{ id: number; filename: string; type: string }[] | null>(null);
  const initialLoad = useRef(false);
  const nextCursorRef = useRef<string | null>(null);
  const [allMedia, setAllMedia] = useState<{ id: number; filename: string; type: string; createdAt: string }[]>([]);
  const [jumping, setJumping] = useState(false);

  const daysSinceBirth = getDaysSinceBirth();
  const isMilestone = MILESTONES.includes(daysSinceBirth);
  const isBirthday = (() => {
    const today = new Date();
    return today.getMonth() === BIRTH.getMonth() && today.getDate() === BIRTH.getDate();
  })();

  // 목록을 통째로 바꿀 때(처음부터·날짜 점프)마다 +1. 그 전에 나간 요청의 응답은 버린다
  // (점프 직전에 진행 중이던 '더 불러오기'가 새 목록 뒤에 붙고 커서를 옛 위치로 되돌리던 문제)
  const listGenRef = useRef(0);

  const loadMore = useCallback(async (cursor?: string | null, sortMode?: SortMode) => {
    const s = sortMode ?? sort;
    const gen = cursor ? listGenRef.current : ++listGenRef.current;
    const data = await api.getMedia(cursor, s);
    if (gen !== listGenRef.current) return null;
    if (cursor) {
      setItems(prev => [...prev, ...data.items]);
    } else {
      setItems(data.items);
      setPrevCursor(null);
    }
    setNextCursor(data.nextCursor);
    nextCursorRef.current = data.nextCursor;
    return data.nextCursor;
  }, [sort]);

  // 전체 미디어 날짜(달) — 날짜 이동 달력이 '아직 안 불러온 과거 달'도 보여주도록
  useEffect(() => {
    let alive = true;
    api.getMediaIds().then(d => { if (alive) setAllMedia(d.items); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const key = `${SHORTS_LAUNCH_KEY}:user:${user.id}`;
    try {
      if (localStorage.getItem(key) === 'seen') return;
      localStorage.setItem(key, 'seen');
      setShowShortsLaunch(true);
    } catch {
      setShowShortsLaunch(true);
    }
  }, [user.id]);

  const allMonths = useMemo(() => {
    const set = new Set<string>();
    for (const m of allMedia) { const ym = (m.createdAt || '').slice(0, 7); if (ym) set.add(ym); }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [allMedia]);

  const allDays = useMemo(() => {
    const set = new Set<string>();
    for (const m of allMedia) { const d = (m.createdAt || '').slice(0, 10); if (d) set.add(d); }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [allMedia]);

  // 특정 날짜로 '바로' 점프: 서버 커서를 그 날짜로 세팅 → 요청 1번으로 그 지점부터 로드.
  // (예전 방식은 지금~그 날짜까지 페이지를 전부 순차 로드해서 옛날일수록 끝없이 걸렸음)
  // 위쪽은 첫 항목을 prevCursor로 두고, 맨 위 근처에 오면 그보다 최근 것을 앞에 붙인다.
  const jumpToDate = useCallback(async (cursor: string) => {
    setJumping(true);
    const gen = ++listGenRef.current;
    try {
      const data = await api.getMedia(cursor, 'recent');
      if (gen !== listGenRef.current) return;
      setItems(data.items);
      setNextCursor(data.nextCursor);
      nextCursorRef.current = data.nextCursor;
      setPrevCursor(data.items.length ? `${data.items[0].createdAt}|${data.items[0].id}` : null);
      requestAnimationFrame(() => { const el = getScrollEl(); if (el) el.scrollTop = 0; });
    } catch { /* 무시 */ } finally {
      setJumping(false);
    }
    // getScrollEl은 stable이라 deps 생략
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 월: 그 달 끝(YYYY-MM-99)부터 / 일: 그 날 끝(YYYY-MM-DD 99)부터 — createdAt < cursor 문자열 비교
  const jumpToMonth = useCallback((month: string) => jumpToDate(`${month}-99`), [jumpToDate]);
  const jumpToDay = useCallback((day: string) => jumpToDate(`${day} 99`), [jumpToDate]);

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
  const [events, setEvents] = useState<GalleryEvent[]>([]);
  useEffect(() => { api.getGalleryEvents().then(setEvents).catch(() => {}); }, []);
  // 빠른 날짜 이동: 그리드의 가장 가까운 스크롤 부모
  const getScrollEl = useCallback((): HTMLElement | null => {
    let el = gridRef.current as HTMLElement | null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return document.scrollingElement as HTMLElement | null;
  }, []);

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

  const loadingMoreRef = useRef(false);
  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    loadMore(nextCursor).finally(() => { loadingMoreRef.current = false; });
  }, [nextCursor, loadMore]);

  // 위로 끼워 넣을 때 화면이 튀지 않게: 붙이기 직전 스크롤 위치·높이를 기억했다가
  // 렌더 직후(페인트 전) 늘어난 높이만큼 내려 준다.
  const prependAnchorRef = useRef<{ el: HTMLElement; top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const a = prependAnchorRef.current;
    if (!a) return;
    prependAnchorRef.current = null;
    // html { scroll-behavior: smooth }면 보정까지 애니메이션돼 화면이 내려갔다 미끄러져 온다 → 이 순간만 즉시 이동
    const prev = a.el.style.scrollBehavior;
    a.el.style.scrollBehavior = 'auto';
    a.el.scrollTop = a.top + (a.el.scrollHeight - a.height);
    a.el.style.scrollBehavior = prev;
  }, [items]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const loadingNewerRef = useRef(false);
  const handleLoadNewer = useCallback(() => {
    if (!prevCursor || loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    const gen = listGenRef.current;
    api.getMediaNewer(prevCursor).then(data => {
      if (gen !== listGenRef.current) return;
      const el = getScrollEl();
      if (el) prependAnchorRef.current = { el, top: el.scrollTop, height: el.scrollHeight };
      const have = new Set(itemsRef.current.map(i => i.id));
      const fresh = data.items.filter(i => !have.has(i.id));
      setItems(prev => [...fresh, ...prev]);
      setPrevCursor(data.prevCursor);
      // 라이트박스가 열려 있으면 보던 사진이 바뀌지 않게 번호를 민다(셔플 재생은 별도 목록이라 제외)
      if (!shuffledItems && fresh.length) setLightboxIndex(i => (i === null ? i : i + fresh.length));
    }).catch(() => {}).finally(() => { loadingNewerRef.current = false; });
    // getScrollEl은 stable이라 deps 생략
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevCursor, shuffledItems]);

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

  // 선택한 항목만 무한 반복 재생
  const playSelected = useCallback(() => {
    const sel = items.filter(i => selectedIds.has(i.id));
    if (sel.length === 0) return;
    setShuffledItems(sel as any);
    setLightboxIndex(0);
    history.pushState({ modal: 'lightbox' }, '');
    exitSelectMode();
  }, [items, selectedIds, exitSelectMode]);

  // 선택한 항목 일괄 다운로드 (순차)
  const downloadSelected = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    ids.forEach((id, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = api.downloadUrl(id);
        a.setAttribute('download', '');
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 500);
    });
  }, [selectedIds]);

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

  // 페밀리앱에서 들어온 master에게만 '땅콩페밀리로' 돌아가기 제공 (non-master는 페밀리앱 접근 경로 없음)
  const fromFamily = (() => { try { return sessionStorage.getItem('peanut_from_family') === '1'; } catch { return false; } })();

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          {fromFamily && user.role === 'master' && (
            <button
              onClick={() => { window.location.href = 'https://syngha.synology.me:2290'; }}
              aria-label="땅콩페밀리로 돌아가기"
              style={{ background: 'none', border: 'none', padding: '4px 6px 4px 0', display: 'flex', alignItems: 'center', color: 'var(--color-text)', cursor: 'pointer' }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          )}
          <img src="/땅땅로고.png" alt="" className={styles.headerLogo} />
          <span className={styles.headerTitle}>땅콩땅콩땅콩콩땅</span>
        </div>
        <div className={styles.headerRight}>
          {!selectMode && (
            <button
              className={styles.selectBtn}
              onClick={() => navigate('/game')}
              title="설이 키우기"
              aria-label="설이 키우기"
            >
              <Icon name="baby" size={16} />
            </button>
          )}
          {!selectMode && items.length > 0 && (
            <button
              className={`${styles.selectBtn} ${showShortsLaunch ? styles.shortsLaunchBtn : ''}`}
              onClick={() => {
                setShowShortsLaunch(false);
                setShowShorts(true);
              }}
              title="영상 쇼츠"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="3" /><path d="m10 9 5 3-5 3V9z" fill="currentColor" stroke="none" /></svg>
            </button>
          )}
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
          {UPLOAD_ENABLED && (
            <button className={styles.uploadBtn} onClick={() => openUpload()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              올리기
            </button>
          )}
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

        {showShortsLaunch && (
          <div className={styles.shortsLaunchBanner}>
            <div>
              <strong>신규 기능론칭! (땅땅쇼츠)</strong>
              <span>영상만 쇼츠처럼 넘겨볼 수 있어요.</span>
            </div>
            <div className={styles.shortsLaunchActions}>
              <button
                onClick={() => {
                  setShowShortsLaunch(false);
                  setShowShorts(true);
                }}
              >
                보기
              </button>
              <button className={styles.shortsLaunchClose} onClick={() => setShowShortsLaunch(false)} aria-label="런칭 안내 닫기">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
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
            {UPLOAD_ENABLED && sort !== 'favorites' && <button onClick={() => openUpload()}>첫 사진 올리기</button>}
          </div>
        ) : (
          <MediaGrid
            items={items}
            onItemClick={handleItemClick}
            onLoadMore={handleLoadMore}
            hasMore={!!nextCursor}
            onLoadNewer={handleLoadNewer}
            hasNewer={sort === 'recent' && !!prevCursor}
            sort={sort}
            columns={columns}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onLongPress={canShare ? enterSelectMode : undefined}
           
            isAdmin={user.role === 'master'}
          />
        )}

        {/* 빠른 날짜 이동: 사이드 스크러버 + 캘린더 */}
        {sort === 'recent' && items.length > 0 && (
          <DateScrubber
            items={items}
            events={events}
            babyBirth="2026-02-19"
            getScrollEl={getScrollEl}
            hasMore={!!nextCursor}
            allMonths={allMonths}
            onJumpToMonth={jumpToMonth}
            allDays={allDays}
            onJumpToDay={jumpToDay}
          />
        )}
        {jumping && (
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1100, background: '#1c1c1e', color: '#fff', padding: '10px 18px', borderRadius: 999, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
            과거 사진 불러오는 중…
          </div>
        )}
      </main>

      {/* 선택 모드 하단 바 */}
      {selectMode && (
        <div className={styles.selectBar}>
          <span className={styles.selectCount}>{selectedIds.size}개 선택됨</span>
          <div className={styles.selectActions}>
          <button
            className={styles.playBtn}
            onClick={playSelected}
            disabled={selectedIds.size === 0}
            title="선택 항목 반복재생"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            재생
          </button>
          <button
            className={styles.downloadBtn}
            onClick={downloadSelected}
            disabled={selectedIds.size === 0}
            title="선택 항목 다운로드"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            저장
          </button>
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
        </div>
      )}

      {/* 모바일 FAB */}
      {UPLOAD_ENABLED && !selectMode && (
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
          hasMore={!shuffledItems && !!nextCursor}
          onLoadMore={handleLoadMore}
        />
      )}

      {showShorts && (
        <ShortsViewer
          user={user}
          onClose={() => setShowShorts(false)}
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
