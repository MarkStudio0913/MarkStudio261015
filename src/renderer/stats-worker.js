// 字数统计 Worker（R53-9）：整篇正则统计移出主线程。
// 大文档每次击键防抖后触发，主线程零阻塞；主线程兜底（countStats）在 Worker 不可用时自动接管。
'use strict';
self.onmessage = (e) => {
  const d = e.data || {};
  const text = typeof d.text === 'string' ? d.text : '';
  const cjk = (text.match(/[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const latin = (text.replace(/[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ').match(/[A-Za-z0-9_']+/g) || []).length;
  self.postMessage({ id: d.id, words: cjk + latin, chars: text.length });
};
