import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../api';

export interface UploadFile {
  file: File;
  progress: number;
  status: 'pending' | 'hashing' | 'uploading' | 'done' | 'duplicate' | 'error';
  retryCount: number;
}

export function useUploadQueue(onUploaded: () => void) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const uploadingRef = useRef(false);
  // 큐 전진 트리거. 파일 추가/직전 작업 완료 시 올린다.
  const [nudge, setNudge] = useState(0);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const mediaExts = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|mp4|mov|avi|mkv|webm|3gp|m4v)$/i;
    const items = Array.from(newFiles)
      .filter(f => f.type.startsWith('image/') || f.type.startsWith('video/') || mediaExts.test(f.name))
      .map(file => ({ file, progress: 0, status: 'pending' as const, retryCount: 0 }));
    if (items.length === 0) return;
    setFiles(prev => [...prev, ...items]);
    setNudge(n => n + 1);
  }, []);

  // 순차 처리: 해시 계산 → 중복 체크 → 업로드
  // nudge가 바뀔 때마다 큐를 한 칸 전진시킨다. uploadingRef를 해제한 "후"에
  // nudge를 올리므로(아래 finally), ref가 살아있는 채로 effect가 재실행되어
  // 다음 파일이 '대기'에서 멈추는 레이스가 생기지 않는다.
  useEffect(() => {
    if (uploadingRef.current) return;
    const pendingIdx = files.findIndex(f => f.status === 'pending');
    if (pendingIdx === -1) return;

    uploadingRef.current = true;
    const fileToUpload = files[pendingIdx].file;

    // 1. 해시 계산 중 표시
    setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'hashing' } : f));

    api.hashFile(fileToUpload)
      .then(async (hash) => {
        // 2. 서버에 중복 확인
        const check = await api.checkDuplicate(hash);
        if (check.duplicate) {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'duplicate', progress: 100 } : f));
          return;
        }

        // 3. 중복 아니면 업로드
        setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'uploading' } : f));

        const res = await api.uploadFile(fileToUpload, (pct) => {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, progress: pct } : f));
        });

        if (res.duplicate) {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'duplicate', progress: 100 } : f));
        } else {
          setFiles(prev => prev.map((f, i) => i === pendingIdx ? { ...f, status: 'done', progress: 100 } : f));
          onUploaded();
        }
      })
      .catch(() => {
        setFiles(prev => prev.map((f, i) => {
          if (i !== pendingIdx) return f;
          // 자동 재시도 2회
          if (f.retryCount < 2) {
            return { ...f, status: 'pending', progress: 0, retryCount: f.retryCount + 1 };
          }
          return { ...f, status: 'error' };
        }));
      })
      .finally(() => {
        uploadingRef.current = false;
        setNudge(n => n + 1);
      });
  }, [nudge]);

  // beforeunload
  useEffect(() => {
    const hasActive = files.some(f => f.status === 'uploading' || f.status === 'pending' || f.status === 'hashing');
    if (!hasActive) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [files]);

  const retryFile = useCallback((index: number) => {
    setFiles(prev => prev.map((f, i) =>
      i === index && f.status === 'error'
        ? { ...f, status: 'pending' as const, progress: 0, retryCount: 0 }
        : f
    ));
    setNudge(n => n + 1);
  }, []);

  const clearDone = useCallback(() => {
    setFiles(prev => prev.filter(f => f.status !== 'done' && f.status !== 'error' && f.status !== 'duplicate'));
  }, []);

  const doneCount = files.filter(f => f.status === 'done').length;
  const dupCount = files.filter(f => f.status === 'duplicate').length;
  const totalCount = files.length;
  const activeCount = files.filter(f => f.status === 'uploading' || f.status === 'pending' || f.status === 'hashing').length;
  const currentFile = files.find(f => f.status === 'uploading');

  return { files, addFiles, clearDone, retryFile, doneCount, dupCount, totalCount, activeCount, currentFile };
}
