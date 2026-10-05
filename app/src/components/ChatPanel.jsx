/**
 * Chat transcript panel — shows conversation history
 * with user messages and assistant responses.
 */

import { useRef, useEffect, useState, useCallback } from 'react';

export function ChatPanel({ messages, streamingText, status, onNewConversation, onRetry, retryDisabled }) {
  const messagesRef = useRef(null);
  const shouldFollowRef = useRef(true);
  const previousCountRef = useRef(0);
  const [showReturnToBottom, setShowReturnToBottom] = useState(false);

  const isNearBottom = useCallback((container) => (
    container.scrollHeight - container.scrollTop - container.clientHeight <= 48
  ), []);

  const scrollToBottom = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    shouldFollowRef.current = true;
    setShowReturnToBottom(false);
  }, []);

  const handleScroll = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    const atBottom = isNearBottom(container);
    shouldFollowRef.current = atBottom;
    setShowReturnToBottom(!atBottom);
  }, [isNearBottom]);

  // Follow new content only while the visitor is already reading the latest turn.
  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    const previousCount = previousCountRef.current;
    const latestMessage = messages.at(-1);
    const newConversation = previousCount > 0 && messages.length === 0;
    const newOwnMessage = messages.length > previousCount && latestMessage?.role === 'user';
    previousCountRef.current = messages.length;

    if (shouldFollowRef.current || newOwnMessage || newConversation) {
      scrollToBottom();
    } else {
      setShowReturnToBottom(true);
    }
  }, [messages, streamingText, scrollToBottom]);

  return (
    <section className="chat-panel" id="chat-panel" aria-label="Conversation">
      <div className="chat-header">
        <h2>Conversation</h2>
        <div className="chat-actions">
          {status && status !== 'idle' && <span className={`status-badge ${status}`}>{status}</span>}
          <button type="button" className="new-chat-button" onClick={onNewConversation} aria-label="Start new conversation">New chat</button>
        </div>
      </div>

      <div ref={messagesRef} className="chat-messages" aria-live="polite" aria-relevant="additions text" onScroll={handleScroll}>
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
      {showReturnToBottom && (
        <button type="button" className="return-bottom-button" onClick={scrollToBottom}>
          Return to latest message
        </button>
      )}
    </section>
  );
}
