const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ALLOW_INVOKE = new Set([
  'dialog:open-file', 'dialog:open-folder', 'dialog:save-file', 'dialog:pick-image-path',
  'fs:read-file', 'fs:write-file', 'fs:rename', 'fs:read-dir', 'fs:read-base64', 'fs:read-text', 'fs:copy-file',
  'doc:state', 'app:close-done', 'app:close-ask-done',
  'app:get-settings', 'app:set-settings', 'app:recent', 'app:recent-replace', 'app:clear-recent', 'app:menu-state',
  'shell:open-external', 'shell:open-path', 'shell:show-item', 'clipboard:write', 'clipboard:read',
  'app:cdn-url', 'app:info', 'app:native-theme', 'app:list-fonts', 'img:save',
  'export:pdf', 'export:html', 'export:doc', 'export:image', 'export:measure-image', 'print:doc', 'msg:confirm', 'window:new', 'window:minimize', 'window:maximize', 'app:set-language',
  'fs:watch-tabs', 'window:fullscreen', 'win:close-by-id', 'win:tab-moved', 'win:self-id',
  // R75：最近文件夹子菜单 / 设置恢复默认 / 未保存标签拖到新窗口（携带内容）
  'app:recent-folders', 'app:reset-settings', 'app:default-settings', 'win:open-unsaved', 'app:push-recent-folder', 'win:take-unsaved'
]);

contextBridge.exposeInMainWorld('ms', {
  invoke: (channel, payload) => {
    if (!ALLOW_INVOKE.has(channel)) throw new Error('channel not allowed: ' + channel);
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, cb) => {
    const allowed = ['menu', 'app:open-path', 'app:close-intent', 'app:close-ask', 'app:close-ask-timeout', 'fs:changed', 'app:smoke', 'window:max-state', 'tray:new-file', 'win:id', 'win:remote-tab-moved', 'window:full-state', 'win:remote-unsaved-moved'];
    if (!allowed.includes(channel)) throw new Error('channel not allowed: ' + channel);
    const listener = (e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  getDroppedFilePath: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  platform: process.platform
});
