/**
 * 核心引擎端到端自测（Node 环境，不依赖浏览器）。
 * 用法： node tools/selftest.mjs
 */
import { loadConfig } from '../extension/src/core/config.js';
import { Tutor } from '../extension/src/core/tutor.js';

const LECTURE = [
  '今天我们来讲 TCP 的三次握手。所谓三次握手，就是 TCP 建立连接时客户端和服务器之间要交换三个报文。第一次，客户端发送 SYN 报文，序列号 seq 等于 x。',
  '第二次，服务器收到后回复 SYN 加 ACK 报文，确认号 ack 等于 x 加 1，同时自己也带一个序列号 seq 等于 y。第三次，客户端再回一个 ACK，确认号 ack 等于 y 加 1。到这里连接就建立了。',
  '这里有个易错点：很多同学会误以为三次握手是为了保证数据不丢失，其实不是。三次握手的根本目的是确认双方各自的初始序列号，防止历史重复连接初始化造成混乱。',
  '对比一下四次挥手。TCP 断开连接要四次挥手，因为 TCP 是全双工的，每个方向都要单独关闭。所以需要 FIN 和 ACK 分别来回两次。这就是两者的区别。',
  '考点来了：为什么是三次而不是两次？如果只有两次握手，服务器发出去的确认报文如果丢失，服务器会以为连接已建立并一直等着，造成资源浪费。这是面试常考的题。',
  '再拓展一下，SYN 泛洪攻击就是利用了三次握手的半连接状态。攻击者大量发送 SYN 而不回最后的 ACK，服务器会维护大量半连接队列，最终耗尽资源。防护手段是 SYN Cookie。',
];

const log = [];
const emitter = {
  emit(type, payload) {
    if (type === 'notes') log.push(`[新增 ${payload.length} 条笔记]`);
    if (type === 'error') log.push(`[错误] ${payload.message}`);
    if (type === 'log') log.push(`[降级] ${payload.text}`);
  },
};

let cfg = await loadConfig();
if (process.argv.includes('--local')) cfg = { ...cfg, engine: 'local' };
console.log('引擎模式：', cfg.engine === 'local' ? '本地规则引擎（强制）' : (cfg.apiKey ? 'LLM (' + cfg.chatModel + ')' : '本地规则引擎'));

const tutor = new Tutor(cfg, emitter);
tutor.start({ topic: 'TCP 三次握手与四次挥手' });

for (const [i, text] of LECTURE.entries()) {
  tutor.pushSegment({ text, seq: i });
  await tutor.extract();
}

console.log('\n=== 实时笔记 ===');
tutor.notes.forEach((n) => console.log(`【${n.tag}】${n.title} — ${n.body}`));

console.log('\n=== 暂停：本小节小结 ===');
await tutor.pause();
const sec = tutor.sections[tutor.sections.length - 1];
console.log(sec.title, '|', sec.summary);

console.log('\n=== 课程结束：知识图谱 ===');
await tutor.end();
console.log(tutor.graph.mermaid);

console.log('\n=== 知识点查询：三次握手 ===');
const d = await tutor.queryTopic('三次握手');
console.log('定义:', d.definition);
console.log('考点:', d.examPoints);
console.log('关联:', (d.related || []).join('、'));

console.log('\n=== 统计 ===', JSON.stringify(tutor.snapshot().stats));
console.log('事件流：', log.join(' | ') || '（无异常）');
