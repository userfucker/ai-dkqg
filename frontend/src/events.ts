/** 实时推送（SSE）：插件状态、会议列表、当前会议的全部内容和实时文字。 */
import { useEffect, useRef, useState } from "react";
import type { BridgeStatus, MeetingDetail, MeetingSummary, Seat } from "./types.ts";

export function useEvents(meetingId: string | null) {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [online, setOnline] = useState(true);
  const offset = useRef(0); // 服务器时间 - 本机时间
  useEffect(() => {
    setDetail(null);
    const es = new EventSource(`/api/events${meetingId ? `?meeting=${meetingId}` : ""}`);
    es.addEventListener("open", () => setOnline(true));
    es.addEventListener("error", () => setOnline(false));
    es.addEventListener("bridge", (e) => setBridge(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("meetings", (e) => setMeetings(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("detail", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as MeetingDetail;
      offset.current = d.serverNow - Date.now();
      setDetail(d);
    });
    es.addEventListener("live", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as { seat: Seat; text: string; thinkingLen: number; busy?: boolean };
      setDetail((d) => (d ? { ...d, live: d.live.map((x) => (x.seat === l.seat ? { ...x, text: l.text, thinkingLen: l.thinkingLen, busy: l.busy } : x)) } : d));
    });
    return () => es.close();
  }, [meetingId]);
  return { bridge, meetings, detail, online, serverNow: () => Date.now() + offset.current };
}

/** 需要主持人时标题闪烁（页面在后台时） */
export function useTitleFlash(on: boolean, text: string) {
  useEffect(() => {
    const base = "AI 多方会议";
    if (!on) { document.title = base; return; }
    let flip = false;
    const t = setInterval(() => {
      if (!document.hidden) { document.title = `【${text}】${base}`; return; }
      flip = !flip;
      document.title = flip ? `【${text}】` : base;
    }, 1000);
    return () => { clearInterval(t); document.title = base; };
  }, [on, text]);
}
