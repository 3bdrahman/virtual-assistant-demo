const STAGES = {
  starting: 'Opening microphone…',
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  synthesizing: 'Preparing voice…',
  speaking: 'Speaking…',
};

export function StatusBar({ connection, pipelineStage, errorMessage, speechMode, onManageKey }) {
  const ready = connection.online && (connection.requiresUserKey ? connection.hasUserKey : connection.hasNvidiaKey);
  const connectionLabel = !connection.checked
    ? 'Checking services'
    : !connection.online
      ? 'Demo offline'
      : ready ? 'Live AI configured' : connection.requiresUserKey ? 'API key needed' : 'Live AI unavailable';

  return (
    <header className="status-bar" id="status-bar">
      <div className="status-left">
        <span className={`connection-dot ${ready ? 'connected' : 'disconnected'}`} aria-hidden="true" />
        <span className="connection-label">{connectionLabel}</span>
        {ready && speechMode && <span className="speech-mode">{speechMode}</span>}
        {connection.requiresUserKey && <button type="button" className="manage-key-button" onClick={onManageKey} aria-label="Change API key">API key</button>}
      </div>
      <div className="status-right" role="status" aria-live="polite">
        <span className={`pipeline-stage ${pipelineStage === 'error' ? 'pipeline-error' : ''}`}>
          {pipelineStage === 'error' ? errorMessage : STAGES[pipelineStage] || ''}
        </span>
      </div>
    </header>
  );
}
