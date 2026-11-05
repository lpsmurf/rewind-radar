import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** The public address of this store (GitHub Pages in production, localhost in dev). */
export const JOIN_URL = `${location.origin}${import.meta.env.BASE_URL}`;

/** Navy-on-cream QR code pointing at the store. */
export function QR({ size }: { size: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(JOIN_URL, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b2a6f', light: '#fff6d5' },
    }).then(setSvg, () => setSvg(''));
  }, []);
  return (
    <div
      className="qr"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`QR code for ${JOIN_URL}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Small "scan to join" card for the side column. */
export function JoinCard({ onShowBig }: { onShowBig(): void }) {
  return (
    <div className="panel join">
      <h3>SCAN TO JOIN</h3>
      <button className="qrbtn" onClick={onShowBig} aria-label="Show the QR code full screen">
        <QR size={132} />
      </button>
      <p className="small">{JOIN_URL.replace(/^https?:\/\//, '')}</p>
      <button className="btn full" onClick={onShowBig}>SHOW BIG QR · Q</button>
    </div>
  );
}

/** Full-screen presenter view: huge QR plus a live head count. */
export function BigQR({ inStore, onClose }: { inStore: number; onClose(): void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Fit inside the panel: leave room for padding/border horizontally and the title + URL vertically.
  const size = Math.floor(Math.max(160, Math.min(window.innerHeight - 260, window.innerWidth - 110, 560)));
  return (
    <div className="overlay bigqr" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose} aria-label="close">X</button>
        <h2>SCAN TO JOIN THE STORE</h2>
        <QR size={size} />
        <p className="url">{JOIN_URL.replace(/^https?:\/\//, '')}</p>
        <p className="count">● {inStore} IN STORE</p>
      </div>
    </div>
  );
}
