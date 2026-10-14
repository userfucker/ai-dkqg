/**
 * 网页的实时推送（SSE）：每个打开的网页一个连接。
 *  - 全局：插件状态、会议列表变化
 *  - 某场会议：会议全部内容（detail）、正在发言的实时文字（live）
 */
export interface Viewer { meetingId: string | null; send: (event: string, data: unknown) => void }
const viewers = new Set<Viewer>();

export function addViewer(v: Viewer): () => void {
  viewers.add(v);
  return () => viewers.delete(v);
}
export function broadcastAll(event: string, data: unknown): void {
  for (const v of viewers) { try { v.send(event, data); } catch {} }
}
export function broadcastMeeting(meetingId: string, event: string, data: unknown): void {
  for (const v of viewers) if (v.meetingId === meetingId) { try { v.send(event, data); } catch {} }
}
export function viewerCount(meetingId: string): number {
  let n = 0;
  for (const v of viewers) if (v.meetingId === meetingId) n++;
  return n;
}
