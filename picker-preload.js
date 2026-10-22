const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerAPI', {
  onSources: (cb) => ipcRenderer.on('sources', (_e, sources) => cb(sources)),
  choose: (id) => ipcRenderer.send('picker-result', id),
  cancel: () => ipcRenderer.send('picker-result', null),
});
