import {describe,expect,it} from 'vitest';
import {DEFAULT_MEDIA_TRANSFORM,mediaPlanePoint,mediaPlaneRect} from './mediaTransform';
import {buildProjectivePinMesh,DEFAULT_PIN_CORNERS} from './projectivePin';

describe('independent media placement',()=>{
  it('uses the same fitted plane for ordinary media and corner-pinned media',()=>{
    expect(mediaPlaneRect('stretch',200,100,100,100)).toEqual({x:0,y:0,width:200,height:100});
    expect(mediaPlaneRect('fit',200,100,100,100)).toEqual({x:50,y:0,width:100,height:100});
    expect(mediaPlaneRect('fill',200,100,100,100)).toEqual({x:0,y:-50,width:200,height:200});
    expect(mediaPlanePoint({x:100,y:50},200,100,DEFAULT_MEDIA_TRANSFORM)).toEqual({x:100,y:50});
  });
  it('pans, scales and rotates source pixels while its shape/corner mask stays fixed',()=>{
    const plane=mediaPlaneRect('stretch',200,100,100,100)!;
    const transform={x:20,y:-10,scaleX:1.5,scaleY:.5,rotation:90};
    const point=mediaPlanePoint({x:plane.x,y:plane.y},200,100,transform);
    expect(point.x).toBeCloseTo(145);
    expect(point.y).toBeCloseTo(-110);
    const mesh=buildProjectivePinMesh(DEFAULT_PIN_CORNERS,200,100,{
      subdivisions:1,contentRect:{x:0,y:0,width:1,height:1},
      mediaTransform:transform,
    })!;
    expect(mesh.positions[0]).toBeCloseTo(point.x);
    expect(mesh.positions[1]).toBeCloseTo(point.y);
    expect([...mesh.uvs]).toEqual([0,0,1,0,0,1,1,1]);
    // The source rectangle can extend outside the pinned shape for Fill.
    const fill=mediaPlaneRect('fill',200,100,100,100)!;
    const fillMesh=buildProjectivePinMesh(DEFAULT_PIN_CORNERS,200,100,{
      subdivisions:1,contentRect:{x:fill.x/200,y:fill.y/100,width:fill.width/200,height:fill.height/100},
    })!;
    expect([...fillMesh.positions.slice(0,2)]).toEqual([0,-50]);
  });
});
