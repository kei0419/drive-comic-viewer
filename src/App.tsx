import { useState, useEffect, useCallback } from 'react';
import { getSettings, saveSettings } from './utils/db';
import type { AppSettings, FavoritePathNode } from './utils/db';
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

  // 本棚の現在フォルダ階層（ビューワーから戻った際に元の階層を維持するためApp側で保持）
  const [currentFolderId, setCurrentFolderId] = useState<string>('root');
  const [folderPath, setFolderPath] = useState<FavoritePathNode[]>([{ id: 'root', name: 'マイドライブ' }]);
  
  // モーダル
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  // 初期ロードと認証初期化
  const loadAndInit = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void loadAndInit();
  }, [loadAndInit]);

  const handleLogin = async () => {
    try {
      await loginGoogle();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'ログイン中にエラーが発生しました。';
      alert(message);
    }
  };

  const handleLogout = () => {
    logoutGoogle();
    setIsAuthenticated(false);
    setCurrentFolderId('root');
    setFolderPath([{ id: 'root', name: 'マイドライブ' }]);
  };

  const handleSettingsSaved = () => {
    setIsAuthLoading(true);
    void loadAndInit();
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
          currentFolderId={currentFolderId}
          path={folderPath}
          onChangeFolder={(folderId, nextPath) => {
            setCurrentFolderId(folderId);
            setFolderPath(nextPath);
          }}
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
