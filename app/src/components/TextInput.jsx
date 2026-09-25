/**
 * Text input component — alternative to voice for typing messages.
 */

import { useState, useCallback } from 'react';

export function TextInput({ onSubmit, describedBy, disabled }) {
  const [text, setText] = useState('');

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSubmit(text.trim());
    setText('');
  }, [text, disabled, onSubmit]);

  return (
    <form className="text-input-form" onSubmit={handleSubmit}>
      <input
        id="text-input"
        type="text"
        className="text-input"
        placeholder="Type a message..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        aria-describedby={describedBy}
        autoComplete="off"
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
