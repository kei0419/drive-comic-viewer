import { useState, useEffect } from 'react';
import { getSettings, saveSettings } from './utils/db';
import type { AppSettings } from './utils/db';
import { initGoogleAuth, loginGoogle, logoutGoogle } from './utils/googleDrive';
import { AuthScreen } from './components/AuthScreen';
import { FileBrowser } from './components/FileBrowser';
import { ComicViewer } from './components/ComicViewer';
import { SettingsModal } from './components/SettingsModal';

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  
  // 選択中の漫画
  const [activeComic, setActiveComic] = useState<{ id: string; name: string } | null>(null);
  
  // モーダル
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  // 初期ロードと認証初期化
  const loadAndInit = async () => {
    setIsAuthLoading(true);
    try {
      const savedSettings = await getSettings();
      setSettings(savedSettings);

      // HTMLテーマの初期設定
      document.documentElement.setAttribute('data-theme', savedSettings.theme);

      if (savedSettings.clientId) {
        // Google Identity Services (GIS) SDK の初期化
        await initGoogleAuth(savedSettings.clientId, (token) => {
          if (token) {
            setIsAuthenticated(true);
          }
        });
      }
    } catch (err) {
      console.error('Initialization error:', err);
    } finally {
      setIsAuthLoading(false);
    }
  };

  useEffect(() => {
    loadAndInit();
  }, []);

  const handleLogin = () => {
    try {
      loginGoogle();
    } catch (err: any) {
      alert(err.message || 'ログイン中にエラーが発生しました。');
    }
  };

  const handleLogout = () => {
    logoutGoogle();
    setIsAuthenticated(false);
  };

  const handleSettingsSaved = () => {
    loadAndInit();
  };

  const handleThemeChange = async (newTheme: 'light' | 'dark') => {
    if (settings) {
      const updated = { ...settings, theme: newTheme };
      setSettings(updated);
      document.documentElement.setAttribute('data-theme', newTheme);
      await saveSettings(updated);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="flex-center" style={{ height: '100vh', flexDirection: 'column', gap: '16px' }}>
        <div className="spinner" />
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>初期設定を読み込み中...</p>
      </div>
    );
  }

  // 漫画ビューア表示
  if (activeComic) {
    return (
      <ComicViewer
        fileId={activeComic.id}
        comicName={activeComic.name}
        onClose={() => setActiveComic(null)}
      />
    );
  }

  return (
    <>
      {isAuthenticated ? (
        <FileBrowser
          onLogout={handleLogout}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onSelectComic={(id, name) => setActiveComic({ id, name })}
          theme={settings?.theme || 'dark'}
          onChangeTheme={handleThemeChange}
        />
      ) : (
        <AuthScreen
          hasClientId={!!settings?.clientId}
          onLogin={handleLogin}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsSaved={handleSettingsSaved}
      />
    </>
  );
}

export default App;
// CSSの警告対策として空エクスポートを回避
