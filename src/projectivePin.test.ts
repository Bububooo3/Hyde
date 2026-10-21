import {describe,expect,it} from 'vitest';
import {buildProjectivePinMesh,DEFAULT_PIN_CORNERS,mediaPinRects,projectivePinPoint,validPinCorners} from './projectivePin';

describe('projective media pins',()=>{
  it('maps the source rectangle onto an editable convex quadrilateral',()=>{
    const corners=[{x:0,y:0},{x:1,y:.1},{x:.8,y:1},{x:.1,y:.9}] as const;
    expect(validPinCorners(corners)).toBe(true);
    const mesh=buildProjectivePinMesh(corners,200,100,{subdivisions:2})!;
    expect(mesh.positions.length).toBe(18);
    expect(mesh.indices.length).toBe(24);
    expect([...mesh.positions.slice(0,2)]).toEqual([0,0]);
    expect(mesh.positions[4]).toBeCloseTo(200);
    expect(mesh.positions[5]).toBeCloseTo(10);
    expect(mesh.positions[16]).toBeCloseTo(160);
    expect(mesh.positions[17]).toBeCloseTo(100);
    expect(projectivePinPoint(corners,1,1)).toEqual(corners[2]);
  });
  it('rejects self-intersections and collapsed geometry',()=>{
    expect(validPinCorners([{x:0,y:0},{x:1,y:1},{x:1,y:0},{x:0,y:1}])).toBe(false);
    expect(buildProjectivePinMesh([{x:0,y:0},{x:0,y:0},{x:1,y:1},{x:0,y:1}],100,100)).toBeNull();
  });
  it('keeps fit and fill mapping compatible with ordinary media placement',()=>{
    expect(mediaPinRects('stretch',200,100,100,100)).toEqual({contentRect:{x:0,y:0,width:1,height:1},uvRect:{x:0,y:0,width:1,height:1}});
    expect(mediaPinRects('fill',200,100,100,100)?.uvRect).toEqual({x:0,y:.25,width:1,height:.5});
    expect(mediaPinRects('fit',200,100,100,100)?.contentRect).toEqual({x:.25,y:0,width:.5,height:1});
    expect(buildProjectivePinMesh(DEFAULT_PIN_CORNERS,200,100,{...mediaPinRects('fill',200,100,100,100)!,subdivisions:1})?.uvs[1]).toBeCloseTo(.25);
  });
});
