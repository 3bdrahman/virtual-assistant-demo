import { useState, useRef, useCallback, useEffect, Suspense, lazy, Component } from 'react';
import { MicButton } from './components/MicButton';
import { ChatPanel } from './components/ChatPanel';
import { TextInput } from './components/TextInput';
import { StatusBar } from './components/StatusBar';
import { transcribe, streamChat, synthesize, checkHealth } from './services/nim';
import { AudioLipSync } from './services/audioLipSync';
import { canUseWebGL } from './utils/webgl';

const AvatarScene = lazy(() => import('./components/AvatarScene'));

function SceneStatus({ loading = false }) {
  return (
    <div className="scene-unavailable" role="status">
      <strong>{loading ? 'Loading avatar…' : '3D preview unavailable'}</strong>
      <span>{loading ? 'The conversation controls are ready.' : 'You can still use the conversation controls.'}</span>
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
  }

  render() {
    return this.state.failed ? <SceneStatus /> : this.props.children;
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
  const [lipSync] = useState(() => new AudioLipSync());
  const [webglAvailable] = useState(() => canUseWebGL());
  const requestInFlightRef = useRef(false);
  const errorTimerRef = useRef(null);

  useEffect(() => {
    let active = true;
    checkHealth().then((health) => {
      if (!active) return;
      setConnection({
        checked: true,
        online: Boolean(health.ok),
        hasNvidiaKey: Boolean(health.hasNvidiaKey),
      });
      setSpeechMode('');
    });
    lipSync.onIdle = () => setStage((current) => current === 'speaking' ? 'idle' : current);
    lipSync.onPlaybackError = (_error, text) => {
      setSpeechMode('Browser voice (audio playback unavailable)');
      if (!lipSync.speakTextFallback(text)) {
        setSpeechMode('Text only (speech unavailable)');
        setStage('idle');
      }
    };
    lipSync.onSpeechError = () => setSpeechMode('Text only (speech unavailable)');
    return () => {
      active = false;
      clearTimeout(errorTimerRef.current);
      lipSync.onIdle = null;
      lipSync.onPlaybackError = null;
      lipSync.onSpeechError = null;
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

  const processInput = useCallback(async (userText) => {
    const text = userText.trim();
    if (!text || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    clearTimeout(errorTimerRef.current);
    lipSync.stop();
    prepareAudio();

    const context = messagesRef.current.filter((message) => !message.failed).slice(-10);
    const userMessage = { role: 'user', content: text };
    messagesRef.current = [...messagesRef.current, userMessage];
    setMessages(messagesRef.current);
    setStreamingText('');
    setErrorMessage('');
    setStage('thinking');

    let replyCommitted = false;
    try {
      const reply = await streamChat([SYSTEM_PROMPT, ...context, userMessage], {
        onToken: (_token, full) => setStreamingText(full),
      });
      if (!reply.trim()) throw new Error('The AI returned an empty reply. Please try again.');

      messagesRef.current = [...messagesRef.current, { role: 'assistant', content: reply }];
      setMessages(messagesRef.current);
      setStreamingText('');
      replyCommitted = true;

      // One playback request per reply keeps browser speech and provider audio in order.
      let playing = false;
      setStage('synthesizing');
      try {
        const audioBlob = await synthesize(reply);
        setStage('speaking');
        lipSync.enqueue(audioBlob, reply);
        playing = true;
        setSpeechMode('NVIDIA voice');
      } catch (error) {
        console.error('Speech service unavailable:', error);
        setSpeechMode('Browser voice (speech service unavailable)');
      }

      if (!playing) {
        setStage('speaking');
        playing = lipSync.speakTextFallback(reply);
        if (!playing) setSpeechMode('Text only (speech unavailable)');
      }
      if (!playing) setStage('idle');
    } catch (error) {
      if (!replyCommitted) {
        messagesRef.current = messagesRef.current.map((message) => (
          message === userMessage ? { ...message, failed: true } : message
        ));
        setMessages(messagesRef.current);
      }
      setStreamingText('');
      showError(error.message || 'The request failed. Please try again.');
    } finally {
      requestInFlightRef.current = false;
    }
  }, [lipSync, prepareAudio, showError]);

  const handleRecordingComplete = useCallback(async (audioBlob) => {
    if (!audioBlob || audioBlob.size === 0) {
      showError('No audio was recorded. Please try again.');
      return;
    }
    setStage('transcribing');
    try {
      const transcript = await transcribe(audioBlob);
      if (!transcript.trim()) {
        showError('No speech was detected. Please try again.');
        return;
      }
      await processInput(transcript);
    } catch (error) {
      showError(error.message || 'Transcription failed. Please try again.');
    }
  }, [processInput, showError]);

  const ready = connection.online && connection.hasNvidiaKey;
  const isBusy = stage === 'recording' || stage === 'transcribing' || stage === 'thinking' || stage === 'synthesizing';

  return (
    <div className="app">
      <div className="scene-container">
        {webglAvailable ? (
          <SceneErrorBoundary>
            <Suspense fallback={<SceneStatus loading />}>
              <AvatarScene audioLipSync={lipSync} />
            </Suspense>
          </SceneErrorBoundary>
        ) : (
          <SceneStatus />
        )}
      </div>

      <div className="ui-overlay">
        <StatusBar connection={connection} pipelineStage={stage} errorMessage={errorMessage} speechMode={speechMode} />
        {connection.checked && !ready && (
          <div className="setup-notice" id="setup-notice" role="status">
            <h1>{connection.online ? 'Live conversation is unavailable' : 'Demo is offline'}</h1>
            <p>{connection.online
              ? 'The AI service is not ready right now. Please try again later.'
              : 'The conversation service could not be reached. Please try again shortly.'}</p>
          </div>
        )}
        <div className="demo-intro">
          <h1>Conversation, brought to life.</h1>
          <p>Speak or type to a live AI. Watch the avatar respond with voice and expression.</p>
          <div className="prompt-list" aria-label="Try a prompt">
            {['Explain black holes simply', 'Tell me a short story', 'Give me a creative idea'].map((prompt) => (
              <button key={prompt} type="button" onClick={() => processInput(prompt)} disabled={!ready || isBusy}>
                {prompt}
              </button>
            ))}
          </div>
        </div>
        <div className="main-layout">
          <ChatPanel messages={messages} streamingText={streamingText} status={stage} />
          <div className="controls">
            <MicButton
              onRecordingComplete={handleRecordingComplete}
              onRecordingChange={(recording) => {
                if (recording) lipSync.stop();
                setStage(recording ? 'recording' : 'idle');
              }}
              onError={(error) => showError(error.message || 'Microphone access failed.')}
              onInteraction={prepareAudio}
              describedBy={connection.checked && !ready ? 'setup-notice' : undefined}
              disabled={!ready || (isBusy && stage !== 'recording')}
            />
            <TextInput onSubmit={processInput} describedBy={connection.checked && !ready ? 'setup-notice' : undefined} disabled={!ready || isBusy} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
