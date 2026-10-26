import { useEffect, useRef, useState } from 'react';
import { Pipette } from 'lucide-react';

const validHex = /^#[0-9a-f]{6}$/i;

export function ColorControl({ label, pickerLabel, value, mixed = false, onChange, onNotice }: {
  label: string; pickerLabel: string; value: string; mixed?: boolean;
  onChange: (value: string) => void; onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState(mixed ? '' : value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(mixed ? '' : value), [value, mixed]);
  const eyeSupported = typeof window !== 'undefined' && 'EyeDropper' in window;
  function commit() {
    if(cancelled.current){cancelled.current=false;setDraft(mixed ? '' : value);return;}
    const candidate = draft.trim();
    if (validHex.test(candidate)) onChange(candidate.toLowerCase());
    else if (candidate !== '') onNotice('Use a six-digit hex color such as #123abc. The previous color was kept.');
    setDraft(mixed ? '' : value);
  }
  async function pickScreen() {
    const EyeDropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropper) return;
    try {
      const result = await new EyeDropper().open();
      if (validHex.test(result.sRGBHex)) onChange(result.sRGBHex.toLowerCase());
    } catch { /* Esc cancels the browser picker without changing the color. */ }
  }
  return <div className="color-field color-control"><span>{label}</span><input aria-label={pickerLabel} type="color" value={validHex.test(value) ? value : '#000000'} onChange={event => onChange(event.target.value)}/><input aria-label={`${pickerLabel} hex`} className="color-hex" type="text" spellCheck={false} value={draft} placeholder={mixed ? 'Mixed' : '#RRGGBB'} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { event.preventDefault(); cancelled.current=true; setDraft(mixed ? '' : value); event.currentTarget.blur(); } }}/><button type="button" aria-label={`${pickerLabel} eyedropper`} title={eyeSupported ? 'Pick a color from the screen' : 'Screen eyedropper is unavailable in this browser'} disabled={!eyeSupported} onClick={() => void pickScreen()}><Pipette size={14}/></button></div>;
}
