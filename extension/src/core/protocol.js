/**
 * 捕获助手 <-> AI 助教 之间的标准消息协议。
 * 任何一端（浏览器插件 / 桌面悬浮端 / 网页 / 微信内嵌）只要按此协议推送，即可接入助教。
 */

export const MSG = {
  /** 分段流式转写文本 */
  SEGMENT: 'segment',
  /** 控制指令 */
  COMMAND: 'command',
  /** 知识点查询 */
  QUERY: 'query',
  /** 会话控制 */
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  /** 配置 / 状态 */
  CONFIG_UPDATE: 'config_update',
  STATE_SYNC: 'state_sync',
  ERROR: 'error',
};

export const CMD = {
  PAUSE: 'pause',
  RESUME: 'resume',
  END: 'end',
  SUMMARY_NOW: 'summary_now',
};

/** 助教状态 */
export const STATE = {
  IDLE: 'idle',       // 待命
  LISTENING: 'listening', // 听课中
  PAUSED: 'paused',   // 已暂停（输出过小节小结）
  ENDED: 'ended',     // 课程结束
};

/** 笔记固定标签 */
export const TAGS = ['重点', '易错点', '拓展'];

/** 构造一条分段转写消息 */
export function makeSegment(sessionId, seq, text, tStart, tEnd) {
  return { type: MSG.SEGMENT, sessionId, seq, text: String(text || '').trim(), tStart, tEnd };
}

/** 构造一条控制指令 */
export function makeCommand(cmd, sessionId) {
  return { type: MSG.COMMAND, cmd, sessionId };
}
