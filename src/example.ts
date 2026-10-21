import { createElement, createProject, type Keyframe, type Project, type StoryElement } from './model';

function key(time: number, value: number, overrides: Partial<Keyframe> = {}): Keyframe {
  return { id: crypto.randomUUID(), time, value, easing: 'cubic', direction: 'inOut', mode: 'smooth', ...overrides };
}

/** A self-contained story designed to demonstrate assembly anchors and reversible seeking. */
export function createExampleProject(): Project {
  const project = createProject('Box opening');
  // The compact secondary example keeps its original composition when new
  // projects use a larger default stage.
  project.width = 960;
  project.height = 540;
  project.background = '#d9dde3';
  project.sequences[0].name = '01 · Box opening';
  const shadow = { enabled: true, color: '#1f2933', blur: 16, x: 6, y: 9 };
  const make = (kind: StoryElement['kind'], values: Partial<StoryElement>) => createElement(kind, { duration: 8, ...values });
  const paperId = 'sample-paper';
  const paper = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#ff8a00"/><path d="M0 18H480M0 75H480M0 132H480M0 189H480M0 246H480M0 303H480M26 0V360M107 0V360M188 0V360M269 0V360M350 0V360M431 0V360" stroke="#5c6670" stroke-opacity=".09"/><path d="M0 43 480 39M0 167 480 172M0 288 480 282" stroke="#ffc857" stroke-opacity=".22" stroke-width="3"/></svg>';
  project.assets.push({ id: paperId, name: 'Warm paper.svg', mime: 'image/svg+xml', kind: 'image', dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(paper)}` });

  const body = make('rectangle', { id: 'box-body', name: 'Paper Box · body', x: 674, y: 342, width: 238, height: 140, fill: '#ff8a00', assetId: paperId, stroke: '#5c6670', strokeWidth: 2, shadow, section: 'Paper Box' });
  const lid = make('rectangle', { id: 'box-lid', name: 'Paper Box · hinged lid', x: -119, y: -70, width: 250, height: 22, pivotX: 0, pivotY: .5, fill: '#ffc857', stroke: '#5c6670', strokeWidth: 2, shadow: { ...shadow, blur: 7, y: 3 }, attachment: { type: 'hinge', parentId: body.id, min: -110, max: 0 }, section: 'Paper Box', tracks: [{ property: 'rotation', keyframes: [key(0, 0), key(1.2, 0), key(2.6, -105), key(3, -90), key(5.5, -90), key(7, 0), key(8, 0)] }] });

  const star = make('polygon', { id: 'wonder-star', name: 'A small surprise', x: 674, y: 310, width: 80, height: 80, fill: '#ffc857', stroke: '#5c6670', strokeWidth: 1, points: [{ x: 40, y: 0 }, { x: 49, y: 27 }, { x: 77, y: 25 }, { x: 56, y: 43 }, { x: 66, y: 71 }, { x: 40, y: 55 }, { x: 14, y: 71 }, { x: 24, y: 43 }, { x: 3, y: 25 }, { x: 31, y: 27 }], section: 'The surprise', tracks: [{ property: 'y', keyframes: [key(0, 330), key(1.8, 330), key(3.2, 185, { easing: 'sine' }), key(4.5, 167), key(5.4, 185), key(6.4, 330), key(8, 330)] }, { property: 'rotation', keyframes: [key(0, -18), key(3.3, 12), key(5.4, -8), key(8, -18)] }] });

  project.elements = [
    make('ellipse', { name: 'Slate circle', x: 708, y: 273, width: 370, height: 370, fill: '#bac2cc', section: 'Backdrop', optimize: 'static' }),
    make('ellipse', { name: 'Ground shadow', x: 683, y: 418, width: 310, height: 24, fill: '#5c6670', opacity: .65, section: 'Backdrop', optimize: 'static' }),
    make('text', { name: 'Chapter number', x: 76, y: 70, width: 330, height: 24, pivotX: 0, pivotY: 0, text: 'EXAMPLE  /  01', fontFamily: 'Arial', fontSize: 12, fill: '#5c6670', section: 'Typography', optimize: 'static' }),
    make('text', { name: 'Story title', x: 72, y: 132, width: 440, height: 225, pivotX: 0, pivotY: 0, text: 'Box\nopening', fontFamily: 'JetBrains Mono', fontSize: 54, fill: '#1f2933', section: 'Typography', optimize: 'static' }),
    make('rectangle', { name: 'Title rule', x: 77, y: 323, width: 50, height: 3, pivotX: 0, fill: '#ff8a00', section: 'Typography', optimize: 'static' }),
    make('text', { name: 'Story subtitle', x: 76, y: 350, width: 375, height: 60, pivotX: 0, pivotY: 0, text: 'Press Play to preview.\nSelect a part to edit its properties.', fontFamily: 'Arial', fontSize: 17, fill: '#5c6670', section: 'Typography', optimize: 'static' }),
    star,
    body,
    make('rectangle', { name: 'Box top edge', x: 0, y: -62, width: 228, height: 7, fill: '#5c6670', parentId: body.id, section: 'Paper Box', optimize: 'static' }),
    make('rectangle', { name: 'Paper tape', x: 2, y: 0, width: 35, height: 137, fill: '#ffc857', opacity: .65, parentId: body.id, section: 'Paper Box', optimize: 'static' }),
    lid,
    make('ellipse', { name: 'Hinge pin', x: -119, y: -70, width: 10, height: 10, fill: '#1f2933', parentId: body.id, section: 'Paper Box', optimize: 'static' }),
    make('ellipse', { name: 'Small orange dot', x: 871, y: 103, width: 15, height: 15, fill: '#ff8a00', section: 'Backdrop', optimize: 'static' }),
  ];
  project.captions = [{ id: 'sample-caption', start: 2.5, end: 5.6, text: 'The lid opens and a star rises from the box.' }];
  return project;
}
