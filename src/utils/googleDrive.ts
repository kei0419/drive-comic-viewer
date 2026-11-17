const TOKEN_STORAGE_KEY = 'gdrive_access_token';
const TOKEN_EXPIRES_AT_KEY = 'gdrive_token_expires_at';
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GoogleOAuth2Namespace {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }) => GoogleTokenClient;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOAuth2Namespace;
      };
    };
  }
}

export class AuthExpiredError extends Error {
  constructor(message = 'セッションの期限が切れました。Googleドライブに再接続してください。') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

let accessToken: string | null = null;
let tokenClient: GoogleTokenClient | null = null;
let onTokenReceivedCallback: ((token: string) => void) | null = null;
let pendingLoginResolve: ((token: string) => void) | null = null;
let pendingLoginReject: ((error: Error) => void) | null = null;

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  thumbnailLink?: string;
}

const saveTokenToStorage = (token: string, expiresInSeconds?: number | string) => {
  const parsedExpiresIn = typeof expiresInSeconds === 'string'
    ? parseInt(expiresInSeconds, 10)
    : expiresInSeconds;
  const ttlSeconds = parsedExpiresIn && !isNaN(parsedExpiresIn) ? parsedExpiresIn : 3599;
  const expiresAt = Date.now() + ttlSeconds * 1000;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(TOKEN_EXPIRES_AT_KEY, String(expiresAt));
  } catch (err) {
    console.warn('アクセストークンの保存に失敗しました:', err);
  }
};

const clearStoredToken = () => {
  accessToken = null;
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
  } catch (err) {
    console.warn('アクセストークンの削除に失敗しました:', err);
  }
};

const loadValidTokenFromStorage = (): string | null => {
  try {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const expiresAtStr = localStorage.getItem(TOKEN_EXPIRES_AT_KEY);
    if (!token || !expiresAtStr) {
      return null;
    }
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Date.now() >= expiresAt - TOKEN_SAFETY_MARGIN_MS) {
      clearStoredToken();
      return null;
    }
    return token;
  } catch {
    return null;
  }
};

const ensureValidAccessToken = (): string => {
  if (accessToken) {
    try {
      const expiresAtStr = localStorage.getItem(TOKEN_EXPIRES_AT_KEY);
      if (expiresAtStr) {
        const expiresAt = parseInt(expiresAtStr, 10);
        if (!isNaN(expiresAt) && Date.now() >= expiresAt - TOKEN_SAFETY_MARGIN_MS) {
          clearStoredToken();
          throw new AuthExpiredError();
        }
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
    }
    return accessToken;
  }

  const restoredToken = loadValidTokenFromStorage();
  if (restoredToken) {
    accessToken = restoredToken;
    return restoredToken;
  }

  throw new AuthExpiredError('認証されていません。Googleドライブに接続してください。');
};

/**
 * Google GIS SDK を初期化する
 */
export const initGoogleAuth = (clientId: string, onTokenReceived: (token: string) => void): Promise<void> => {
  onTokenReceivedCallback = onTokenReceived;

  const restoredToken = loadValidTokenFromStorage();
  if (restoredToken) {
    accessToken = restoredToken;
    onTokenReceived(restoredToken);
  }

  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error('Google Client ID が設定されていません。'));
      return;
    }

    const checkGoogleLoaded = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) {
        try {
          tokenClient = oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response: GoogleTokenResponse) => {
              if (response.error || !response.access_token) {
                console.error('Google Auth callback error:', response);
                const errorMsg = response.error_description || response.error || 'Google認証に失敗しました。';
                if (pendingLoginReject) {
                  pendingLoginReject(new Error(errorMsg));
                  pendingLoginResolve = null;
                  pendingLoginReject = null;
                }
              } else {
                accessToken = response.access_token;
                saveTokenToStorage(response.access_token, response.expires_in);
                onTokenReceivedCallback?.(response.access_token);
                if (pendingLoginResolve) {
                  pendingLoginResolve(response.access_token);
                  pendingLoginResolve = null;
                  pendingLoginReject = null;
                }
              }
            },
            error_callback: (err) => {
              console.error('Google Auth popup/error callback:', err);
              if (pendingLoginReject) {
                pendingLoginReject(new Error(err.message || '認証がキャンセルされたか、ポップアップがブロックされました。'));
                pendingLoginResolve = null;
                pendingLoginReject = null;
              }
            },
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      } else {
        setTimeout(checkGoogleLoaded, 100);
      }
    };

    checkGoogleLoaded();
  });
};

/**
 * Googleアカウントログインをリクエストする
 */
