const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ---- áudio só da janela compartilhada ----
// O main.js captura o áudio do processo dono da janela e manda o PCM (16-bit estéreo 48 kHz) por IPC.
// Aqui a gente repassa isso pro "mundo" da página, que monta a faixa de áudio e a coloca no stream
// devolvido pelo getDisplayMedia (veja o script injetado no fim do arquivo).
let windowAudioMode = null; // 'window' | 'none' — último aviso do main, ainda não consumido
let modeWaiters = [];
ipcRenderer.on('vleon:window-audio-mode', (_e, mode) => {
  if (modeWaiters.length) modeWaiters.splice(0).forEach((fn) => fn(mode));
  else windowAudioMode = mode;
});

// espera o main dizer se o compartilhamento atual traz áudio de janela (ou desiste e segue sem áudio)
function waitWindowAudioMode(ms) {
  if (windowAudioMode) { const m = windowAudioMode; windowAudioMode = null; return Promise.resolve(m); }
  return new Promise((resolve) => {
    const t = setTimeout(() => { modeWaiters = modeWaiters.filter((f) => f !== fn); resolve('none'); }, ms);
    const fn = (m) => { clearTimeout(t); resolve(m); };
    modeWaiters.push(fn);
  });
}

let chunkCb = null;
ipcRenderer.on('vleon:window-audio-chunk', (_e, chunk) => { if (chunkCb) chunkCb(chunk); });

// Dá pro site (sempre o nosso mesmo, carregado pelo main.js) uma forma de usar recursos do
// Windows que o navegador não permite: saber a área real da tela compartilhada e, só se a
// pessoa aceitar o pedido de controle, mexer o mouse/teclado de verdade no PC dela.
contextBridge.exposeInMainWorld('desktopAPI', {
  isElectron: true,
  version: ipcRenderer.sendSync('vleon:version'),
  getScreenBounds: () => ipcRenderer.invoke('vleon:get-screen-bounds'),
  applyRemoteInput: (ev, bounds) => ipcRenderer.send('vleon:remote-input', { ev, bounds }),
  setTitleBarTheme: (light) => ipcRenderer.send('vleon:set-titlebar-theme', { light: !!light }),
  // uso interno do getDisplayMedia embrulhado abaixo
  waitWindowAudioMode,
  onWindowAudioChunk: (cb) => { chunkCb = cb; },
  stopWindowAudio: () => { chunkCb = null; ipcRenderer.send('vleon:window-audio-stop'); },
});

// Embrulha navigator.mediaDevices.getDisplayMedia no mundo da página: se o usuário escolheu uma
// JANELA, o stream volta sem áudio do sistema e a gente acrescenta uma faixa com só o áudio dela.
// (AudioBufferSource agendado em vez de AudioWorklet: não depende de blob:/CSP do site.)
const PAGE_PATCH = `(() => {
  const api = window.desktopAPI;
  const md = navigator.mediaDevices;
  if (!api || !api.waitWindowAudioMode || !md || !md.getDisplayMedia || md.getDisplayMedia.__vleonPatched) return;
  const orig = md.getDisplayMedia.bind(md);
  const RATE = 48000, LEAD = 0.08; // 80 ms de folga pra absorver variação de chegada dos pedaços

  async function wrapped(constraints) {
    const stream = await orig(constraints);
    const wantsAudio = !!(constraints && constraints.audio);
    if (!wantsAudio || stream.getAudioTracks().length) return stream; // tela inteira (já veio com áudio) ou sem áudio pedido
    let mode = 'none';
    try { mode = await api.waitWindowAudioMode(2000); } catch (e) {}
    if (mode !== 'window') return stream;

    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: RATE });
      const dest = ctx.createMediaStreamDestination();
      let next = 0;
      api.onWindowAudioChunk((chunk) => {
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const frames = Math.floor(bytes.byteLength / 4);
        if (!frames) return;
        const s16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + frames * 4));
        const buf = ctx.createBuffer(2, frames, RATE);
        const l = buf.getChannelData(0), r = buf.getChannelData(1);
        for (let i = 0; i < frames; i++) { l[i] = s16[2 * i] / 32768; r[i] = s16[2 * i + 1] / 32768; }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        const now = ctx.currentTime;
        // ficou sem áudio por um tempo (janela em silêncio) ou acumulou atraso demais: reancora
        if (next < now + 0.01 || next > now + 0.5) next = now + LEAD;
        src.start(next);
        next += buf.duration;
      });
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const track = dest.stream.getAudioTracks()[0];
      stream.addTrack(track);
      const stop = () => { try { api.stopWindowAudio(); } catch (e) {} try { ctx.close(); } catch (e) {} };
      stream.getVideoTracks().forEach((v) => v.addEventListener('ended', stop, { once: true }));
      track.addEventListener('ended', stop, { once: true });
    } catch (e) {
      console.error('[VLeon] não foi possível anexar o áudio da janela:', e);
      try { api.stopWindowAudio(); } catch (_) {}
      try { ctx && ctx.close(); } catch (_) {}
    }
    return stream;
  }
  wrapped.__vleonPatched = true;
  md.getDisplayMedia = wrapped;
})();`;

webFrame.executeJavaScript(PAGE_PATCH).catch((err) => console.error('[VLeon] patch do getDisplayMedia falhou:', err));
