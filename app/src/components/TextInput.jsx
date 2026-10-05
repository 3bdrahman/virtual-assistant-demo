/**
 * Text input component — alternative to voice for typing messages.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

export function TextInput({ onSubmit, sentMessage, describedBy, disabled }) {
  const [text, setText] = useState('');
  const composingRef = useRef(false);

  // The parent commit is the only clear signal; late submit promises must not
  // erase a newer draft that happens to match the previous message text.
  useEffect(() => {
    if (sentMessage) setText((current) => current.trim() === sentMessage.content ? '' : current);
  }, [sentMessage]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!text.trim() || disabled || composingRef.current) return;
    const submitted = text.trim();
    await onSubmit(submitted);
  }, [text, disabled, onSubmit]);

  return (
    <form className="text-input-form" onSubmit={handleSubmit}>
      <input
        id="text-input"
        type="text"
        className="text-input"
        aria-label="Message"
        placeholder="Type a message..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
        }}
        disabled={disabled}
        aria-describedby={describedBy}
        autoComplete="off"
        maxLength={8000}
      />
      <button
        type="submit"
        className="send-button"
        disabled={disabled || !text.trim()}
        aria-label="Send message"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </form>
  );
}
