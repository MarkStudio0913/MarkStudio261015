// 冒烟测试：启动应用 -> 打开测试文件 -> 渲染层自动插入内容并保存 -> 校验文件落盘
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test-assets');
fs.mkdirSync(testDir, { recursive: true });
const testFile = path.join(testDir, 'smoke-test.md');
const original = '# 冒烟测试\n\n初始内容，等待 MarkStudio 编辑保存。\n';
fs.writeFileSync(testFile, original, 'utf8');

const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
console.log('[smoke] 启动 Electron ...');
const child = spawn(electron, [root, testFile], {
  cwd: root,
  env: { ...process.env, MARKSTUDIO_SMOKE: '1' },
  stdio: ['ignore', 'inherit', 'inherit']
});

const timeout = setTimeout(() => {
  console.error('[smoke] 超时（60s），强制结束');
  try { child.kill(); } catch (e) { }
  process.exit(2);
}, 60000);

child.on('exit', () => {
  clearTimeout(timeout);
  let after = '';
  try { after = fs.readFileSync(testFile, 'utf8'); } catch (e) { }
  const ok = after.includes('MarkStudio-Smoke-Marker-') && after.trim() !== original.trim();
  console.log('='.repeat(50));
  console.log(ok ? '[smoke] PASS —— 打开 / 编辑 / 保存 全链路成功' : '[smoke] FAIL —— 文件内容未变化');
  console.log('--- 文件最终内容 ---');
  console.log(after);
  process.exit(ok ? 0 : 1);
});
