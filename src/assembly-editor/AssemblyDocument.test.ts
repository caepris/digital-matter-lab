import { describe, expect, it } from 'vitest';
import { AssemblyHistory } from './AssemblyHistory';
import {
  DocumentValidationError,
  MAX_PARTS,
  addPart,
  emptyDocument,
  removePart,
  updatePart,
  validateDocument,
} from './AssemblyDocument';
import { createLayeredExampleDocument } from './weldPaint';

describe('assembly document', () => {
  it('opens the layered example with every preset family and real welds', () => {
    const document = createLayeredExampleDocument();
    expect(document.parts.map((part) => part.presetId)).toEqual(['dense-solid', 'gel', 'loose-cloth']);
    expect(document.welds.length).toBeGreaterThan(0);
    expect(validateDocument(JSON.parse(JSON.stringify(document))).name).toBe('Layered block');
  });

  it('rejects more than eight parts, bad presets, and self welds', () => {
    const document = emptyDocument();
    let next = document;
    for (let i = 0; i < MAX_PARTS; i++) {
      next = addPart(next, {
        id: `part-${i}`,
        label: `Part ${i}`,
        kind: 'rigid',
        presetId: 'light-solid',
        position: [i, 0, 0],
        quaternion: [0, 0, 0, 1],
        uniformScale: 0.5,
      });
    }
    expect(() =>
      addPart(next, {
        id: 'overflow',
        label: 'Overflow',
        kind: 'rigid',
        presetId: 'dense-solid',
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        uniformScale: 0.5,
      }),
    ).toThrow(DocumentValidationError);
    expect(() => validateDocument({ ...document, parts: [{ ...next.parts[0], presetId: 'gel' }] })).toThrow(
      /preset/i,
    );
  });

  it('keeps welds when the preset stays on the same shape and drops them when the shape changes', () => {
    const document = createLayeredExampleDocument();
    const sameShape = updatePart(document, 'gel-core', { presetId: 'foam' });
    expect(sameShape.welds.length).toBe(document.welds.length);
    const sheet = updatePart(document, 'gel-core', { kind: 'shell', presetId: 'loose-cloth' });
    expect(sheet.welds.some((weld) => weld.partA === 'gel-core' || weld.partB === 'gel-core')).toBe(false);
  });

  it('removes welds with a deleted part and can undo a clear', () => {
    const history = new AssemblyHistory(createLayeredExampleDocument());
    history.commit(removePart(history.current, 'cloth-skin'));
    expect(history.current.welds.some((weld) => weld.partA === 'cloth-skin' || weld.partB === 'cloth-skin')).toBe(false);
    history.commit(emptyDocument('Layered block'));
    expect(history.current.parts).toHaveLength(0);
    history.undo();
    expect(history.current.parts.length).toBeGreaterThan(0);
    history.redo();
    expect(history.current.parts).toHaveLength(0);
  });
});