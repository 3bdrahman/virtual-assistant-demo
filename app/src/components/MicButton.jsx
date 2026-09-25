import { useState, useRef, useEffect } from 'react';

export function MicButton({ onRecordingComplete, onRecordingChange, onError, onInteraction, describedBy, disabled }) {
  const [isRecording, setIsRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const startingRef = useRef(false);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state === 'recording') recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const handleClick = async () => {
    if (disabled || startingRef.current) return;
    onInteraction?.();
    if (isRecording) {
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
      return;
    }

    startingRef.current = true;
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser does not support microphone recording.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);
        onRecordingChange?.(false);
        onRecordingComplete?.(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.ondataavailable = null;
        if (recorder.state === 'recording') recorder.stop();
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setIsRecording(false);
        onRecordingChange?.(false);
        onError?.(new Error('Recording failed. Please try again.'));
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      onRecordingChange?.(true);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      onError?.(error);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  return (
    <button
      id="mic-button"
      type="button"
      className={`mic-button ${isRecording ? 'recording' : ''}`}
      onClick={handleClick}
      disabled={disabled || starting}
      aria-pressed={isRecording}
      aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      aria-describedby={describedBy}
    >
      <span className="mic-icon">
        {isRecording ? (
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
