/**
 * Chat transcript panel — shows conversation history
 * with user messages and assistant responses.
 */

import { useRef, useEffect } from 'react';

export function ChatPanel({ messages, streamingText, status, onNewConversation, onRetry, retryDisabled }) {
  const messagesRef = useRef(null);

  // Keep the transcript visible without scrolling the page around it.
  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, streamingText]);

  return (
    <section className="chat-panel" id="chat-panel" aria-label="Conversation">
      <div className="chat-header">
        <h2>Conversation</h2>
        <div className="chat-actions">
          {status && status !== 'idle' && <span className={`status-badge ${status}`}>{status}</span>}
          <button type="button" className="new-chat-button" onClick={onNewConversation} aria-label="Start new conversation">New chat</button>
        </div>
      </div>

      <div ref={messagesRef} className="chat-messages" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && !streamingText && (
          <div className="chat-empty">
            <p>Ask a question by voice or text.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}${msg.failed ? ' failed' : ''}`}>
            <div className="message-label">
              {msg.cancelled ? 'You · request cancelled' : msg.failed ? 'You · request failed' : msg.role === 'user' ? 'You' : 'Assistant'}
            </div>
            <div className="message-text">{msg.content}</div>
            {msg.failed && <div className="message-retry">
              {msg.error && <span>{msg.error}</span>}
              <button type="button" onClick={() => onRetry(msg.content)} disabled={retryDisabled} aria-label="Retry message">Retry</button>
            </div>}
          </div>
        ))}

        {streamingText && (
          <div className="chat-message assistant streaming">
            <div className="message-label">Assistant</div>
            <div className="message-text">
              {streamingText}
              <span className="cursor-blink">▍</span>
            </div>
          </div>
        )}

      </div>
    </section>
  );
}
