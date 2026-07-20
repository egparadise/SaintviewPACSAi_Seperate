// 음성 판독(STT) 공용 훅 — 판독 편집기(ReportWindow·ReportDock·Worklist)에서 재사용.
// 엔진은 서버 설정(ai.policy.stt_engine)을 따른다:
//  - browser      : 브라우저 내장 Web Speech(무료·오프라인 불가, 서버 미전송)
//  - whisper_local: 서버 Whisper 로컬(온프레미스·PHI 안전) — MediaRecorder 녹음 → /api/stt
//  - openai_api   : 서버가 OpenAI whisper-1 로 전사 — MediaRecorder 녹음 → /api/stt
// Client 는 서버 설정 엔진을 그대로 사용(연동) — 병원/전역 ai.policy 로 통일 구동.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, sttTranscribe } from "../api";

type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: (ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void; onerror: () => void; start: () => void; stop: () => void;
};

/** onText: 전사된 텍스트 조각을 편집기에 삽입하는 콜백 */
export function useDictation(onText: (text: string) => void) {
  const [engine, setEngine] = useState("browser");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);   // 서버 전사 대기(녹음 종료 후)
  const [err, setErr] = useState("");
  const recRef = useRef<{ stop: () => void } | null>(null);
  const lastBlobRef = useRef<Blob | null>(null);   // 마지막 녹음 오디오(Play 재생용 — 서버 엔진만)
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    api.getSetting("ai.policy")
      .then((r) => setEngine(((r.value as { stt_engine?: string }).stt_engine) ?? "browser"))
      .catch(() => {});
  }, []);
  // 언마운트 시 녹음 중지(마이크 스트림 누수 방지)
  useEffect(() => () => recRef.current?.stop(), []);

  const toggle = useCallback(() => {
    setErr("");
    if (recording) { recRef.current?.stop(); setRecording(false); return; }

    if (engine !== "browser") {
      // 서버 전사(Whisper 로컬 / OpenAI) — MediaRecorder 로 webm 녹음 → /api/stt
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: "audio/webm" });
          lastBlobRef.current = blob;   // Play 재생용 보관
          setBusy(true);
          try {
            const r = await sttTranscribe(blob);
            if (r.text) onTextRef.current(r.text);
          } catch (e) { setErr(e instanceof Error ? e.message : "STT 전사 실패"); }
          finally { setBusy(false); }
        };
        recRef.current = rec;
        rec.start();
        setRecording(true);
      }).catch(() => setErr("마이크 권한이 필요합니다"));
      return;
    }

    // 브라우저 내장 음성 인식(Web Speech)
    const w = window as unknown as Record<string, unknown>;
    const SRClass = (w.webkitSpeechRecognition ?? w.SpeechRecognition) as (new () => SR) | undefined;
    if (!SRClass) {
      setErr("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장 — 또는 설정>AI 기능에서 Whisper 선택)");
      return;
    }
    const rec = new SRClass();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const texts: string[] = [];
      for (let i = ev.resultIndex; i < ev.results.length; i++) texts.push(ev.results[i][0].transcript);
      const text = texts.join(" ").trim();
      if (text) onTextRef.current(text);
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    recRef.current = rec;
    rec.start();
    setRecording(true);
  }, [engine, recording]);

  // 마지막 녹음 재생(Play) — 서버 엔진(whisper/openai)만 blob 보관. browser 엔진은 blob 없음.
  const playLast = useCallback((): boolean => {
    const b = lastBlobRef.current;
    if (!b) return false;
    const url = URL.createObjectURL(b);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    void audio.play();
    return true;
  }, []);

  return { engine, recording, busy, err, toggle, playLast };
}

/** 마이크 버튼 라벨/툴팁 — 엔진·상태별 (공용) */
export function dictationLabel(engine: string, recording: boolean, busy: boolean): string {
  if (busy) return "전사 중…";
  if (recording) return "● 녹음 중 (클릭 종료)";
  const eng = engine === "browser" ? "브라우저" : engine === "whisper_local" ? "Whisper 로컬" : "OpenAI";
  return `음성 판독 (${eng})`;
}
