const { app, BrowserWindow, session, desktopCapturer, screen, shell, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Troque aqui se um dia mudar de domínio/hospedagem.
const SITE_URL = 'https://lzcolombo.onrender.com';
const SITE_ORIGIN = new URL(SITE_URL).origin;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: 'VLeon',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true, // sem barra de menu (File/Edit/...) pra parecer um app de verdade
    backgroundColor: '#0a0d14',
    // some com a barra de título nativa (ícone + "VLeon - Compartilhe sua tela" + botões), que
    // destoa do visual do site; fica só os botões de minimizar/maximizar/fechar, flutuando sobre
    // a nossa própria barra de cima (que vira "arrastável" via CSS, veja .is-desktop-app no site)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0d14', symbolColor: '#e9edf6', height: 44 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'main-preload.js'),
    },
  });

  win.loadURL(SITE_URL);

  // links que abririam em nova aba (ex.: o chat) abrem no navegador padrão, não dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

// Mostra uma janelinha com miniaturas de cada tela/janela disponível e devolve o id escolhido (ou null).
function askUserToPickSource(sources, parent) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 640,
      height: 520,
      parent,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Escolha o que compartilhar',
      backgroundColor: '#10151f',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'picker-preload.js'),
      },
    });
    picker.setMenuBarVisibility(false);
    picker.loadFile('picker.html');
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('sources', sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));
    });
    let settled = false;
    ipcMain.once('picker-result', (_e, id) => {
      settled = true;
      if (!picker.isDestroyed()) picker.close();
      resolve(id || null);
    });
    picker.on('closed', () => { if (!settled) resolve(null); });
  });
}

// Área real (em pixels) do último MONITOR INTEIRO escolhido pra compartilhar — usada pra converter
// os cliques normalizados (0..1) de quem está controlando a gente em coordenadas reais da tela.
let lastScreenBounds = null;

// O Chrome tem getDisplayMedia nativo; o Electron precisa que a gente
// escolha a tela/janela manualmente via desktopCapturer. Sem isso o
// botão "Compartilhar tela" do site não funciona dentro do app.
function setupScreenShare(mainWin) {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 200 } });
      const pickedId = await askUserToPickSource(sources, mainWin);
      const pick = sources.find((s) => s.id === pickedId);
      if (pick && pick.id.startsWith('screen:')) {
        const d = screen.getAllDisplays().find((x) => String(x.id) === String(pick.display_id));
        lastScreenBounds = d ? d.bounds : null;
      }
      callback(pick ? { video: pick, audio: 'loopback' } : {});
    } catch (err) {
      console.error('Falha ao listar telas pra compartilhar:', err);
      callback({});
    }
  });
}

// A câmera não é usada pelo site, mas o microfone é — libera sem perguntar,
// já que é sempre a nossa própria origem (o site hospedado).
function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'display-capture', 'notifications'];
    callback(allowed.includes(permission));
  });
}

// ---------- "assumir o controle do PC" (mouse/teclado de verdade) ----------
// Usa um processo de PowerShell que fica aberto, recebendo um comando por linha (evita o custo
// de abrir um processo novo a cada clique/movimento, o que ficaria lento demais pro mouse).
let psProc = null;
function ensurePs() {
  if (psProc && !psProc.killed) return psProc;
  psProc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true });
  psProc.on('exit', () => { psProc = null; });
  psProc.on('error', (err) => { console.error('Falha ao abrir o PowerShell do controle remoto:', err); psProc = null; });
  psProc.stderr.on('data', (d) => console.error('[controle remoto]', d.toString().trim()));
  // nada de here-string (@"..."@) aqui: alimentado linha a linha via stdin, ele quebra o parser
  // do PowerShell (statement "incompleto" come as linhas seguintes). Tudo numa linha só por isso.
  psProc.stdin.write('Add-Type -AssemblyName System.Windows.Forms\n');
  psProc.stdin.write('Add-Type -AssemblyName System.Drawing\n');
  psProc.stdin.write('Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\' -Name NativeInput -Namespace VLeon\n');
  psProc.stdin.write('[VLeon.NativeInput]::SetProcessDPIAware() | Out-Null\n');
  return psProc;
}
function psExec(cmd) {
  try { ensurePs().stdin.write(cmd + '\n'); } catch (err) { console.error('Falha ao mandar comando pro controle remoto:', err); }
}

