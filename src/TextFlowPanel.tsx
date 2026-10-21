import {sceneIdAt,type Project,type StoryElement} from './model';

const FLOW_SHAPES = new Set(['rectangle','ellipse','polygon','image','video']);

export function TextFlowPanel({project,element,onChange,onRefresh}:{
  project:Project;
  element:StoryElement;
  onChange:(patch:Partial<Pick<StoryElement,'flowAroundId'|'textShapeMode'>>)=>void;
  onRefresh:()=>void;
}){
  const sceneId=element.sceneId??sceneIdAt(project,element.start);
  const shapes=project.elements.filter(candidate=>
    FLOW_SHAPES.has(candidate.kind)&&
    (candidate.sceneId??sceneIdAt(project,candidate.start))===sceneId,
  );
  return <section className="inspector-section text-flow-panel">
    <h3>Text & shape</h3>
    <label className="select-label">Shape target
      <select aria-label="Text shape target" value={element.flowAroundId??''} onChange={event=>onChange({flowAroundId:event.target.value||undefined})}>
        <option value="">None</option>
        {shapes.map(shape=><option key={shape.id} value={shape.id}>{shape.name}</option>)}
      </select>
    </label>
    <label className="select-label">Layout
      <select aria-label="Text shape mode" value={element.textShapeMode??'around'} onChange={event=>onChange({textShapeMode:event.target.value as StoryElement['textShapeMode']})}>
        <option value="around">Flow around</option><option value="inside">Flow inside</option><option value="clip">Clip text to shape</option>
      </select>
    </label>
    <p className="muted-note">{element.textShapeMode==='inside'?'Words follow the space inside the shape.':element.textShapeMode==='clip'?'The shape hides text outside its boundary.':'Text wraps beside the shape where they overlap.'}</p>
    {element.textLayout==='static'&&element.flowAroundId&&(element.textShapeMode??'around')!=='clip'&&<>
      <p className="muted-note">{element.staticTextFlow?`Layout captured at ${element.staticTextFlow.capturedAt.toFixed(2)} s. Shape changes will not move these words.`:'Layout has not been captured yet.'}</p>
      <button className="secondary full" type="button" onClick={onRefresh}>Refresh static layout at playhead</button>
    </>}
  </section>;
}
