import type { DecompositionDiagnostic, DecompositionDocumentV1, PartRecord, RegionMask } from './types';

type Proposal = NonNullable<PartRecord['attachmentProposal']>;
interface Contact { first: number; second: number; pixels: number; sumX: number; sumY: number }

/** Contact-only, deterministic suggestions. No proposal mutates the approved attachment tree. */
export function proposePartAttachments(document: DecompositionDocumentV1, masks: ReadonlyMap<string, RegionMask>): {
  proposals: Map<string, Proposal>; diagnostics: DecompositionDiagnostic[];
} {
  const proposals = new Map<string, Proposal>(), diagnostics: DecompositionDiagnostic[] = [];
  if (document.mode !== 'animation-ready') return { proposals, diagnostics };
  const source = document.sources.find(item => item.role === 'primary');
  if (!source) throw new Error('Primary source is missing.');
  const parts = document.parts.filter(part => document.regions.some(region => region.partId === part.id && region.sourceId === source.id
    && region.generationStatus !== 'historical' && !region.suppressed && region.geometry.status === 'visible')).sort((a, b) => a.id.localeCompare(b.id));
  if (parts.length < 2) return { proposals, diagnostics };
  if (parts.length > 512) {
    diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: source.id,
      message: 'Automatic attachment suggestions are skipped for more than 512 visible parts.', suggestion: 'Group related regions into meaningful parts first.' });
    return { proposals, diagnostics };
  }
  const index = new Map(parts.map((part, at) => [part.id, at + 1]));
  const labels = new Uint16Array(source.width * source.height), area = new Uint32Array(parts.length + 1);
  let visitedCells = 0;
  for (const region of document.regions) {
    if (region.sourceId !== source.id || region.generationStatus === 'historical' || region.suppressed || region.geometry.status !== 'visible' || !region.partId) continue;
    const label = index.get(region.partId);
    if (!label) continue;
    const mask = masks.get(region.maskId);
    if (!mask || mask.width !== region.bounds.width || mask.height !== region.bounds.height) throw new Error(`Missing region mask for ${region.id}.`);
    visitedCells += mask.bytes.length;
    if (visitedCells > 12_000_000) {
      diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: source.id,
        message: 'Automatic attachment suggestions reached their source-mask analysis budget.', suggestion: 'Crop the source or group parts manually.' });
      return { proposals, diagnostics };
    }
    for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
      const local = y * mask.width + x;
      if (!mask.bytes[local] || mask.alpha && mask.alpha[local] < 128) continue;
      const pixel = (region.bounds.y + y) * source.width + region.bounds.x + x;
      if (!labels[pixel]) { labels[pixel] = label; area[label]++; }
    }
  }
  const contacts = new Map<number, Contact>();
  const add = (a: number, b: number, x: number, y: number) => {
    if (!a || !b || a === b) return;
    const first = Math.min(a, b), second = Math.max(a, b), key = first * (parts.length + 1) + second;
    const contact = contacts.get(key) ?? { first, second, pixels: 0, sumX: 0, sumY: 0 };
    contact.pixels++; contact.sumX += x; contact.sumY += y; contacts.set(key, contact);
  };
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const at = y * source.width + x, label = labels[at];
    if (x + 1 < source.width) add(label, labels[at + 1], x + 1, y + .5);
    if (y + 1 < source.height) add(label, labels[at + source.width], x + .5, y + 1);
  }
  const root = parts.map((part, at) => ({ part, label: at + 1, area: area[at + 1] })).sort((a, b) => b.area - a.area || a.part.id.localeCompare(b.part.id))[0];
  for (const [at, part] of parts.entries()) {
    const label = at + 1;
    if (label === root.label || part.attachmentLocked || part.attachmentApproved || part.attachmentProposalRejected || part.parentId || part.attachment) continue;
    const possible = [...contacts.values()].filter(contact => contact.pixels >= 2 && (contact.first === label || contact.second === label))
      .map(contact => ({ contact, parentLabel: contact.first === label ? contact.second : contact.first }))
      .filter(item => area[item.parentLabel] > area[label] || area[item.parentLabel] === area[label] && parts[item.parentLabel - 1].id < part.id)
      .sort((a, b) => b.contact.pixels - a.contact.pixels || area[b.parentLabel] - area[a.parentLabel] || parts[a.parentLabel - 1].id.localeCompare(parts[b.parentLabel - 1].id));
    if (!possible.length) continue;
    const best = possible[0], parent = parts[best.parentLabel - 1];
    const localized = best.contact.pixels <= Math.max(3, Math.sqrt(area[label]) * .7);
    const ambiguity = possible.length > 1 && possible[1].contact.pixels >= best.contact.pixels * .85
      ? 'Several larger parts touch this part with similar evidence; review the intended parent.' : undefined;
    proposals.set(part.id, { parentId: parent.id, type: localized ? 'hinge' : 'fixed',
      pivot: { x: best.contact.sumX / best.contact.pixels, y: best.contact.sumY / best.contact.pixels },
      evidence: [`${best.contact.pixels} shared source-pixel edges with ${parent.id}`, localized ? 'localized contact suggests a rotation anchor' : 'broad contact suggests a fixed connection',
        'one still image cannot prove a joint type or motion limit'], ...(ambiguity ? { ambiguity } : {}) });
    if (ambiguity) diagnostics.push({ code: 'AMBIGUOUS_REGION', severity: 'info', sourceId: source.id, partId: part.id,
      message: ambiguity, suggestion: 'Inspect the candidate parent and choose or reject the attachment manually.' });
  }
  return { proposals, diagnostics };
}
