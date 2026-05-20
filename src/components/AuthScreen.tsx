import React from 'react';
import { LogIn, Settings } from 'lucide-react';
import styles from '../styles/AuthScreen.module.css';

interface AuthScreenProps {
  hasClientId: boolean;
  onLogin: () => void;
  onOpenSettings: () => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  hasClientId,
  onLogin,
  onOpenSettings
}) => {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <button 
          className={styles.settingsBtn} 
          onClick={onOpenSettings} 
          aria-label="設定を開く"
        >
          <Settings size={22} />
        </button>
      </header>

      <main className={styles.main}>
        <div className={`glass-panel ${styles.card}`}>
          <div className={styles.logoArea}>
            <div className={styles.logoIcon}>🔮</div>
            <h1 className={styles.title}>Cloud Comic Reader</h1>
            <p className={styles.subtitle}>
              Googleドライブ上のマンガ（zip / rar）を<br />
              ダウンロードしながらブラウザで直接読む
            </p>
          </div>

          <div className={styles.actionArea}>
            {hasClientId ? (
              <button className="btn-primary" onClick={onLogin}>
                <LogIn size={20} />
                Googleドライブに接続
              </button>
            ) : (
              <div className={styles.alertBox}>
                <p className={styles.alertText}>
                  アプリを動作させるには、はじめにGoogleのクライアントIDの設定が必要です。
                </p>
                <button className="btn-primary" onClick={onOpenSettings}>
                  <Settings size={20} />
                  設定画面を開く
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <p>Cloud Comic Reader &copy; 2026 - Serverless Client-Side PWA</p>
      </footer>
    </div>
  );
};