const MOUSE_FLAGS = {
  down: [0x0002, 0x0020, 0x0008], // esquerdo, meio, direito
  up: [0x0004, 0x0040, 0x0010],
};
const SPECIAL_KEYS = {
  Enter: '{ENTER}', Backspace: '{BACKSPACE}', Tab: '{TAB}', Escape: '{ESC}', Delete: '{DELETE}',
  ArrowUp: '{UP}', ArrowDown: '{DOWN}', ArrowLeft: '{LEFT}', ArrowRight: '{RIGHT}',
  Home: '{HOME}', End: '{END}', PageUp: '{PGUP}', PageDown: '{PGDN}', Insert: '{INSERT}',
  F1: '{F1}', F2: '{F2}', F3: '{F3}', F4: '{F4}', F5: '{F5}', F6: '{F6}',
  F7: '{F7}', F8: '{F8}', F9: '{F9}', F10: '{F10}', F11: '{F11}', F12: '{F12}',
};
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'CapsLock', 'ContextMenu']);
const SENDKEYS_ESCAPE = /[+^%~(){}[\]]/g;

function keyToSendKeys(ev) {
  if (MODIFIER_KEYS.has(ev.key)) return null;
  let token;
  if (SPECIAL_KEYS[ev.key]) token = SPECIAL_KEYS[ev.key];
  else if (ev.key.length === 1) token = ev.key.replace(SENDKEYS_ESCAPE, (c) => `{${c}}`);
  else return null; // tecla não mapeada (ex.: mídia/volume) — ignora
  let prefix = '';
  if (ev.ctrl) prefix += '^';
  if (ev.alt) prefix += '%';
  if (ev.shift && (SPECIAL_KEYS[ev.key] || ev.ctrl || ev.alt)) prefix += '+'; // letra maiúscula já vem certa sozinha
  return prefix + token;
}

function applyRemoteInput(ev, bounds) {
  if (!ev || !bounds || typeof bounds.x !== 'number') return;
  if (ev.type === 'move' || ev.type === 'down' || ev.type === 'up') {
    const x = Math.round(bounds.x + ev.xr * bounds.width);
    const y = Math.round(bounds.y + ev.yr * bounds.height);
    psExec(`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`);
  }
  if (ev.type === 'down' || ev.type === 'up') {
    const flag = MOUSE_FLAGS[ev.type][[0, 1, 2].includes(ev.button) ? ev.button : 0];
    psExec(`[VLeon.NativeInput]::mouse_event(${flag},0,0,0,[UIntPtr]::Zero)`);
  } else if (ev.type === 'wheel') {
    const delta = (ev.dy > 0 ? -1 : 1) * 120;
    psExec(`[VLeon.NativeInput]::mouse_event(0x0800,0,0,${delta},[UIntPtr]::Zero)`);
  } else if (ev.type === 'key') {
    const seq = keyToSendKeys(ev);
    if (seq) psExec(`[System.Windows.Forms.SendKeys]::SendWait('${seq.replace(/'/g, "''")}')`);
  }
}

function setupRemoteControl() {
  const trusted = (e) => { try { return new URL(e.senderFrame.url).origin === SITE_ORIGIN; } catch { return false; } };
  ipcMain.handle('vleon:get-screen-bounds', (e) => (trusted(e) ? lastScreenBounds : null));
  ipcMain.on('vleon:remote-input', (e, { ev, bounds } = {}) => { if (trusted(e)) applyRemoteInput(ev, bounds); });
}

// ---------- atualização automática (GitHub Releases) ----------
// Só faz sentido no app instalado (empacotado); rodando "npm start" direto da pasta não tem o que atualizar.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (err) => console.error('[atualização]', err));
  autoUpdater.on('update-available', (info) => {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Atualização disponível',
      body: `A versão ${info.version} do VLeon tá disponível e já está sendo baixada…`,
      icon: path.join(__dirname, 'build', 'icon.png'),
      silent: true,
    }).show();
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Atualização do VLeon',
      message: `Uma nova versão (${info.version}) foi baixada.`,
      detail: 'Reinicie o app pra instalar agora, ou deixe pra próxima vez que abrir.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch((err) => console.error('[atualização] falha ao checar:', err));
}

app.whenReady().then(() => {
  const mainWin = createWindow();
  setupScreenShare(mainWin);
  setupPermissions();
  setupRemoteControl();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
