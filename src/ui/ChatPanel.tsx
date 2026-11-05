import { useEffect, useRef, useState } from 'react';
import { gateState, type Member } from '../lib/clerkGate';
import type { ChatEntry } from '../store/chat';

export default function ChatPanel({ chat, meKey, github, member, onSend, onReport, onConnect }: {
  chat: ChatEntry[]; meKey: string; github: string | null; member: Member | null;
  onSend(text: string): Promise<string | null>; onReport(id: number): void; onConnect(): void;
}) {
  const gated = gateState(github, member) === 'gate';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [chat.length]);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const bad = await onSend(t);
    setErr(bad);
    if (!bad) setText('');
    setBusy(false);
  }

  return (
    <div className="panel chat">
      <h3>STORE CHAT</h3>
      <div className="chatlog" aria-live="polite">
        {chat.length === 0 && <p className="small dim">Quiet in here. Say hi!</p>}
        {chat.map((m) => (
          <p key={m.id} className={'cmsg' + (m.sender_key === meKey ? ' mine' : '')}>
            <b>{m.login}</b> {m.body}
            {m.sender_key !== meKey && !gated && (
              <button className="linkbtn rep" onClick={() => onReport(m.id)} aria-label={`Report ${m.login}'s message`} title="Report">!</button>
            )}
          </p>
        ))}
        <div ref={end} />
      </div>
      {gated ? (
        <p className="small">
          Connect your GitHub to chat. You can still walk around and watch.{' '}
          <button className="linkbtn" onClick={onConnect}>CONNECT GITHUB</button>
        </p>
      ) : (
        <form onSubmit={go} className="row">
          <input value={text} maxLength={140} onChange={(e) => setText(e.target.value)} placeholder="Say something (140 max)" aria-label="Chat message" />
          <button className="btn" disabled={busy || !text.trim()}>SEND</button>
        </form>
      )}
      {err && <p className="small cerr">{err}</p>}
    </div>
  );
}
