import { deflateSync } from 'node:zlib';
import { HydeSDK } from '../src/sdk';
import type { HydeCommand, HydeSession } from '../src/sdk';

function pngChunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(payload.length + 8);
  result.writeUInt32BE(data.length, 0);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

/** Small patterned RGBA texture with real PNG chunks, generated offline. */
function patternedPng(): Uint8Array {
  const width = 32, height = 32;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      const bright = ((x >> 2) + (y >> 2)) % 2 === 0;
      pixels[offset] = bright ? 253 : 31;
      pixels[offset + 1] = bright ? 202 : 141;
      pixels[offset + 2] = bright ? 87 : 166;
      pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Three seconds of quiet 16-bit mono PCM, long enough for both scenes. */
function toneWav(): Uint8Array {
  const sampleRate = 8000, samples = sampleRate * 3;
  const result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8, 'ascii');
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36, 'ascii');
  result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const fade = Math.min(1, index / 500, (samples - index - 1) / 500);
    result.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / sampleRate) * 3000 * fade), 44 + index * 2);
  }
  return result;
}

export interface SDKAcceptanceStory {
  sdk: HydeSDK;
  session: HydeSession;
  sceneIds: [string, string];
  ids: Record<string, string>;
  bytes: Uint8Array;
}

/** Public-SDK fixture: native texture, shape/text masks, camera, motion, captions, audio and articulated assembly. */
export async function makeSDKAcceptanceStory(): Promise<SDKAcceptanceStory> {
  const sdk = new HydeSDK();
  const session = await sdk.createProject({ name: 'SDK acceptance story', width: 640, height: 360, fps: 30, duration: 6, background: '#14233d' });
  const first = session.snapshot().sequences[0].id;
  const imageHandle = session.stageAsset(patternedPng(), 'image/png', 'image');
  const audioHandle = session.stageAsset(toneWav(), 'audio/wav', 'audio');
  const commands: HydeCommand[] = [
    { op: 'scene.retime', args: { id: first, duration: 3 } },
    { op: 'scene.rename', args: { id: first, name: 'Luminous island' } },
    { op: 'scene.create', args: { alias: '$scene2', name: 'Quiet cove', start: 3, duration: 3 } },
    { op: 'asset.add', args: { alias: '$texture', handle: imageHandle, name: 'checker.png' } },
    { op: 'asset.add', args: { alias: '$tone', handle: audioHandle, name: 'tone.wav' } },
    { op: 'element.create', args: { alias: '$assembly', kind: 'group', sceneId: first, properties: { name: 'Lantern assembly', x: 290, y: 170, width: 220, height: 180, start: 0, duration: 3 } } },
    { op: 'element.create', args: { alias: '$island', kind: 'polygon', sceneId: first, properties: { name: 'Textured island', x: 0, y: 0, width: 180, height: 125, fill: '#ffd377', start: 0, duration: 3 } } },
    { op: 'shape.setPath', args: { id: '$island', path: { points: [
      { x: 0.03, y: 0.4 }, { x: 0.32, y: 0.05, out: { x: 0.46, y: 0.02 } },
      { x: 0.87, y: 0.17 }, { x: 0.98, y: 0.68 },
      { x: 0.64, y: 0.95 }, { x: 0.11, y: 0.83 },
    ] } } },
    { op: 'media.setFill', args: { id: '$island', assetId: '$texture', fit: 'fill' } },
    { op: 'assembly.attach', args: { id: '$island', parentId: '$assembly', type: 'fixed' } },
    { op: 'element.create', args: { alias: '$beam', kind: 'ellipse', sceneId: first, properties: { name: 'Hinged beam', x: 50, y: -22, width: 75, height: 28, fill: '#fff0ba', start: 0, duration: 3 } } },
    { op: 'assembly.attach', args: { id: '$beam', parentId: '$assembly', type: 'hinge', min: -25, max: 25 } },
    { op: 'keyframe.upsert', args: { elementId: '$beam', property: 'rotation', timeSeconds: 0, value: -15 } },
    { op: 'keyframe.upsert', args: { elementId: '$beam', property: 'rotation', timeSeconds: 2, value: 15 } },
    { op: 'element.create', args: { alias: '$title', kind: 'text', sceneId: first, properties: { name: 'Island title', x: 100, y: 220, width: 440, height: 90, text: 'Light over water', fontFamily: 'Inter', fontSize: 38, fill: '#ffffff', start: 0, duration: 3 } } },
    { op: 'element.setTextMaskTarget', args: { id: '$title', targetId: '$island', mode: 'clip' } },
    { op: 'text.setAnimation', args: { id: '$title', animation: { unit: 'word', effect: 'reveal', direction: 'in', start: 0, duration: 0.3, stagger: 0.18, easing: 'sine', easingDirection: 'inOut', distance: 20, seed: 7, amplitude: 0, frequency: 1 } } },
    { op: 'keyframe.upsert', args: { elementId: '$title', property: 'x', timeSeconds: 0, value: 100 } },
    { op: 'keyframe.upsert', args: { elementId: '$title', property: 'x', timeSeconds: 2, value: 150 } },
    { op: 'scene.setCamera', args: { sceneId: first, camera: { x: 320, y: 180, zoom: 1 } } },
    { op: 'camera.upsertKeyframe', args: { sceneId: first, property: 'zoom', timeSeconds: 2, value: 1.12 } },
    { op: 'caption.create', args: { alias: '$caption1', sceneId: first, text: 'The island awakens.', start: 0.2, end: 2.7 } },
    { op: 'element.create', args: { alias: '$audio', kind: 'audio', sceneId: first, properties: { name: 'Ambient tone', assetId: '$tone', start: 0, duration: 3 } } },
    { op: 'audio.setMix', args: { id: '$audio', volume: 0.35, fadeIn: 0.2, fadeOut: 0.2 } },
    { op: 'element.create', args: { alias: '$moon', kind: 'ellipse', sceneId: '$scene2', properties: { name: 'Moon', x: 430, y: 110, width: 100, height: 100, fill: '#fce19a', start: 3, duration: 3 } } },
    { op: 'scene.setCamera', args: { sceneId: '$scene2', camera: { x: 320, y: 180, zoom: 1.05 } } },
    { op: 'caption.create', args: { alias: '$caption2', sceneId: '$scene2', text: 'Night settles in.', start: 3.2, end: 5.8 } },
  ];
  const dryRun = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands, dryRun: true });
  if (!dryRun.ok) throw new Error(`Fixture dry-run failed: ${JSON.stringify(dryRun.errors)}`);
  if (session.revision !== 0) throw new Error('Fixture dry-run changed the session revision.');
  const result = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands });
  if (!result.ok) throw new Error(`Fixture commit failed: ${JSON.stringify(result.errors)}`);
  return { sdk, session, sceneIds: [first, result.idMap.$scene2], ids: result.idMap, bytes: await session.exportProject() };
}
