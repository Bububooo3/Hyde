import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import type { LayoutCursor, PreparedTextWithSegments } from '@chenglou/pretext';
import type { TextAnimation } from './model';

export interface TextUnit {
  id: string;
  text: string;
  x: number; y: number; width: number; height: number;
}

function cursorOffset(prepared: PreparedTextWithSegments, cursor: LayoutCursor): number {
  let offset = 0;
  for (let index = 0; index < cursor.segmentIndex; index++) offset += prepared.segments[index]?.length ?? 0;
  if (cursor.graphemeIndex > 0 && cursor.segmentIndex < prepared.segments.length) {
    const segment = prepared.segments[cursor.segmentIndex];
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(segment);
    let count = 0;
    for (const part of graphemes) {
      if (count++ >= cursor.graphemeIndex) break;
      offset += part.segment.length;
    }
  }
  return offset;
}

function measuredWidth(text: string, font: string): number {
  if (!text) return 0;
  const prepared = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' });
  let width = 0;
  for (let index = 0; index < prepared.widths.length; index++) width += prepared.widths[index];
  return width;
}

/** Pretext owns the line breaks and pixel advances. Source offsets give words
 * stable identities when a live text box reflows onto different lines. */
export function layoutTextUnits(
  prepared: PreparedTextWithSegments,
  font: string,
  width: number,
  lineHeight: number,
  unit: TextAnimation['unit'],
): TextUnit[] {
  const lines = layoutWithLines(prepared, Math.max(1, width), lineHeight).lines;
  if (unit === 'line') return lines.map((line, index) => ({
    id: `line:${cursorOffset(prepared, line.start)}`,
    text: line.text,
    x: 0,
    y: index * lineHeight,
    width: line.width,
    height: lineHeight,
  }));
  const units: TextUnit[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const sourceStart = cursorOffset(prepared, line.start);
    for (const match of line.text.matchAll(/\S+/gu)) {
      const text = match[0];
      const character = match.index;
      units.push({
        id: `word:${sourceStart + character}`,
        text,
        x: measuredWidth(line.text.slice(0, character), font),
        y: lineIndex * lineHeight,
        width: measuredWidth(text, font),
        height: lineHeight,
      });
    }
  }
  return units;
}
