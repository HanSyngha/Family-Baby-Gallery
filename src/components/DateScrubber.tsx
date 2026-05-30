import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import type { MediaItem, GalleryEvent } from '../api';
import styles from './DateScrubber.module.css';

interface Props {
  items: MediaItem[];
  events?: GalleryEvent[];          // 이벤트 자막(서브타이틀) — 풍선 우선 표시
  babyBirth?: string | null;        // 생일 → "N일" 폴백 라벨
  getScrollEl: () => HTMLElement | null; // 스크롤 컨테이너(AppShell .content)
  sectionPrefix?: string;           // 섹션 id 접두사 (기본 'month-')
}

interface DayGroup { dateKey: string; label: string; }

function ymLabel(dateKey: string) { return dateKey.slice(2, 7).replace('-', '.'); } // 24.08
function ymdLabel(dateKey: string) { return dateKey.slice(2).replace(/-/g, '.'); }  // 24.08.15

export default function DateScrubber({ items, events, babyBirth, getScrollEl, sectionPrefix = 'month-' }: Props) {
  const [dragging, setDragging] = useState(false);
  const [bubble, setBubble] = useState<{ y: number; text: string } | null>(null);
  const [showCal, setShowCal] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  // 날짜 그룹 + 각 그룹의 스크롤 위치 매핑은 실시간 계산(레이아웃 변동 대응)
  const months = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const it of items) { const m = (it.createdAt || '').slice(0, 7); if (m && !seen.has(m)) { seen.add(m); out.push(m); } }
    return out;
  }, [items]);

  // dateKey(YYYY-MM-DD 또는 YYYY-MM)에 해당하는 풍선 라벨: 이벤트 자막 우선
  const labelFor = useCallback((dateKey: string): string => {
    if (events && events.length) {
      const e = events.find(ev => dateKey >= ev.startDate && dateKey <= ev.endDate);
      if (e) {
        if (e.startDate === e.endDate) return e.title;
        const day = Math.floor((new Date(dateKey + 'T00:00:00').getTime() - new Date(e.startDate + 'T00:00:00').getTime()) / 86400000) + 1;
        return `${e.title} ${day}일차`;
      }
    }
    if (babyBirth) {
      const d = Math.floor((new Date(dateKey + 'T00:00:00').getTime() - new Date(babyBirth.slice(0, 10) + 'T00:00:00').getTime()) / 86400000) + 1;
      if (d >= 1) return `${ymLabel(dateKey)} · ${d}일`;
    }
    return dateKey.length > 7 ? ymdLabel(dateKey) : ymLabel(dateKey);
  }, [events, babyBirth]);

  // 현재 스크롤 비율 → 보이는 첫 섹션의 dateKey 추정
  const dateKeyAtScroll = useCallback((el: HTMLElement): string => {
    const top = el.scrollTop;
    let best = ''; let bestTop = -Infinity;
    for (const m of months) {
      const sec = document.getElementById(sectionPrefix + m);
      if (!sec) continue;
      const offset = (sec as HTMLElement).offsetTop;
      if (offset <= top + 4 && offset > bestTop) { bestTop = offset; best = m; }
    }
    return best || months[0] || '';
  }, [months, sectionPrefix]);

  // 트랙 위 y비율 → 스크롤 위치로 점프
  const scrubTo = useCallback((clientY: number) => {
    const el = getScrollEl(); const track = trackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const target = ratio * (el.scrollHeight - el.clientHeight);
    el.scrollTop = target;
    // 풍선 위치 + 라벨
    const dk = dateKeyAtScroll(el);
    setBubble({ y: clientY - rect.top, text: dk ? labelFor(dk) : '' });
  }, [getScrollEl, dateKeyAtScroll, labelFor]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
    scrubTo(e.clientY);
  }, [scrubTo]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const y = e.clientY;
    rafRef.current = requestAnimationFrame(() => scrubTo(y));
  }, [dragging, scrubTo]);
  const onPointerUp = useCallback(() => { setDragging(false); setTimeout(() => setBubble(null), 600); }, []);

  const jumpToMonth = useCallback((m: string) => {
    document.getElementById(sectionPrefix + m)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setShowCal(false);
  }, [sectionPrefix]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  if (months.length < 2) return null; // 점프할 게 거의 없으면 숨김

  return (
    <>
      {/* 우측 사이드 스크러버 */}
      <div
        ref={trackRef}
        className={`${styles.track} ${dragging ? styles.dragging : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className={styles.handle} aria-label="빠른 날짜 이동">
          <span /><span /><span />
        </div>
      </div>

      {bubble && (
        <div className={styles.bubble} style={{ top: bubble.y }}>{bubble.text}</div>
      )}

      {/* 캘린더 버튼 */}
      <button className={styles.calBtn} onClick={() => setShowCal(true)} aria-label="달력으로 이동">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {showCal && (
        <MonthCalendar months={months} labelFor={labelFor} onPick={jumpToMonth} onClose={() => setShowCal(false)} />
      )}
    </>
  );
}

// 월 그리드 팝업 (연도별). 미디어 있는 월만 활성.
function MonthCalendar({ months, labelFor, onPick, onClose }: {
  months: string[]; labelFor: (dk: string) => string; onPick: (m: string) => void; onClose: () => void;
}) {
  const available = new Set(months);
  const years = useMemo(() => {
    const ys = new Set<number>(); months.forEach(m => ys.add(parseInt(m.slice(0, 4))));
    return Array.from(ys).sort((a, b) => b - a);
  }, [months]);

  return (
    <div className={styles.calBackdrop} onClick={onClose}>
      <div className={styles.calSheet} onClick={e => e.stopPropagation()}>
        <div className={styles.calHandle} />
        <div className={styles.calTitle}>날짜로 이동</div>
        <div className={styles.calScroll}>
          {years.map(y => (
            <div key={y} className={styles.calYear}>
              <div className={styles.calYearLabel}>{y}</div>
              <div className={styles.calMonths}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map(mo => {
                  const key = `${y}-${String(mo).padStart(2, '0')}`;
                  const has = available.has(key);
                  return (
                    <button key={mo} disabled={!has}
                      className={`${styles.calMonth} ${has ? styles.calMonthOn : ''}`}
                      onClick={() => has && onPick(key)}>
                      {mo}월
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button className={styles.calClose} onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
