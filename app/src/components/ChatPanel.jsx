/**
 * Chat transcript panel — shows conversation history
 * with user messages and assistant responses.
 */

import { useRef, useEffect } from 'react';

export function ChatPanel({ messages, streamingText, status }) {
  const messagesRef = useRef(null);

  // Keep the transcript visible without scrolling the page around it.
  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, streamingText]);

  return (
    <div className="chat-panel" id="chat-panel">
      <div className="chat-header">
        <h2>Conversation</h2>
        {status && status !== 'idle' && <span className={`status-badge ${status}`}>{status}</span>}
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
              {msg.failed ? 'You · request failed' : msg.role === 'user' ? 'You' : 'Assistant'}
            </div>
            <div className="message-text">{msg.content}</div>
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
    </div>
  );
}
