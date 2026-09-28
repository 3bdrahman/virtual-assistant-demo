/**
 * Text input component — alternative to voice for typing messages.
 */

import { useState, useCallback } from 'react';

export function TextInput({ onSubmit, describedBy, disabled }) {
  const [text, setText] = useState('');

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    const submitted = text.trim();
    const succeeded = await onSubmit(submitted);
    if (succeeded) setText((current) => current.trim() === submitted ? '' : current);
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
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
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
