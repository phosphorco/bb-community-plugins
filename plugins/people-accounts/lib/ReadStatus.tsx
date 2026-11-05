import { useEffect, useMemo, useState } from 'react';

export const READ_RECOVERY_GRACE_MS = 30_000;
/** One timer per continuous outage, even when retry messages change. */
export function useReadStatus(error: string | null, retryable = true) {
  const failed = error !== null;
  const episode = useMemo(() => ({}), [failed]);
  const [shown, setShown] = useState<object | null>(null);
  useEffect(() => {
    if (!failed || !retryable) return;
    let active = true;
    const timer = window.setTimeout(() => { if (active) setShown(episode); }, READ_RECOVERY_GRACE_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [episode, failed, retryable]);
  return failed && (!retryable || shown === episode);
}

/** Read failures are quiet status; raw diagnostics stay available on demand. */
export function ReadStatus({ error, subject, retry, retryable = true }: {
  error: string | null; subject: string; retry?: () => void; retryable?: boolean;
}) {
  const visible = useReadStatus(error, retryable);
  if (!visible) return null;
  return <ReadStatusContent error={error!} subject={subject} retry={retry} retryable={retryable} />;
}

export function ReadStatusContent({ error, subject, retry, retryable = true }: {
  error: string; subject: string; retry?: () => void; retryable?: boolean;
}) {
  return <div data-read-status style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0.5rem', color: 'var(--muted-foreground)', fontSize: '12px', padding: '4px 8px' }}>
    <span role="status">{subject} {retryable ? 'temporarily unavailable. Retrying automatically.' : 'unavailable.'}</span>
    {retry && <button type="button" onClick={retry} style={{ background: 'transparent', color: 'inherit', border: 0, padding: 0, font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>Retry now</button>}
    <details><summary>Details</summary><span style={{ overflowWrap: 'anywhere' }}>{error}</span></details>
  </div>;
}
