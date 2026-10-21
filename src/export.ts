import { zipSync, strToU8 } from 'fflate';
import type { Project } from './model';
import { downloadBlob } from './storage';
import {preparePortableAudio} from './portableAudio';

function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function asDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Media could not be embedded.'));
    reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime || 'application/octet-stream' }));
  });
}

export async function exportWeb(project: Project) {
  project=await preparePortableAudio(project);
  const base = new URL(import.meta.env.BASE_URL,location.href);
  const response = await fetch(new URL('build-manifest.json',base));
  if(!response.ok || !(response.headers.get('content-type')??'').includes('json')) throw new Error('Web export is available in the production preview. Run npm run build, then npm run preview.');
  const manifest = await response.json() as Record<string,{file:string;imports?:string[];dynamicImports?:string[];css?:string[];assets?:string[]}>;
  const files = new Set<string>(); const visited = new Set<string>();
  function collect(key:string) {if(visited.has(key))return;visited.add(key);const e=manifest[key];if(!e)return;files.add(e.file);for(const f of [...e.css??[],...e.assets??[]])files.add(f);for(const c of [...e.imports??[],...e.dynamicImports??[]])collect(c);}
  collect('player.html');
  files.add('licenses/JetBrains-Mono.txt');
  if(!files.size) throw new Error('Standalone player build is missing. Rebuild Hyde before exporting.');
  const entries:Record<string,Uint8Array>={};
  for(const f of files) {const r=await fetch(new URL(f,base));if(!r.ok)throw new Error(`Missing player file: ${f}`);entries[f]=new Uint8Array(await r.arrayBuffer());}
  const [playerJs, playerCss] = await Promise.all(['portable/player.js', 'portable/player.css'].map(async path => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`Missing portable player file: ${path}. Rebuild Hyde before exporting.`);
    return response.text();
  }));
  const packed=structuredClone(project);
  const embedded=structuredClone(project);
  for(let i=0;i<packed.assets.length;i++){
    const a=packed.assets[i];const r=await fetch(a.dataUrl);if(!r.ok)throw new Error(`Cannot package ${a.name}`);
    const bytes=new Uint8Array(await r.arrayBuffer());
    const ext=a.name.split('.').pop()?.replace(/[^a-z0-9]/gi,'') || 'bin';
    const path=`media/${a.id}.${ext}`;entries[path]=bytes;a.dataUrl=`./${path}`;
    embedded.assets[i].dataUrl=await asDataUrl(bytes,a.mime);
    if(a.kind==='font'&&a.licenseNotice?.trim())entries[`licenses/fonts/${a.id}.txt`]=strToU8(a.licenseNotice);
  }
  const serialized=JSON.stringify(embedded).replace(/</g,'\\u003c');
  entries['index.html']=strToU8(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${htmlText(project.name)} · Hyde</title><style>${playerCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script id="hyde-story" type="application/json">${serialized}</script><script>${inlineScript(playerJs)}</script></body></html>`);
  entries['story.json']=strToU8(JSON.stringify(packed));
  entries['README.txt']=strToU8('Open index.html directly in a current browser, or upload it to any static web host. The player, fonts, and story are embedded in that file, so no server or connection to Hyde is required. Other packaged files are included for separate static-hosted access to the story data and media. Notices for imported fonts, when supplied, are in licenses/fonts/.');
  downloadBlob(new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>],{type:'application/zip'}),`${project.name.replace(/[^a-z0-9 _-]/gi,'')||'story'}-web.zip`);
}
