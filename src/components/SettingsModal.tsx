import React, { useState, useEffect } from 'react';
import { X, Save, Sun, Moon, Info, RefreshCw } from 'lucide-react';
import { getSettings, saveSettings } from '../utils/db';
import styles from '../styles/SettingsModal.module.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onSettingsSaved
}) => {
  const [clientId, setClientId] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      getSettings().then(settings => {
        setClientId(settings.clientId);
        setTheme(settings.theme);
      });
    }
  }, [isOpen]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveSettings({ clientId: clientId.trim(), theme });
    // HTMLのdata-theme属性を更新してテーマを即時反映
    document.documentElement.setAttribute('data-theme', theme);
    onSettingsSaved();
    onClose();
  };

  // アプリケーションのアセットキャッシュとサービスワーカーを完全にクリアして再読み込み
  const handleForceUpdate = async () => {
    if (!window.confirm('アプリを最新バージョンに更新し、再起動しますか？\n(ダウンロードしたマンガのデータは消えません)')) {
      return;
    }
    
    setIsUpdating(true);
    try {
      // 1. すべてのサービスワーカー登録を解除
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.unregister();
        }
      }

      // 2. ブラウザのアセットキャッシュストレージ（Cache API）をクリア
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (const cacheName of cacheNames) {
          await caches.delete(cacheName);
        }
      }

      // 3. ページをサーバーから強制再読み込み
      window.location.reload();
    } catch (err) {
      console.error('Failed to update app:', err);
      alert('更新に失敗しました。時間をおいて再度お試しください。');
      setIsUpdating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`glass-panel ${styles.modal}`} onClick={e => e.stopPropagation()}>
        <header className={styles.header}>
          <h2>設定</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="閉じる">
            <X size={20} />
          </button>
        </header>

        <form onSubmit={handleSave} className={styles.form}>
          <div className={styles.formGroup}>
            <label htmlFor="clientId" className={styles.label}>
              Google OAuth クライアントID
            </label>
            <input
              type="text"
              id="clientId"
              className={styles.input}
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              placeholder="例: xxxxxxxxxx-xxxxxxxxxx.apps.googleusercontent.com"
              required
            />
            <div className={styles.infoBox}>
              <Info size={16} className={styles.infoIcon} />
              <p className={styles.infoText}>
                Google Cloud Consoleでプロジェクトを作成し、「ウェブ アプリケーション」のクライアントIDを生成してください。承認済みの JavaScript 生成元に現在のURLを追加する必要があります。
              </p>
            </div>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label}>テーマ設定</label>
            <div className={styles.themeToggleGroup}>
              <button
                type="button"
                className={`${styles.themeBtn} ${theme === 'light' ? styles.active : ''}`}
                onClick={() => setTheme('light')}
              >
                <Sun size={18} />
                ライトモード
              </button>
              <button
                type="button"
                className={`${styles.themeBtn} ${theme === 'dark' ? styles.active : ''}`}
                onClick={() => setTheme('dark')}
              >
                <Moon size={18} />
                ダークモード
              </button>
            </div>
          </div>

          <div className={styles.formGroup} style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px' }}>
            <label className={styles.label}>システム管理</label>
            <button
              type="button"
              className="btn-secondary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px' }}
              onClick={handleForceUpdate}
              disabled={isUpdating}
            >
              <RefreshCw size={16} className={isUpdating ? 'spin' : ''} />
              {isUpdating ? '更新中...' : 'アプリのキャッシュをクリアして再起動'}
            </button>
          </div>

          <footer className={styles.footer}>
            <button type="button" className="btn-secondary" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn-primary">
              <Save size={18} />
              保存する
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
