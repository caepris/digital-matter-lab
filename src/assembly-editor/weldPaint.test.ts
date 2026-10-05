import { describe, expect, it } from 'vitest';
import { addPart, emptyDocument, replaceWelds, type AssemblyPart } from './AssemblyDocument';
import { brushWelds, createLayeredExampleDocument, eraseWeldsNear } from './weldPaint';

function sheet(id: string, position: [number, number, number]): AssemblyPart {
  return {
    id,
    label: id,
    kind: 'shell',
    presetId: 'loose-cloth',
    position,
    quaternion: [0, 0, 0, 1],
    uniformScale: 0.8,
  };
}

function unwelded() {
  return replaceWelds(createLayeredExampleDocument(), []);
}

describe('weld brush', () => {
  it('welds the hidden interface under the brush from a visible face', () => {
    const { document, contacts } = brushWelds(unwelded(), 'gel-core', [0, 0.72, 0.25], null);
    expect(contacts).toBeGreaterThan(0);
    expect(document.welds.length).toBeGreaterThan(0);
    expect(document.welds.every((weld) => weld.partA === 'gel-core' && weld.partB === 'rigid-base')).toBe(true);
  });

  it('reports no contacts away from any touching surface', () => {
    const { document, contacts } = brushWelds(unwelded(), 'gel-core', [0, 0.95, 0.25], null);
    expect(contacts).toBe(0);
    expect(document.welds).toHaveLength(0);
  });

  it('limits welding to the selected pair', () => {
    const top: [number, number, number] = [0, 1.2, 0];
    expect(brushWelds(unwelded(), 'gel-core', top, ['gel-core', 'rigid-base']).contacts).toBe(0);
    const open = brushWelds(unwelded(), 'gel-core', top, null);
    expect(open.document.welds.some((weld) => weld.partB === 'cloth-skin')).toBe(true);
  });

  it('welds two sheets that meet only along an edge', () => {
    const left = sheet('left', [-0.4, 0, 0]);
    const right = sheet('right', [0.4, 0, 0]);
    const touching = addPart(addPart(emptyDocument(), left), right);
    const welded = brushWelds(touching, 'left', [0, 0, 0], null);
    expect(welded.contacts).toBeGreaterThan(0);
    expect(welded.document.welds.length).toBeGreaterThan(0);
    expect(welded.document.welds.every((weld) => weld.partA === 'left' && weld.partB === 'right')).toBe(true);

    const separated = addPart(addPart(emptyDocument(), left), sheet('right', [0.46, 0, 0]));
    expect(brushWelds(separated, 'left', [0.03, 0, 0], null).contacts).toBe(0);
  });

  it('does not duplicate welds when brushing the same spot twice', () => {
    const once = brushWelds(unwelded(), 'gel-core', [0, 0.72, 0.25], null).document;
    const twice = brushWelds(once, 'gel-core', [0, 0.72, 0.25], null).document;
    expect(twice.welds).toHaveLength(once.welds.length);
    const erased = eraseWeldsNear(twice, [0, 0.7, 0.2], 0.2);
    expect(erased.welds.length).toBeLessThan(twice.welds.length);
  });
});