export const loginGoogle = (): Promise<string> => {
  if (!tokenClient) {
    return Promise.reject(new Error('Google Auth SDK が初期化されていません。設定画面でClient IDを保存してください。'));
  }

  if (pendingLoginReject) {
    pendingLoginReject(new Error('新しい認証リクエストによって中断されました。'));
    pendingLoginResolve = null;
    pendingLoginReject = null;
  }

  return new Promise((resolve, reject) => {
    pendingLoginResolve = resolve;
    pendingLoginReject = reject;
    try {
      // 期限切れ対策のために再承認を要求
      tokenClient!.requestAccessToken({ prompt: '' });
    } catch (err) {
      pendingLoginResolve = null;
      pendingLoginReject = null;
      reject(err instanceof Error ? err : new Error('認証リクエストの開始に失敗しました。'));
    }
  });
};

/**
 * ログアウトする
 */
export const logoutGoogle = () => {
  clearStoredToken();
};

export const getAccessToken = () => accessToken;

/**
 * Google Drive API への共通リクエストヘルパー
 */
const fetchFromDrive = async (url: string, options: RequestInit = {}) => {
  const token = ensureValidAccessToken();

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    clearStoredToken();
    throw new AuthExpiredError('セッションの期限が切れました。Googleドライブに再接続してください。');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Google Drive API エラー: ${response.statusText}`);
  }

  return response;
};

/**
 * 指定されたフォルダ内のサブフォルダおよび漫画ファイルをリストアップする
 */
export const listDriveContents = async (folderId: string = 'root'): Promise<DriveItem[]> => {
  // まずフォルダを取得
  const folderQuery = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const folderUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(folderQuery)}&fields=files(id,name,mimeType,size,thumbnailLink)&pageSize=1000`;
  
  // 次に漫画ファイルを取得 (mimeType + ファイル名で幅広くマッチ)
  const fileQuery = `'${folderId}' in parents and (mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed' or mimeType = 'application/x-rar-compressed' or mimeType = 'application/vnd.rar' or mimeType = 'application/x-cbz' or mimeType = 'application/x-cbr' or mimeType = 'application/octet-stream' or name contains '.zip' or name contains '.rar' or name contains '.cbz' or name contains '.cbr') and trashed = false`;
  const fileUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fileQuery)}&fields=files(id,name,mimeType,size,thumbnailLink)&pageSize=1000`;

  const [folderResponse, fileResponse] = await Promise.all([
    fetchFromDrive(folderUrl),
    fetchFromDrive(fileUrl)
  ]);
  
  const folderData = await folderResponse.json();
  const fileData = await fileResponse.json();

  const folders: DriveItem[] = folderData.files || [];
  
  // ファイル結果から、実際に漫画系の拡張子を持つものだけに絞り込む
  // (application/octet-stream はZIPやRARに使われることがあるが、他のファイルにも使われるため)
  const archiveExtensions = ['.zip', '.rar', '.cbz', '.cbr'];
  const files: DriveItem[] = (fileData.files || []).filter((f: DriveItem) => {
    const lowerName = f.name.toLowerCase();
    return archiveExtensions.some(ext => lowerName.endsWith(ext));
  });

  const items = [...folders, ...files];
  
  // フォルダを先頭、ファイルを後ろにして自然順ソート
  return items.sort((a, b) => {
    const isFolderA = a.mimeType === 'application/vnd.google-apps.folder';
    const isFolderB = b.mimeType === 'application/vnd.google-apps.folder';
    if (isFolderA && !isFolderB) return -1;
    if (!isFolderA && isFolderB) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
};

/**
 * フォルダ名を取得する (パンくずリスト作成等で使用)
 */
export const getFolderName = async (folderId: string): Promise<string> => {
  if (folderId === 'root') return 'マイドライブ';
  const url = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=name`;
  const response = await fetchFromDrive(url);
  const data = await response.json();
  return data.name || '無題のフォルダ';
};

/**
 * ファイルサイズを人間が読める形式に変換する
 */
export const formatBytes = (bytesStr?: string): string => {
  if (!bytesStr) return '';
  const bytes = parseInt(bytesStr, 10);
  if (isNaN(bytes) || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * ファイルのバイナリ(ArrayBuffer)をストリーミングダウンロードし、進捗をコールバックで返す
 */
export const downloadFileWithProgress = async (
  fileId: string,
  onProgress: (loaded: number, total: number) => void
): Promise<ArrayBuffer> => {
  const token = ensureValidAccessToken();

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearStoredToken();
      throw new AuthExpiredError('セッションの期限が切れました。Googleドライブに再接続してください。');
    }
    const errorText = await response.text();
    throw new Error(`ダウンロードエラー (${response.status}): ${errorText || response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  
  if (!response.body) {
    throw new Error('レスポンスボディを取得できません。');
  }

  const reader = response.body.getReader();
  let loadedBytes = 0;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    if (value) {
      chunks.push(value);
      loadedBytes += value.length;
      onProgress(loadedBytes, totalBytes);
    }
  }

  // chunksの結合
  const allChunks = new Uint8Array(loadedBytes);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.length;
  }

  return allChunks.buffer;
};
