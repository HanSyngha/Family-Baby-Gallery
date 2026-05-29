import { useState } from 'react';
import { api, type GalleryEvent } from '../api';

const COLORS = ['#946b2d', '#E8943A', '#C0392B', '#27AE60', '#2980B9', '#8E44AD', '#D88C00', '#E84393'];

interface Props {
  date: string;                 // 롱프레스한 날짜 YYYY-MM-DD
  event: GalleryEvent | null;   // 그 날짜를 덮는 기존 이벤트 (없으면 신규)
  onSaved: () => void;
  onClose: () => void;
  onApply?: (id: number) => Promise<void>;  // 구 앱에서만: 신규앱 적용
}

export default function EventModal({ date, event, onSaved, onClose, onApply }: Props) {
  const [title, setTitle] = useState(event?.title ?? '');
  const [startDate, setStart] = useState(event?.startDate ?? date);
  const [endDate, setEnd] = useState(event?.endDate ?? date);
  const [color, setColor] = useState(event?.color ?? COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);

  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const input = { title: title.trim(), startDate, endDate, color };
      if (event) await api.updateGalleryEvent(event.id, input);
      else await api.createGalleryEvent(input);
      onSaved();
    } catch { setBusy(false); }
  };
  const remove = async () => {
    if (!event || busy || !confirm('이 자막을 삭제할까요?')) return;
    setBusy(true);
    try { await api.deleteGalleryEvent(event.id); onSaved(); } catch { setBusy(false); }
  };
  const apply = async () => {
    if (!event || !onApply || busy) return;
    setBusy(true);
    try { await onApply(event.id); setApplied(true); } finally { setBusy(false); }
  };

  const box = { fontFamily: 'var(--font-body)' };
  const label = { fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)', margin: '12px 0 5px', display: 'block' };
  const input = { width: '100%', padding: '11px 13px', border: '1px solid var(--color-border)', borderRadius: 12, fontSize: 15, color: 'var(--color-text)', background: 'var(--color-surface)', outline: 'none' } as const;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,18,15,0.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'fadeIn 0.2s ease' }}>
      <div onClick={e => e.stopPropagation()} style={{ ...box, width: '100%', maxWidth: 440, background: 'var(--color-surface)', borderRadius: '22px 22px 0 0', padding: '22px 20px calc(20px + env(safe-area-inset-bottom))', boxShadow: 'var(--shadow-xl)', animation: 'slideUp 0.32s cubic-bezier(0.22,1,0.36,1)' }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--color-border)', margin: '0 auto 14px' }} />
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 800, color: 'var(--color-text)', letterSpacing: '-0.5px' }}>{event ? '자막 수정' : '자막 추가'}</h3>

        <label style={label}>제목</label>
        <input style={input} value={title} autoFocus placeholder="예: 제주도 여행" onChange={e => setTitle(e.target.value)} />

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>시작</label>
            <input type="date" style={input} value={startDate} onChange={e => setStart(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>종료</label>
            <input type="date" style={input} value={endDate} onChange={e => setEnd(e.target.value)} />
          </div>
        </div>
        {startDate !== endDate && (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
            여러 날을 묶으면 <b style={{ color }}>{title || '제목'} N일차</b> 로 표시돼요
          </div>
        )}

        <label style={label}>색상</label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{ width: 30, height: 30, borderRadius: '50%', background: c, border: color === c ? '3px solid var(--color-text)' : '3px solid transparent', boxShadow: 'var(--shadow-sm)', transition: 'transform 0.12s', transform: color === c ? 'scale(1.12)' : 'scale(1)' }} />
          ))}
        </div>

        {event && onApply && (
          <button onClick={apply} disabled={busy || applied} style={{ width: '100%', marginTop: 16, padding: 12, borderRadius: 12, background: applied ? 'var(--color-success)' : 'var(--color-primary-bg)', color: applied ? '#fff' : 'var(--color-primary)', fontSize: 14, fontWeight: 700 }}>
            {applied ? '✓ 신규앱에 적용됨' : '신규앱(땅콩패밀리)에 적용'}
          </button>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          {event && <button onClick={remove} disabled={busy} style={{ padding: '13px 20px', borderRadius: 12, background: 'rgba(255,59,48,0.1)', color: 'var(--color-danger)', fontSize: 15, fontWeight: 700 }}>삭제</button>}
          <button onClick={save} disabled={busy || !title.trim()} style={{ flex: 1, padding: 13, borderRadius: 12, background: 'var(--color-primary)', color: '#fff', fontSize: 15, fontWeight: 700, opacity: (!title.trim() || busy) ? 0.5 : 1 }}>{busy ? '저장 중...' : '저장'}</button>
        </div>
      </div>
    </div>
  );
}
