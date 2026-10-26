// @vitest-environment node
import { expect, it } from 'vitest';
import { HydeSDK, HYDE_OPERATIONS } from './sdk';

it('exposes Boolean paths and shadow size through SDK transactions and archives', async () => {
  const sdk = new HydeSDK(), session = await sdk.createProject({ name: 'Boolean SDK' });
  expect(HYDE_OPERATIONS).toContain('shape.boolean');
  const made = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
    { op: 'element.create', args: { id: 'outer', kind: 'rectangle', properties: { x: 200, y: 200, width: 180, height: 180 } } },
    { op: 'element.create', args: { id: 'inner', kind: 'rectangle', properties: { x: 200, y: 200, width: 70, height: 70 } } },
    { op: 'element.updateAppearance', args: { id: 'outer', appearance: { shadow: { color: '#000000', x: 15, y: 20, size: 25, blur: 8, enabled: true } } } },
    { op: 'shape.boolean', args: { ids: ['outer', 'inner'], operation: 'negate', timeSeconds: 0 } },
  ] });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  const result = session.snapshot().elements.find(element => element.name.startsWith('Negate'))!;
  expect(result.shapePath?.holes).toHaveLength(1);
  expect(session.snapshot().elements.find(element => element.id === 'outer')?.shadow.size).toBe(25);
  const reopened = await sdk.openProject(await session.exportProject());
  expect(reopened.snapshot().elements.find(element => element.id === result.id)?.shapePath?.holes).toHaveLength(1);
  expect(reopened.snapshot().elements.find(element => element.id === result.id)?.shadow.size).toBe(25);
});

it('keeps disjoint Union geometry in one SDK object through archive reopen',async()=>{
  const sdk=new HydeSDK(),session=await sdk.createProject({name:'Disjoint Union'});
  const made=await session.execute({protocolVersion:1,expectedRevision:0,commands:[
    {op:'element.create',args:{id:'left',kind:'rectangle',properties:{x:100,y:100,width:50,height:50}}},
    {op:'element.create',args:{id:'right',kind:'rectangle',properties:{x:300,y:100,width:50,height:50}}},
    {op:'shape.boolean',args:{ids:['left','right'],operation:'union',timeSeconds:0}},
  ]});
  expect(made.ok,JSON.stringify(made)).toBe(true);
  const results=session.snapshot().elements.filter(element=>element.name.startsWith('Union'));
  expect(results).toHaveLength(1);
  expect(results[0].shapePath?.islands).toHaveLength(1);
  const reopened=await sdk.openProject(await session.exportProject());
  expect(reopened.snapshot().elements.find(element=>element.id===results[0].id)?.shapePath?.islands).toHaveLength(1);
});
