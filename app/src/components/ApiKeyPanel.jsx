import { useState } from 'react';

export function ApiKeyPanel({ hasKey, relayOrigin, onSave, onRemove }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const submit = (event) => {
    event.preventDefault();
    const key = value.trim();
    if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) {
      setError('Enter your NVIDIA API key without spaces.');
      return;
    }
    onSave(key);
    setValue('');
    setError('');
  };

  return (
    <section className="api-key-panel" aria-labelledby="api-key-heading">
      <h2 id="api-key-heading">{hasKey ? 'Change your NVIDIA API key' : 'Add your NVIDIA API key'}</h2>
      <p id="api-key-notice">Your key stays in this page’s memory and is cleared on reload. Requests go through {relayOrigin} to NVIDIA and use your NVIDIA quota.</p>
      {hasKey && <p>Changing or removing the key starts a new chat.</p>}
      <form onSubmit={submit}>
        <label htmlFor="visitor-api-key">NVIDIA API key</label>
        <input id="visitor-api-key" type="password" value={value} onChange={(event) => setValue(event.target.value)}
          autoComplete="off" spellCheck={false} maxLength={4096} required aria-describedby="api-key-notice" />
        {error && <p role="alert" className="key-error">{error}</p>}
        <div className="key-actions">
          <button type="submit" disabled={!value.trim()}>Use key</button>
          {hasKey && <button type="button" onClick={() => { setValue(''); setError(''); onRemove(); }}>Remove key</button>}
          <a href="https://build.nvidia.com/" target="_blank" rel="noreferrer">Get a key from NVIDIA</a>
        </div>
      </form>
    </section>
  );
}
