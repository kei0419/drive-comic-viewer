let accessToken: string | null = null;
let tokenClient: any = null;

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  thumbnailLink?: string;
}

/**
 * Google GIS SDK を初期化する
 */
export const initGoogleAuth = (clientId: string, onTokenReceived: (token: string) => void): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error('Google Client ID が設定されていません。'));
      return;
    }
    
    const checkGoogleLoaded = () => {
      // @ts-ignore
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        try {
          // @ts-ignore
          tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response: any) => {
              if (response.error) {
                console.error('Google Auth callback error:', response);
                reject(response);
              } else {
                accessToken = response.access_token;
                onTokenReceived(response.access_token);
                resolve();
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
export const loginGoogle = () => {
  if (tokenClient) {
    // 期限切れ対策のために再承認を要求
    tokenClient.requestAccessToken({ prompt: '' });
  } else {
    throw new Error('Google Auth SDK が初期化されていません。Settings画面でClient IDを保存してください。');
  }
};

/**
 * ログアウトする
 */
export const logoutGoogle = () => {
  accessToken = null;
};

export const getAccessToken = () => accessToken;

/**
 * Google Drive API への共通リクエストヘルパー
 */
const fetchFromDrive = async (url: string, options: RequestInit = {}) => {
  if (!accessToken) {
    throw new Error('認証されていません。Googleドライブに再接続してください。');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(url, { ...options, headers });
  
  if (response.status === 401) {
    accessToken = null;
    throw new Error('セッションの期限が切れました。ログインし直してください。');
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
  if (!accessToken) {
    throw new Error('認証トークンがありません。ログインしてください。');
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      accessToken = null;
      throw new Error('セッションの期限が切れました。ログインし直してください。');
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
