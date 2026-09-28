import { useState, useRef, useCallback, useEffect, Suspense, lazy, Component } from 'react';
import { MicButton } from './components/MicButton';
import { ChatPanel } from './components/ChatPanel';
import { TextInput } from './components/TextInput';
import { StatusBar } from './components/StatusBar';
import { ApiKeyPanel } from './components/ApiKeyPanel';
import { transcribe, streamChat, synthesize, checkHealth, REQUIRES_USER_KEY, apiRelayOrigin } from './services/nim';
import { AudioLipSync } from './services/audioLipSync';
import { canUseWebGL } from './utils/webgl';

const AvatarScene = lazy(() => import('./components/AvatarScene'));

function SceneStatus({ loading = false }) {
  return (
    <div className="scene-unavailable" role="status">
      <strong>{loading ? 'Loading avatar…' : '3D preview unavailable'}</strong>
      <span>{loading ? 'The avatar may take a moment to load.' : 'You can still use the conversation controls.'}</span>
    </div>
  );
}

class SceneErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Avatar scene failed:', error);
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const SYSTEM_PROMPT = {
  role: 'system',
  content: 'You are a friendly AI assistant speaking through a 3D avatar. Answer naturally and concisely, usually in two or three sentences.',
};

function App() {
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  const [streamingText, setStreamingText] = useState('');
  const [stage, setStage] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [connection, setConnection] = useState({ checked: false, online: false, hasNvidiaKey: false });
  const [speechMode, setSpeechMode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const apiKeyRef = useRef('');
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  const [conversationId, setConversationId] = useState(0);
  const [lipSync] = useState(() => new AudioLipSync());
  const [webglAvailable] = useState(() => canUseWebGL());
  const [sceneState, setSceneState] = useState(() => webglAvailable ? 'loading' : 'unavailable');
  const requestRef = useRef(null);
  const pendingMessageRef = useRef(null);
  const errorTimerRef = useRef(null);
  const handleSceneReady = useCallback(() => setSceneState('ready'), []);

  useEffect(() => {
    let active = true;
    let healthTimer;
    const refreshHealth = async () => {
      const health = await checkHealth();
      if (!active) return;
      const ready = Boolean(health.ok && (health.requiresUserKey || health.hasNvidiaKey));
      setConnection({ checked: true, online: Boolean(health.ok), hasNvidiaKey: Boolean(health.hasNvidiaKey), requiresUserKey: health.requiresUserKey === true });
      healthTimer = setTimeout(refreshHealth, ready ? 30_000 : 5_000);
    };
    refreshHealth();
    lipSync.onIdle = () => setStage((current) => current === 'speaking' ? 'idle' : current);
    lipSync.onPlaybackError = (_error, text) => {
      setSpeechMode('Browser voice (audio playback unavailable)');
      if (!lipSync.speakTextFallback(text)) {
        setSpeechMode('Text only (male voice unavailable)');
        setStage('idle');
      }
    };
    lipSync.onSpeechError = () => setSpeechMode('Text only (male voice unavailable)');
    return () => {
      active = false;
      clearTimeout(healthTimer);
      clearTimeout(errorTimerRef.current);
      requestRef.current?.abort();
      requestRef.current = null;
      lipSync.onIdle = null;
      lipSync.onPlaybackError = null;
      lipSync.onSpeechError = null;
      lipSync.dispose?.();
      lipSync.stop();
    };
  }, [lipSync]);

  const showError = useCallback((message) => {
    clearTimeout(errorTimerRef.current);
    setErrorMessage(message);
    setStage('error');
    errorTimerRef.current = setTimeout(() => {
      setErrorMessage('');
      setStage((current) => current === 'error' ? 'idle' : current);
    }, 7000);
  }, []);

  const prepareAudio = useCallback(() => {
    try {
      lipSync.prepare().catch(() => setSpeechMode('Browser voice (audio output unavailable)'));
    } catch {
      setSpeechMode('Browser voice (audio output unavailable)');
    }
  }, [lipSync]);

  const cancelRequest = useCallback(() => {
    clearTimeout(errorTimerRef.current);
    requestRef.current?.abort();
    requestRef.current = null;
    const pendingMessage = pendingMessageRef.current;
    if (pendingMessage) {
      messagesRef.current = messagesRef.current.map((message) => message === pendingMessage ? { ...message, failed: true, cancelled: true } : message);
      setMessages(messagesRef.current);
      pendingMessageRef.current = null;
    }
    lipSync.stop();
    setStreamingText('');
    setStage('idle');
    setErrorMessage('');
  }, [lipSync]);

  const newConversation = useCallback(() => {
    cancelRequest();
    messagesRef.current = [];
    setMessages([]);
    setSpeechMode('');
    // Remount input controls to discard drafts and cancel late mic permission
    // results; the avatar keeps its existing animation instance.
    setConversationId((current) => current + 1);
  }, [cancelRequest]);

  const saveApiKey = useCallback((key) => {
    newConversation();
    apiKeyRef.current = key;
    setApiKey(key);
    setKeyPanelOpen(false);
  }, [newConversation]);

  const processInput = useCallback(async (userText, existingRequest = null) => {
    const text = userText.trim();
    if (!text || (requestRef.current && requestRef.current !== existingRequest)) return false;
    const controller = existingRequest || new AbortController();
    const requestKey = apiKeyRef.current;
    requestRef.current = controller;
    const isCurrent = () => requestRef.current === controller && !controller.signal.aborted;
    clearTimeout(errorTimerRef.current);
    lipSync.stop();
    prepareAudio();

    const context = messagesRef.current.filter((message) => !message.failed).slice(-10);
    const userMessage = { role: 'user', content: text };
    pendingMessageRef.current = userMessage;
    messagesRef.current = [...messagesRef.current.slice(-99), userMessage];
    setMessages(messagesRef.current);
    setStreamingText('');
    setErrorMessage('');
    setStage('thinking');

    let replyCommitted = false;
    try {
      const reply = await streamChat([SYSTEM_PROMPT, ...context, userMessage], {
        signal: controller.signal,
        apiKey: requestKey,
        onToken: (_token, full) => { if (isCurrent()) setStreamingText(full); },
      });
      if (!isCurrent()) return false;
      if (!reply.trim()) throw new Error('The AI returned an empty reply. Please try again.');

      messagesRef.current = [...messagesRef.current, { role: 'assistant', content: reply }];
      setMessages(messagesRef.current);
      setStreamingText('');
      replyCommitted = true;
      pendingMessageRef.current = null;

      // One playback request per reply keeps browser speech and provider audio in order.
      let playing = false;
      setStage('synthesizing');
      try {
        const audioBlob = await synthesize(reply, { signal: controller.signal, apiKey: requestKey });
        if (!isCurrent()) return true;
        setStage('speaking');
        lipSync.enqueue(audioBlob, reply);
        playing = true;
        setSpeechMode('Jason · NVIDIA voice');
      } catch (error) {
        if (!isCurrent()) return replyCommitted;
        console.error('Speech service unavailable:', error);
        setSpeechMode('Browser voice (speech service unavailable)');
      }

      if (!playing) {
        setStage('speaking');
        playing = lipSync.speakTextFallback(reply);
        if (!playing) setSpeechMode('Text only (male voice unavailable)');
      }
      if (!playing) setStage('idle');
      return true;
    } catch (error) {
      if (!isCurrent()) return replyCommitted;
      if (error.status === 401 && requestKey) setKeyPanelOpen(true);
      if (!replyCommitted) {
        messagesRef.current = messagesRef.current.map((message) => (
          message === userMessage ? { ...message, failed: true } : message
        ));
        setMessages(messagesRef.current);
      }
      setStreamingText('');
      showError(error.message || 'The request failed. Please try again.');
      return replyCommitted;
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        pendingMessageRef.current = null;
      }
    }
  }, [lipSync, prepareAudio, showError]);

  const handleRecordingComplete = useCallback(async (audioBlob) => {
    if (requestRef.current) return;
    if (!audioBlob || audioBlob.size === 0) {
      showError('No audio was recorded. Please try again.');
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setStage('transcribing');
    try {
      const transcript = await transcribe(audioBlob, { signal: controller.signal, apiKey: apiKeyRef.current });
      if (requestRef.current !== controller || controller.signal.aborted) return;
      if (!transcript.trim()) {
        showError('No speech was detected. Please try again.');
        return;
      }
      await processInput(transcript, controller);
    } catch (error) {
      if (requestRef.current !== controller || controller.signal.aborted) return;
      if (error.status === 401 && apiKeyRef.current) setKeyPanelOpen(true);
      showError(error.message || 'Transcription failed. Please try again.');
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [processInput, showError]);

  const visitorKeys = REQUIRES_USER_KEY || connection.requiresUserKey;
  const keyPanelVisible = visitorKeys && (!apiKey || keyPanelOpen);
  const ready = connection.online && (visitorKeys ? Boolean(apiKey) : connection.hasNvidiaKey);
  const setupNoticeVisible = connection.checked && (!connection.online || (!visitorKeys && !connection.hasNvidiaKey));
  const controlDescription = setupNoticeVisible ? 'setup-notice' : keyPanelVisible ? 'api-key-notice' : undefined;
  const isBusy = stage === 'starting' || stage === 'recording' || stage === 'transcribing' || stage === 'thinking' || stage === 'synthesizing';

  return (
    <div className="app">
      <div className="scene-container">
        {webglAvailable && (
          <SceneErrorBoundary onError={() => setSceneState('unavailable')}>
            <Suspense fallback={null}>
              <AvatarScene audioLipSync={lipSync} onReady={handleSceneReady} />
            </Suspense>
          </SceneErrorBoundary>
        )}
      </div>

      <div className={`ui-overlay${keyPanelVisible ? ' key-setup' : ''}`}>
        <StatusBar connection={{ ...connection, requiresUserKey: visitorKeys, hasUserKey: Boolean(apiKey) }} pipelineStage={stage} errorMessage={errorMessage} speechMode={speechMode} onManageKey={() => {
          if (!keyPanelOpen) {
            cancelRequest();
            setConversationId((current) => current + 1);
          }
          setKeyPanelOpen((current) => !current);
        }} />
        {setupNoticeVisible && (
          <div className="setup-notice" id="setup-notice" role="status">
            <h2>{connection.online ? 'Live conversation is unavailable' : 'Demo is offline'}</h2>
            <p>{connection.online
              ? 'The AI service is not ready right now. Please try again later.'
              : 'The conversation service could not be reached. On the first visit it may take about a minute to wake. Reconnecting automatically…'}</p>
          </div>
        )}
        <div className="demo-intro">
          <h1>Conversation, brought to life.</h1>
          <p>Speak or type to a live AI. Watch the avatar respond with voice and expression.</p>
          {sceneState !== 'ready' && <SceneStatus loading={sceneState === 'loading'} />}
          {keyPanelVisible && <ApiKeyPanel hasKey={Boolean(apiKey)} relayOrigin={apiRelayOrigin()} onSave={saveApiKey} onRemove={() => saveApiKey('')} />}
          {!keyPanelVisible && <div className="prompt-list" aria-label="Try a prompt">
            {['Explain black holes simply', 'Tell me a short story', 'Give me a creative idea'].map((prompt) => (
              <button key={prompt} type="button" onClick={() => processInput(prompt)} disabled={!ready || isBusy}>
                {prompt}
              </button>
            ))}
          </div>}
        </div>
        <div className="main-layout">
          <ChatPanel messages={messages} streamingText={streamingText} status={stage} onNewConversation={newConversation} />
          {['transcribing', 'thinking', 'synthesizing', 'speaking'].includes(stage) && (
            <button className="stop-button" type="button" onClick={cancelRequest}>
              {stage === 'speaking' ? 'Stop speaking' : 'Cancel request'}
            </button>
          )}
          <div className="controls" key={conversationId}>
            <MicButton
              onRecordingComplete={handleRecordingComplete}
              onStartingChange={(starting) => {
                if (starting) setStage('starting');
                else setStage((current) => current === 'starting' ? 'idle' : current);
              }}
              onRecordingChange={(recording) => {
                if (recording) lipSync.stop();
                setStage(recording ? 'recording' : 'idle');
              }}
              onError={(error) => showError(error.message || 'Microphone access failed.')}
              onInteraction={prepareAudio}
              describedBy={controlDescription}
              disabled={!ready || keyPanelVisible || (isBusy && stage !== 'starting' && stage !== 'recording')}
            />
            <TextInput onSubmit={processInput} describedBy={controlDescription} disabled={!ready || isBusy || keyPanelVisible} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
