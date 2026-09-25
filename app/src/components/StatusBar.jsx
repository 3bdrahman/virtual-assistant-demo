const STAGES = {
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  synthesizing: 'Preparing voice…',
  speaking: 'Speaking…',
};

export function StatusBar({ connection, pipelineStage, errorMessage, speechMode }) {
  const ready = connection.online && connection.hasNvidiaKey;
  const connectionLabel = !connection.checked
    ? 'Checking services'
    : !connection.online
      ? 'Demo offline'
      : ready ? 'Live AI configured' : 'Live AI unavailable';

  return (
    <header className="status-bar" id="status-bar">
      <div className="status-left">
        <span className={`connection-dot ${ready ? 'connected' : 'disconnected'}`} aria-hidden="true" />
        <span className="connection-label">{connectionLabel}</span>
        {ready && speechMode && <span className="speech-mode">{speechMode}</span>}
      </div>
      <div className="status-right" role="status" aria-live="polite">
        <span className={`pipeline-stage ${pipelineStage === 'error' ? 'pipeline-error' : ''}`}>
          {pipelineStage === 'error' ? errorMessage : STAGES[pipelineStage] || ''}
        </span>
      </div>
    </header>
  );
}
