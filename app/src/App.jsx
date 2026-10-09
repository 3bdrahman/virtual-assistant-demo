import { useState, useRef, useCallback, useEffect, Suspense, lazy, Component } from 'react';
import { MicButton } from './components/MicButton';
import { ChatPanel } from './components/ChatPanel';
import { TextInput } from './components/TextInput';
import { StatusBar } from './components/StatusBar';
import { ApiKeyPanel } from './components/ApiKeyPanel';
import { transcribe, streamChat, streamSynthesize, checkHealth, REQUIRES_USER_KEY, apiRelayOrigin } from './services/nim';
import { AudioLipSync } from './services/audioLipSync';
import { SpeechStream } from './services/speechStream';
import { canUseWebGL } from './utils/webgl';
import { watchServiceHealth } from './services/serviceHealth';

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
  const [sentMessage, setSentMessage] = useState(null);
  const messagesRef = useRef([]);
  const [streamingText, setStreamingText] = useState('');
  const [stage, setStage] = useState('idle');
  const [isResponding, setIsResponding] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [connection, setConnection] = useState({ checked: false, online: false, hasNvidiaKey: false });
  const [speechMode, setSpeechMode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyRejected, setKeyRejected] = useState(false);
  const [recoveryDraft, setRecoveryDraft] = useState('');
  const apiKeyRef = useRef('');
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  const [conversationId, setConversationId] = useState(0);
  const [lipSync] = useState(() => new AudioLipSync());
  const [webglAvailable] = useState(() => canUseWebGL());
  const [sceneState, setSceneState] = useState(() => webglAvailable ? 'loading' : 'unavailable');
  const requestRef = useRef(null);
  const speechStreamRef = useRef(null);
  const pendingMessageRef = useRef(null);
  const errorTimerRef = useRef(null);
  const handleSceneReady = useCallback(() => setSceneState('ready'), []);

  useEffect(() => {
    const stopHealth = watchServiceHealth({ probe: (signal) => checkHealth(5000, { signal }), onChange: setConnection });
    lipSync.onIdle = () => setStage((current) => current === 'speaking' ? (requestRef.current ? 'synthesizing' : 'idle') : current);
    lipSync.onPlaybackStart = () => setStage('speaking');
    lipSync.onQueueChange = () => speechStreamRef.current?.resume();
    lipSync.onPlaybackError = (_error, text) => {
      setSpeechMode('Browser voice (audio playback unavailable)');
      if (!lipSync.speakTextFallback(text)) {
        setSpeechMode('Text only (male voice unavailable)');
        if (!requestRef.current) setStage('idle');
      }
    };
    lipSync.onSpeechError = () => setSpeechMode('Text only (male voice unavailable)');
    return () => {
      stopHealth();
      clearTimeout(errorTimerRef.current);
      requestRef.current?.abort();
      requestRef.current = null;
      lipSync.onIdle = null;
      lipSync.onPlaybackStart = null;
      lipSync.onQueueChange = null;
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
    speechStreamRef.current = null;
    setIsResponding(false);
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
    setRecoveryDraft('');
    // Remount input controls to discard drafts and cancel late mic permission
    // results; the avatar keeps its existing animation instance.
    setConversationId((current) => current + 1);
  }, [cancelRequest]);

  const saveApiKey = useCallback((key) => {
    const lastMessage = messagesRef.current.at(-1);
    const retryDraft = key && keyRejected && lastMessage?.failed ? lastMessage.content : '';
    newConversation();
    setRecoveryDraft(retryDraft);
    apiKeyRef.current = key;
    setApiKey(key);
    setKeyRejected(false);
    setKeyPanelOpen(false);
  }, [keyRejected, newConversation]);

  const processInput = useCallback(async (userText, existingRequest = null) => {
    const text = userText.trim();
    if (!text || (requestRef.current && requestRef.current !== existingRequest)) return false;
    const controller = existingRequest || new AbortController();
    const requestKey = apiKeyRef.current;
    requestRef.current = controller;
    setIsResponding(true);
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

    const speech = new SpeechStream({
      signal: controller.signal,
      getPendingCount: () => lipSync.pendingCount,
      onSynthesizing: () => { if (isCurrent() && !lipSync.isPlaying) setStage('synthesizing'); },
      synthesize: async (phrase) => {
        const group = lipSync.beginPcm(phrase);
        let receivedAudio = false;
        try {
          await streamSynthesize(phrase, {
            signal: controller.signal,
            apiKey: requestKey,
            onChunk: (samples) => {
              if (!isCurrent()) return;
              if (!lipSync.enqueuePcm(samples, phrase, { speechId: group })) throw new Error('Audio output is no longer available.');
              receivedAudio = true;
              setSpeechMode('Jason · NVIDIA voice');
            },
          });
        } catch (error) {
          error.partialAudio = receivedAudio;
          throw error;
        } finally {
          if (isCurrent()) lipSync.finishPcm(group);
        }
      },
      onError: (error) => {
        console.error('Speech service unavailable:', error);
        setSpeechMode(error.partialAudio ? 'Voice interrupted · full response in chat' : 'Browser voice (speech service unavailable)');
      },
      onFallback: (phrase) => {
        if (!lipSync.enqueueText(phrase)) setSpeechMode('Text only (male voice unavailable)');
      },
    });
    speechStreamRef.current = speech;

    let replyCommitted = false;
    try {
      const reply = await streamChat([SYSTEM_PROMPT, ...context, userMessage], {
        signal: controller.signal,
        apiKey: requestKey,
        onToken: (token, full) => {
          if (!isCurrent()) return;
          setStreamingText(full);
          speech.push(token);
        },
      });
      if (!isCurrent()) return false;
      if (!reply.trim()) throw new Error('The AI returned an empty reply. Please try again.');

      messagesRef.current = [...messagesRef.current, { role: 'assistant', content: reply }];
      setMessages(messagesRef.current);
      setStreamingText('');
      replyCommitted = true;
      setSentMessage(userMessage);
      pendingMessageRef.current = null;

      // Flush the final phrase while earlier audio keeps playing. The stream
      // limits synthesis lookahead and preserves phrase order.
      await speech.finish();
      if (!isCurrent()) return true;
      if (!lipSync.isPlaying) setStage('idle');
      return true;
    } catch (error) {
      if (!isCurrent()) return replyCommitted;
      controller.abort();
      lipSync.stop();
      if (error.status === 401 && requestKey) {
        setKeyRejected(true);
        setKeyPanelOpen(true);
      }
      if (!replyCommitted) {
        messagesRef.current = messagesRef.current.map((message) => (
          message === userMessage ? { ...message, failed: true, error: error.message || 'The request failed. Please retry.' } : message
        ));
        setMessages(messagesRef.current);
      }
      setStreamingText('');
      showError(error.message || 'The request failed. Please try again.');
      return replyCommitted;
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        speechStreamRef.current = null;
        setIsResponding(false);
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
      if (error.status === 401 && apiKeyRef.current) {
        setKeyRejected(true);
        setKeyPanelOpen(true);
      }
      showError(error.message || 'Transcription failed. Please try again.');
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [processInput, showError]);

  const visitorKeys = REQUIRES_USER_KEY || connection.requiresUserKey;
  const keyPanelVisible = visitorKeys && (!apiKey || keyPanelOpen || keyRejected);
  const ready = connection.online && (visitorKeys ? Boolean(apiKey) && !keyRejected : connection.hasNvidiaKey);
  const setupNoticeVisible = connection.checked && (!connection.online || (!visitorKeys && !connection.hasNvidiaKey));
  const controlDescription = setupNoticeVisible ? 'setup-notice' : keyPanelVisible ? 'api-key-notice' : undefined;
  const isBusy = isResponding || stage === 'starting' || stage === 'recording' || stage === 'transcribing' || stage === 'thinking' || stage === 'synthesizing';

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
        <StatusBar connection={{ ...connection, requiresUserKey: visitorKeys, hasUserKey: Boolean(apiKey), keyRejected }} pipelineStage={stage} errorMessage={errorMessage} speechMode={speechMode} onManageKey={() => {
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
          {!setupNoticeVisible && sceneState !== 'ready' && <SceneStatus loading={sceneState === 'loading'} />}
          {keyPanelVisible && <ApiKeyPanel hasKey={Boolean(apiKey)} rejected={keyRejected} relayOrigin={apiRelayOrigin()} onSave={saveApiKey} onRemove={() => saveApiKey('')} />}
          {!keyPanelVisible && <div className="prompt-list" aria-label="Try a prompt">
            {['Explain black holes simply', 'Tell me a short story', 'Give me a creative idea'].map((prompt) => (
              <button key={prompt} type="button" onClick={() => processInput(prompt)} disabled={!ready || isBusy}>
                {prompt}
              </button>
            ))}
          </div>}
        </div>
        <div className="main-layout">
          <ChatPanel messages={messages} streamingText={streamingText} status={stage} onNewConversation={newConversation} onRetry={processInput} retryDisabled={!ready || isBusy || keyPanelVisible} />
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
            <TextInput initialText={recoveryDraft} onSubmit={processInput} sentMessage={sentMessage} describedBy={controlDescription} disabled={!ready || isBusy || keyPanelVisible} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
