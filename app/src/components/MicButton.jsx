import { useState, useRef, useEffect } from 'react';

const MAX_RECORDING_MS = 60_000;
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

export function MicButton({ onRecordingComplete, onRecordingChange, onStartingChange, onError, onInteraction, describedBy, disabled }) {
  const [isRecording, setIsRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const startingRef = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const disabledRef = useRef(disabled);
  const stopTimerRef = useRef(null);
  disabledRef.current = disabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(stopTimerRef.current);
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state === 'recording') recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    if (startingRef.current) {
      requestIdRef.current++;
      startingRef.current = false;
      setStarting(false);
      onStartingChange?.(false);
    }
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  }, [disabled, onStartingChange]);

  const handleClick = async () => {
    if (startingRef.current) {
      requestIdRef.current++;
      startingRef.current = false;
      setStarting(false);
      onStartingChange?.(false);
      return;
    }
    if (isRecording) {
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
      return;
    }
    if (disabled) return;
    onInteraction?.();

    startingRef.current = true;
    const requestId = ++requestIdRef.current;
    setStarting(true);
    onStartingChange?.(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser does not support microphone recording.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || disabledRef.current || requestId !== requestIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      let totalBytes = 0;
      let failed = false;
      const finishRecording = () => {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (mountedRef.current) {
          setIsRecording(false);
          onRecordingChange?.(false);
        }
      };
      recorder.ondataavailable = (event) => {
        if (!event.data?.size || failed) return;
        totalBytes += event.data.size;
        if (totalBytes > MAX_RECORDING_BYTES) {
          failed = true;
          if (recorder.state === 'recording') recorder.stop();
          return;
        }
        chunks.push(event.data);
      };
      recorder.onstop = () => {
        finishRecording();
        if (!mountedRef.current) return;
        if (failed) {
          onError?.(new Error('Recording is too long. Please try a shorter message.'));
          return;
        }
        onRecordingComplete?.(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.onerror = () => {
        failed = true;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.ondataavailable = null;
        if (recorder.state === 'recording') recorder.stop();
        finishRecording();
        if (mountedRef.current) onError?.(new Error('Recording failed. Please try again.'));
      };
      recorderRef.current = recorder;
      recorder.start(1000);
      stopTimerRef.current = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, MAX_RECORDING_MS);
      setIsRecording(true);
      onRecordingChange?.(true);
    } catch (error) {
      if (requestId === requestIdRef.current) {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (mountedRef.current) onError?.(error);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        startingRef.current = false;
        if (mountedRef.current) {
          setStarting(false);
          onStartingChange?.(false);
        }
      }
    }
  };

  return (
    <button
      id="mic-button"
      type="button"
      className={`mic-button ${isRecording ? 'recording' : ''}`}
      onClick={handleClick}
      disabled={disabled && !starting && !isRecording}
      aria-pressed={isRecording}
      aria-label={starting ? 'Cancel microphone request' : isRecording ? 'Stop recording' : 'Start recording'}
      aria-describedby={describedBy}
    >
      <span className="mic-icon">
        {isRecording || starting ? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}
      </span>
      {isRecording && (
        <span className="pulse-rings" aria-hidden="true">
          <span className="ring ring-1" />
          <span className="ring ring-2" />
          <span className="ring ring-3" />
        </span>
      )}
    </button>
  );
}
