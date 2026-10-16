/**
 * 悬浮条：只显示最新转写、知识点、实时音量与缓冲进度。
 * 点右上角方块回到主窗口（主窗口会被重新显示出来）。
 * 点「—」缩成 28px 小条：只看状态和计时，几乎不挡视频，再点还原。
 */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');

$('#fExpand').onclick = () => window.vt.closeFloat();

let compact = false;
$('#fMin').onclick = async () => {
  compact = !compact;
  document.body.classList.toggle('compact', compact);
  $('#fMin').title = compact ? '还原成完整悬浮条' : '缩成小条，不挡视频';
  try { await window.vt.floatSetCompact(compact); } catch (_) {}
};

/** 电平条自己跑动画，比跟随 800ms 的轮询要跟手 */
let viewLevel = 0;
let targetLevel = 0;

function animate() {
  viewLevel += (targetLevel - viewLevel) * 0.35;
  const bar = $('#fLvl');
  if (bar) bar.style.width = Math.min(100, Math.round(viewLevel * 130)) + '%';
  targetLevel *= 0.86;
}

tick();
setInterval(tick, 900);
setInterval(animate, 60);

async function tick() {
  let s = null;
  try { s = await window.vt.busGet(); } catch (_) {}
  if (!s) {
    $('#fLast').textContent = '正在连接…';
    return;
  }
  const fresh = s.last || (s.capturing ? '正在听…（首条转写约 4 秒后出现）' : '已停止');
  $('#fLast').textContent = fresh;
  const notes = s.notes || [];
  $('#fNote1').textContent = notes[notes.length - 2] || '';
  $('#fNote2').textContent = notes[notes.length - 1] || '';
  $('#fState').textContent = s.capturing ? '捕获中' : '已停止';
  $('#fCount').textContent = (s.noteCount || 0) + ' 条';
  $('#fBuf').textContent = s.queued ? `排队${s.queued}片` : (s.busy ? '转写中' : ((s.buffered || 0).toFixed(1) + 's'));
  const sec = Math.floor((s.elapsed || 0) / 1000);
  const clock = `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
  $('#fTime').textContent = clock;
  $('#fCTime').textContent = clock;   // 压缩态显示在顶栏
  if (s.level) targetLevel = Math.max(targetLevel, s.level);
}
