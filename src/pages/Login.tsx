import styles from './Login.module.css';

const IS_PWA = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches;

function handleLogin(e: React.MouseEvent, provider: string) {
  e.preventDefault();
  document.cookie = `app_mode=${IS_PWA ? 'pwa' : 'browser'}; path=/; max-age=300; SameSite=Lax`;
  window.location.href = `/api/auth/${provider}`;
}

export default function Login() {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <img src="/땅땅로고.png" alt="땅콩땅콩땅콩콩땅" className={styles.logo} />
        <h1 className={styles.title}>땅콩땅콩땅콩콩땅</h1>
        <p className={styles.subtitle}>우리끼리 사진 공유</p>

        <div className={styles.buttons}>
          <a href="/api/auth/kakao" onClick={(e) => handleLogin(e, 'kakao')} className={styles.kakao}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#3d1d00">
              <path d="M12 3C6.48 3 2 6.36 2 10.44c0 2.62 1.75 4.93 4.38 6.24l-1.12 4.16c-.1.36.3.65.62.45l4.97-3.27c.37.03.75.05 1.15.05 5.52 0 10-3.36 10-7.63S17.52 3 12 3z"/>
            </svg>
            카카오로 시작하기 <span className={styles.recommend}>권장</span>
          </a>
          <a href="/api/auth/naver" onClick={(e) => handleLogin(e, 'naver')} className={styles.naver}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#fff">
              <path d="M14.4 12.6L9.3 5H5v14h4.6v-7.6L14.7 19H19V5h-4.6z"/>
            </svg>
            네이버로 시작하기
          </a>
        </div>
      </div>
    </div>
  );
}
