// @vitest-environment node
import { expect, it } from 'vitest';
import { runBrowserTask } from '../cliBrowserRunner';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';
import { DecompositionSession } from './session';
import { compareNativeRender } from './quality';

it('proposes contact pivots and reviewable attachments without changing the primary pose or inventing motion', async () => {
  const fixture = makeSyntheticFixture('articulated-character');
  const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
  await session.analyze();
  const initial = session.snapshot();
  const torso = initial.regions.find(region => region.bounds.x === 25 && region.bounds.y === 22)?.partId;
  expect(torso).toBeTruthy();
  const suggestions = initial.parts.filter(part => part.attachmentProposal);
  expect(suggestions.length).toBeGreaterThanOrEqual(4);
  expect(suggestions.every(part => part.attachmentProposal!.parentId === torso)).toBe(true);
  expect(suggestions.every(part => !part.parentId && !part.attachmentApproved)).toBe(true);
  expect(suggestions.some(part => part.attachmentProposal!.type === 'hinge')).toBe(true);
  const chosen = suggestions.find(part => part.attachmentProposal!.type === 'hinge')!;
  const proposal = chosen.attachmentProposal!;
  const accepted = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'part.acceptAttachmentProposal', partId: chosen.id }] });
  expect(accepted.ok).toBe(true);
  const applied = session.snapshot().parts.find(part => part.id === chosen.id)!;
  expect(applied).toMatchObject({ parentId: torso, attachment: { type: 'hinge' }, attachmentApproved: true, pivot: proposal.pivot });
  const rejected = suggestions.find(part => part.id !== chosen.id)!;
  expect((await session.execute({ expectedRevision: session.revision, edits: [{ op: 'part.rejectAttachmentProposal', partId: rejected.id }] })).ok).toBe(true);
  await session.analyze();
  const regenerated = session.snapshot();
  expect(regenerated.parts.find(part => part.id === chosen.id)).toMatchObject({ parentId: torso, attachment: { type: 'hinge' }, attachmentApproved: true, pivot: proposal.pivot });
  expect(regenerated.parts.find(part => part.id === rejected.id)).toMatchObject({ attachmentProposalRejected: true });
  expect(regenerated.parts.find(part => part.id === rejected.id)?.attachmentProposal).toBeUndefined();
  const reopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(reopened.snapshot().parts.find(part => part.id === chosen.id)?.pivot).toEqual(proposal.pivot);
  const native = await reopened.exportHyde({ format: 'hyde' });
  const nativeChild = native.project.elements.find(element => element.id === native.mapping.partIds[chosen.id])!;
  expect(nativeChild.attachment?.type).toBe('hinge');
  expect(native.project.elements.every(element => element.tracks.length === 0 && !element.assemblyClips?.length && !element.motionBehaviors?.length)).toBe(true);
  if (process.env.HYDE_TEST_BROWSER) {
    const frame = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width: fixture.image.width, height: fixture.image.height, format: 'png' } });
    const quality = compareNativeRender(fixture.image, frame.bytes, reopened.snapshot());
    expect(quality.silhouette.iou).toBeGreaterThan(.95);
    expect(quality.color.meanAbsoluteSrgbChannelError!).toBeLessThan(.05);
  }
  await reopened.close();
  await session.close();
}, 30_000);
