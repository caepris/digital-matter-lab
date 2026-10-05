import { describe, expect, it } from 'vitest';
import { replaceWelds } from '../../assembly-editor/AssemblyDocument';
import { createLayeredExampleDocument } from '../../assembly-editor/weldPaint';
import { AssemblyEditorController } from './AssemblyEditorController';

describe('AssemblyEditorController X-ray welding', () => {
  it('reaches the buried base-to-gel seam through the cloth and gel when that pair is selected', () => {
    const controller = new AssemblyEditorController(replaceWelds(createLayeredExampleDocument(), []));
    controller.select(['rigid-base', 'gel-core'], false);
    // Surfaces a downward ray at the stack's centre passes through, nearest first.
    expect(controller.canPaint('cloth-skin', [0, 1.2, 0.1])).toBe(false);
    expect(controller.canPaint('gel-core', [0, 1.2, 0.1])).toBe(false);
    expect(controller.canPaint('rigid-base', [0, 0.7, 0.1])).toBe(true);

    controller.beginStroke();
    controller.paint('rigid-base', [0, 0.7, 0.1]);
    controller.endStroke();
    const welds = controller.document.welds;
    expect(welds.length).toBeGreaterThan(0);
    expect(welds.every((weld) => new Set([weld.partA, weld.partB]).has('gel-core'))).toBe(true);
    expect(welds.every((weld) => new Set([weld.partA, weld.partB]).has('rigid-base'))).toBe(true);
    expect(controller.canErase([0, 0.7, 0.1])).toBe(true);
    expect(controller.canErase([0, 1.2, 0.1])).toBe(false);
  });

  it('does not weld a part outside the selected pair', () => {
    const controller = new AssemblyEditorController(replaceWelds(createLayeredExampleDocument(), []));
    controller.select(['rigid-base', 'gel-core'], false);
    controller.beginStroke();
    controller.paint('cloth-skin', [0, 1.2, 0.1]);
    controller.endStroke();
    expect(controller.document.welds).toHaveLength(0);
  });
});
