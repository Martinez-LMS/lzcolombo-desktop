const { contextBridge, ipcRenderer } = require('electron');

// Dá pro site (sempre o nosso mesmo, carregado pelo main.js) uma forma de usar recursos do
// Windows que o navegador não permite: saber a área real da tela compartilhada e, só se a
// pessoa aceitar o pedido de controle, mexer o mouse/teclado de verdade no PC dela.
contextBridge.exposeInMainWorld('desktopAPI', {
  isElectron: true,
  getScreenBounds: () => ipcRenderer.invoke('vleon:get-screen-bounds'),
  applyRemoteInput: (ev, bounds) => ipcRenderer.send('vleon:remote-input', { ev, bounds }),
});
