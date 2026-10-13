import { expect, test, type Locator, type Page } from '@playwright/test';

type Stats = {
  impactorCount: number;
  pressBottom: number;
  pressActive: boolean;
  grabbing: boolean;
  maxDeformation: number;
  center: [number, number, number];
};

const KINDS = ['rigid', 'volume', 'shell'] as const;
const ALL_KINDS = [...KINDS, 'assembly', 'conversion'] as const;

async function stats(page: Page, index: number): Promise<Stats> {
  return page.evaluate((i) => window.__digitalMatterLab!.panels[i].stats(), index);
}

async function bodyPoint(page: Page, index: number): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => window.__digitalMatterLab!.panels[i].bodyScreenPoint(), index);
}

function panel(page: Page, index: number): Locator {
  return page.locator('.panel').nth(index);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__digitalMatterLab?.ready === true);
  await page.waitForFunction(() => window.__digitalMatterLab!.panels[0].frameCount() > 10);
  expect(errors).toEqual([]);
});

test('loads comparison, assembly, conversion, and creator workflow workspaces', async ({ page }) => {
  await expect(page.locator('.panel')).toHaveCount(8);
  const kinds = await page.evaluate(() => window.__digitalMatterLab!.panels.map((p) => p.kind));
  expect(kinds).toEqual([...ALL_KINDS]);
  await expect(page.getByRole('heading', { name: 'Rigid volume' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Deformable volume' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thin deformable shell' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Assembly editor' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Thin mesh conversion' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Creator authoring paths' })).toBeHidden();
});

for (const [index, kind] of KINDS.entries()) {
  test(`${kind}: drop, grab, press, overlay, preset, and reset`, async ({ page }) => {
    const controls = panel(page, index);

    await controls.locator('[data-tool=drop]').click();
    const target = await bodyPoint(page, index);
    await page.mouse.click(target.x, target.y - 30);
    await expect.poll(async () => (await stats(page, index)).impactorCount).toBe(1);
    // Interactions stay local to their own panel.
    for (const other of [0, 1, 2].filter((i) => i !== index)) {
      expect((await stats(page, other)).impactorCount).toBe(0);
    }

    await controls.locator('[data-tool=grab]').click();
    const grabPoint = await bodyPoint(page, index);
    await page.mouse.move(grabPoint.x, grabPoint.y);
    await page.mouse.down();
    await page.mouse.move(grabPoint.x, grabPoint.y - 80, { steps: 8 });
    await expect.poll(async () => (await stats(page, index)).grabbing).toBe(true);
    await page.mouse.up();
    await expect.poll(async () => (await stats(page, index)).grabbing).toBe(false);

    // Start the press from a clean scene; the rigid cube may have landed on the earlier ball.
    await controls.getByTestId('reset').click();
    await controls.locator('[data-tool=press]').click();
    const restBottom = (await stats(page, index)).pressBottom;
    const pressPoint = await bodyPoint(page, index);
    await page.mouse.move(pressPoint.x, pressPoint.y);
    await page.mouse.down();
    await expect.poll(async () => (await stats(page, index)).pressBottom).toBeLessThan(restBottom - 0.2);
    await page.mouse.up();
    await expect.poll(async () => (await stats(page, index)).pressActive).toBe(false);

    const toggle = controls.getByTestId('structure-toggle');
    await toggle.check();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();

    const select = controls.getByTestId('preset-select');
    const options = await select.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value),
    );
    await select.selectOption(options[1]);
    await expect(select).toHaveValue(options[1]);
    expect((await stats(page, index)).impactorCount).toBe(0);

    await controls.locator('[data-tool=drop]').click();
    const again = await bodyPoint(page, index);
    await page.mouse.click(again.x, again.y - 30);
    await expect.poll(async () => (await stats(page, index)).impactorCount).toBe(1);
    await controls.getByTestId('reset').click();
    const after = await stats(page, index);
    expect(after.impactorCount).toBe(0);
    expect(after.grabbing).toBe(false);
    expect(after.center.every(Number.isFinite)).toBe(true);
  });
}

test('assembly tab exposes a welded mixed-material workspace', async ({ page }) => {
  const comparisonTab = page.getByRole('tab', { name: 'Comparison' });
  const assemblyTab = page.getByRole('tab', { name: 'Assembly' });
  await comparisonTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(assemblyTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Assembly editor' })).toBeVisible();
  expect(await page.evaluate(() => window.__digitalMatterLab!.activeWorkspace())).toBe('assembly');

  const controls = page.locator('[data-kind=assembly]');
  await controls.getByRole('radio', { name: 'Simulate' }).click();
  await expect(controls.getByTestId('simulation-play')).toHaveText('Play');
  await controls.getByTestId('simulation-play').click();
  await expect(controls.getByTestId('simulation-play')).toHaveText('Pause');
  const index = 3;
  const toggle = controls.getByTestId('structure-toggle');
  await toggle.check();
  await expect(controls.locator('.structure-legend')).toBeVisible();
  const legend = controls.locator('.structure-legend');
  await expect(legend).toContainText('Vertices');
  await expect(legend).toContainText(/Rigid base ↔ Gel core|Gel core ↔ Rigid base/);
  await expect(legend).toContainText(/Gel core ↔ Cloth skin|Cloth skin ↔ Gel core/);

  const viewport = controls.locator('.assembly-viewport');
  const cameraBefore = await page.evaluate(() => window.__digitalMatterLab!.assembly.cameraPosition());
  const simulationViewport = await viewport.boundingBox();
  if (!simulationViewport) throw new Error('Missing assembly simulation viewport');
  await page.mouse.move(
    simulationViewport.x + simulationViewport.width / 2,
    simulationViewport.y + simulationViewport.height / 2,
  );
  await page.mouse.wheel(0, -180);
  const cameraAfter = await page.evaluate(() => window.__digitalMatterLab!.assembly.cameraPosition());
  expect(cameraAfter[2]).not.toBeCloseTo(cameraBefore[2], 2);

  await controls.locator('[data-tool=drop]').click();
  const dropPoint = await bodyPoint(page, index);
  await page.mouse.click(dropPoint.x, dropPoint.y - 25);
  await expect.poll(async () => (await stats(page, index)).impactorCount).toBe(1);
  expect((await stats(page, 0)).impactorCount).toBe(0);

  await controls.getByTestId('reset').click();
  await controls.getByTestId('simulation-play').click();
  await controls.locator('[data-tool=grab]').click();
  const grabPoint = await bodyPoint(page, index);
  await page.mouse.move(grabPoint.x, grabPoint.y);
  await page.mouse.down();
  await page.mouse.move(grabPoint.x + 40, grabPoint.y - 90, { steps: 10 });
  await expect.poll(async () => (await stats(page, index)).grabbing).toBe(true);
  await page.mouse.up();

  await controls.getByTestId('reset').click();
  await controls.getByTestId('simulation-play').click();
  await controls.locator('[data-tool=press]').click();
  const restBottom = (await stats(page, index)).pressBottom;
  const pressPoint = await bodyPoint(page, index);
  await page.mouse.move(pressPoint.x, pressPoint.y);
  await page.mouse.down();
  await expect.poll(async () => (await stats(page, index)).pressBottom).toBeLessThan(restBottom - 0.2);

  // Switching workspaces must end an in-progress interaction and reroute input.
  await assemblyTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await stats(page, index)).pressActive).toBe(false);
  await expect(page.getByRole('heading', { name: 'Rigid volume' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Assembly editor' })).toBeHidden();
  expect(await page.evaluate(() => window.__digitalMatterLab!.activeWorkspace())).toBe('comparison');
});

test('thin conversion auto-generates, edits thickness live, and simulates every source', async ({ page }) => {
  await page.getByRole('tab', { name: 'Thin conversion' }).click();
  const workspace = page.locator('[data-kind=conversion]');
  await expect(workspace.getByRole('heading', { name: 'Thin mesh conversion' })).toBeVisible();
  expect(await page.evaluate(() => window.__digitalMatterLab!.activeWorkspace())).toBe('conversion');
  await expect(workspace.locator('[data-testid^=stage-], [data-testid^=continue-], [data-testid=generate-shell]')).toHaveCount(0);

  const vertexCount = () => page.evaluate(() => window.__digitalMatterLab!.conversion.simulationVertexCount());
  const renderedThickness = () => page.evaluate(() => window.__digitalMatterLab!.conversion.renderedThickness());

  const shellStats = workspace.getByTestId('conversion-stats');
  await expect(shellStats).toContainText('vertices');
  expect(await vertexCount()).toBeGreaterThan(3);
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.view())).toBe('shell');
  await expect(workspace.locator('[data-view=material]')).toBeDisabled();
  const firstSection = workspace.locator('.editor-section').first();
  await expect(firstSection.locator('[data-view=shell]')).toBeVisible();
  await expect(firstSection.getByTestId('section-tool')).toBeVisible();

  const structure = workspace.getByTestId('structure-toggle');
  await structure.check();
  await expect(structure).toBeChecked();

  const source = workspace.getByTestId('source-select');
  const play = workspace.getByTestId('simulation-play');
  const thickness = workspace.getByTestId('thickness');
  for (const id of ['curtain', 'car-shell', 'tshirt', 'denim-jacket']) {
    await source.selectOption(id);
    await expect
      .poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.sourceId()), { timeout: 10_000 })
      .toBe(id);
    await expect(shellStats).toContainText('vertices');
    expect(await vertexCount()).toBeGreaterThan(3);
    await expect(play).toBeEnabled();
  }
  expect(await vertexCount()).toBeGreaterThan(1_800);
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.generatedRegionColorCount())).toBe(2);

  await workspace.locator('[data-view=material]').click();
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.view())).toBe('material');
  const legend = workspace.locator('.structure-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Denim');
  await expect(legend).toContainText('Cotton hoodie');
  await workspace.locator('[data-view=shell]').click();

  await play.click();
  await expect(play).toHaveText('Pause');
  const index = 4;
  await expect.poll(async () => (await stats(page, index)).maxDeformation).toBeGreaterThan(0.001);
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.generatedRegionColorCount())).toBe(2);
  const vertices = await vertexCount();

  await thickness.fill('6');
  await expect(workspace.getByTestId('thickness-output')).toHaveText('6.0 cm');
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.thickness())).toBeCloseTo(0.06, 4);
  await expect.poll(renderedThickness).toBeCloseTo(0.06, 2);
  expect(await vertexCount()).toBe(vertices);
  await expect(play).toHaveText('Pause');
  const running = await stats(page, index);
  expect(running.maxDeformation).toBeGreaterThan(0.001);
  expect(running.center.every(Number.isFinite)).toBe(true);

  await workspace.getByTestId('section-tool').click();
  await expect(workspace.getByTestId('section-tool')).toHaveAttribute('aria-pressed', 'true');
  await play.click();
  await expect(play).toHaveText('Play');
  const before = await page.evaluate(() => window.__digitalMatterLab!.conversion.sectionPosition());
  const section = await bodyPoint(page, index);
  await page.mouse.move(section.x, section.y);
  await page.mouse.down();
  await page.mouse.move(section.x + 80, section.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.sectionPosition())).not.toBe(before);
  await workspace.locator('[data-view=source]').click();
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.view())).toBe('source');
  await expect(workspace.getByTestId('section-tool')).toHaveAttribute('aria-pressed', 'true');
  await expect(workspace.getByTestId('section-tool')).toBeEnabled();
  await workspace.locator('[data-view=shell]').click();
  await workspace.getByTestId('section-tool').click();

  await play.click();
  await workspace.locator('[data-tool=drop]').click();
  const target = await bodyPoint(page, index);
  await page.mouse.click(target.x, target.y - 30);
  await expect.poll(async () => (await stats(page, index)).impactorCount).toBe(1);
  await workspace.getByTestId('reset').click();
  expect((await stats(page, index)).impactorCount).toBe(0);
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.sourceId())).toBe('denim-jacket');
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.generatedRegionColorCount())).toBe(2);
  await expect(play).toHaveText('Pause');
  await play.click();
  await expect(play).toHaveText('Play');
  await workspace.getByTestId('reset').click();
  await expect(play).toHaveText('Play');

  await page.setViewportSize({ width: 600, height: 820 });
  await expect(workspace.getByRole('heading', { name: 'Thin mesh conversion' })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
});

test('thin conversion viewport orbits with a trackpad or middle-drag, zooms, and still takes tool clicks', async ({ page }) => {
  await page.getByRole('tab', { name: 'Thin conversion' }).click();
  const workspace = page.locator('[data-kind=conversion]');
  await expect(workspace.getByTestId('conversion-stats')).toContainText('vertices');
  const viewport = workspace.locator('.conversion-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Missing conversion viewport');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const camera = () => page.evaluate(() => window.__digitalMatterLab!.conversion.cameraPosition());
  const distanceToTarget = (p: number[]) => Math.hypot(...p);

  // Two-finger trackpad scroll orbits: the camera swings around without changing its distance much.
  await page.mouse.move(center.x, center.y);
  const beforeOrbit = await camera();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(14, 0);
  await expect.poll(async () => Math.abs((await camera())[0] - beforeOrbit[0])).toBeGreaterThan(0.2);
  const afterOrbit = await camera();
  expect(Math.hypot(...afterOrbit)).toBeCloseTo(Math.hypot(...beforeOrbit), 0);

  // A notched mouse wheel still zooms toward the jacket.
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => distanceToTarget(await camera())).toBeLessThan(distanceToTarget(afterOrbit) - 0.05);

  // Middle-drag orbits too.
  const beforeDrag = await camera();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(center.x + 120, center.y, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => Math.abs((await camera())[0] - beforeDrag[0])).toBeGreaterThan(0.1);

  // Left-click tools still reach the simulation through the viewport.
  const play = workspace.getByTestId('simulation-play');
  await play.click();
  await workspace.locator('[data-tool=drop]').click();
  const target = await bodyPoint(page, 4);
  await page.mouse.click(target.x, target.y - 30);
  await expect.poll(async () => (await stats(page, 4)).impactorCount).toBe(1);
});

test('thin conversion places and simulates an auto-welded rigid accessory', async ({ page }) => {
  await page.getByRole('tab', { name: 'Thin conversion' }).click();
  const workspace = page.locator('[data-kind=conversion]');
  await workspace.getByTestId('source-select').selectOption('car-shell');
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.sourceId())).toBe('car-shell');
  await expect(workspace.getByTestId('conversion-stats')).toContainText('vertices');

  const edit = workspace.getByTestId('rigid-weld-edit');
  await edit.click();
  await expect(edit).toHaveText('Done editing');
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.accessoryEditing())).toBe(true);
  await workspace.getByTestId('rigid-weld-preset').selectOption('plate');
  await workspace.getByTestId('rigid-weld-add').click();
  await expect(workspace.getByTestId('rigid-weld-cancel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(workspace.getByTestId('rigid-weld-cancel')).toBeHidden();
  await workspace.getByTestId('rigid-weld-add').click();
  const target = await bodyPoint(page, 4);
  await page.mouse.click(target.x, target.y);
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.rigidAccessoryCount())).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.rigidWeldCount())).toBeGreaterThan(0);
  await expect(workspace.getByTestId('rigid-weld-list')).toContainText('Plate 1');
  await expect(workspace.locator('[data-accessory-tool=move]')).toBeEnabled();

  const beforeSlide = await page.evaluate(() => window.__digitalMatterLab!.conversion.selectedAccessoryPosition());
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 45, target.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const after = await page.evaluate(() => window.__digitalMatterLab!.conversion.selectedAccessoryPosition());
    return after && beforeSlide ? Math.hypot(...after.map((value, axis) => value - beforeSlide[axis])) : 0;
  }).toBeGreaterThan(0.01);

  await workspace.locator('[data-accessory-tool=rotate]').click();
  await expect(workspace.locator('[data-accessory-tool=rotate]')).toHaveAttribute('aria-checked', 'true');
  await workspace.locator('[data-accessory-tool=scale]').click();
  await expect(workspace.locator('[data-accessory-tool=scale]')).toHaveAttribute('aria-checked', 'true');
  await workspace.getByTestId('rigid-weld-duplicate').click();
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.rigidAccessoryCount())).toBe(2);
  await expect(workspace.getByTestId('rigid-weld-list')).toContainText('Plate 2');

  // Destructive source changes require confirmation and preserve the current work when cancelled.
  page.once('dialog', (dialog) => dialog.dismiss());
  await workspace.getByTestId('source-select').selectOption('tshirt');
  await expect(workspace.getByTestId('source-select')).toHaveValue('car-shell');

  const play = workspace.getByTestId('simulation-play');
  await expect(play).toBeEnabled();
  await play.click();
  await expect(play).toHaveText('Pause');
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.accessoryEditing())).toBe(false);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.maxRigidWeldSeparation())).toBeLessThan(0.03);
  await workspace.getByTestId('reset').click();
  expect(await page.evaluate(() => window.__digitalMatterLab!.conversion.rigidAccessoryCount())).toBe(2);
  await edit.click();
  await workspace.getByTestId('rigid-weld-delete').click();
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.rigidAccessoryCount())).toBe(1);
  await workspace.getByTestId('rigid-weld-undo-delete').click();
  await expect.poll(() => page.evaluate(() => window.__digitalMatterLab!.conversion.rigidAccessoryCount())).toBe(2);
});

test('assembly editor brushes welds and shows every vertex in structure mode', async ({ page }) => {
  await page.getByRole('tab', { name: 'Assembly' }).click();
  const editor = page.locator('[data-kind=assembly]');
  const weldCount = () => page.evaluate(() => window.__digitalMatterLab!.assembly.weldCount());
  await editor.locator('[data-tool=weld]').click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const seam = await page.evaluate(() => window.__digitalMatterLab!.assembly.screenPoint(0, 0.72, 0.25));

  const stroke = async () => {
    await page.mouse.move(seam.x, seam.y);
    await page.mouse.down();
    await page.mouse.move(seam.x + 6, seam.y, { steps: 3 });
    await page.mouse.up();
  };

  const seeded = await weldCount();
  await stroke();
  await expect.poll(weldCount).toBeGreaterThan(seeded);
  await expect(editor.getByTestId('assembly-status')).not.toContainText('No touching surface');
  const painted = await weldCount();

  await editor.locator('[data-tool=erase]').click();
  await stroke();
  await expect.poll(weldCount).toBeLessThan(painted);

  await editor.getByTestId('structure-toggle').check();
  await expect(editor.locator('.structure-legend')).toBeVisible();
  await expect(editor.locator('.structure-legend')).toContainText('Vertices');
  await editor.getByRole('radio', { name: 'Simulate' }).click();
  await expect(editor.getByTestId('structure-toggle')).toBeChecked();
  await expect(editor.locator('.structure-legend')).toBeVisible();
});

test('assembly X-ray brush welds a seam buried behind other parts', async ({ page }) => {
  await page.getByRole('tab', { name: 'Assembly' }).click();
  const editor = page.locator('[data-kind=assembly]');
  const weldCount = () => page.evaluate(() => window.__digitalMatterLab!.assembly.weldCount());
  await editor.locator('.part-list-item', { hasText: 'Rigid base' }).click();
  await editor.locator('.part-list-item', { hasText: 'Gel core' }).click({ modifiers: ['Shift'] });
  await expect(editor.locator('.selection-summary')).toContainText('Weld pair');
  await editor.locator('[data-tool=weld]').click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const buried = await page.evaluate(() => window.__digitalMatterLab!.assembly.screenPoint(0, 0.7, 0.05));
  const stroke = async () => {
    await page.mouse.move(buried.x, buried.y);
    await page.mouse.down();
    await page.mouse.move(buried.x + 6, buried.y, { steps: 3 });
    await page.mouse.up();
  };

  const seeded = await weldCount();
  await stroke();
  const surfaceOnly = await weldCount();
  // Edge-aware welding can reach a couple of exposed seam samples even without X-ray.
  expect(surfaceOnly).toBeGreaterThanOrEqual(seeded);
  if (surfaceOnly > seeded) {
    await editor.getByTestId('undo').click();
    await expect.poll(weldCount).toBe(seeded);
  }

  await editor.getByTestId('xray-brush').check();
  await expect(editor.getByTestId('assembly-status')).toContainText('X-ray on');
  await stroke();
  await expect.poll(weldCount).toBeGreaterThan(seeded);
});

test('assembly editor places, transforms, duplicates, and erases parts', async ({ page }) => {
  await page.getByRole('tab', { name: 'Assembly' }).click();
  const editor = page.locator('[data-kind=assembly]');
  const before = await page.evaluate(() => window.__digitalMatterLab!.assembly.partCount());
  expect(before).toBe(3);
  expect(await page.evaluate(() => window.__digitalMatterLab!.assembly.weldCount())).toBeGreaterThan(0);

  await editor.locator('[data-tool=place]').click();
  await editor.getByTestId('place-kind').selectOption('volume');
  await editor.getByTestId('place-preset').selectOption('foam');
  const viewport = editor.locator('.assembly-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Missing assembly viewport');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
  await expect.poll(async () => page.evaluate(() => window.__digitalMatterLab!.assembly.partCount())).toBe(4);

  await editor.getByTestId('part-preset').selectOption('firm-rubber');
  await editor.getByTestId('grid-snap').check();
  await editor.getByTestId('surface-snap').check();
  await editor.locator('[data-tool=move]').click();
  await editor.locator('[data-tool=rotate]').click();
  await editor.locator('[data-tool=scale]').click();

  const cameraBefore = await page.evaluate(() => window.__digitalMatterLab!.assembly.cameraPosition());
  await viewport.hover();
  await page.mouse.wheel(0, -240);
  const cameraAfter = await page.evaluate(() => window.__digitalMatterLab!.assembly.cameraPosition());
  expect(cameraAfter[2]).not.toBeCloseTo(cameraBefore[2], 2);

  await editor.locator('[data-tool=select]').click();
  await page.keyboard.press('w');
  await expect(editor.locator('[data-tool=move]')).toHaveClass(/is-selected/);

  await editor.getByTestId('duplicate').click();
  await expect.poll(async () => page.evaluate(() => window.__digitalMatterLab!.assembly.partCount())).toBe(5);
  await editor.getByTestId('undo').click();
  await expect.poll(async () => page.evaluate(() => window.__digitalMatterLab!.assembly.partCount())).toBe(4);
  await editor.getByTestId('redo').click();
  await expect.poll(async () => page.evaluate(() => window.__digitalMatterLab!.assembly.partCount())).toBe(5);
  await editor.locator('[data-tool=select]').click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await editor.getByTestId('delete-part').click();
  await editor.getByTestId('undo').click();

  const weldsBefore = await page.evaluate(() => window.__digitalMatterLab!.assembly.weldCount());
  await editor.locator('[data-tool=erase]').click();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__digitalMatterLab!.assembly.weldCount())).toBeLessThanOrEqual(weldsBefore);

  await page.locator('[data-kind=assembly]').getByRole('radio', { name: 'Simulate' }).click();
  expect(await page.evaluate(() => window.__digitalMatterLab!.assembly.mode())).toBe('simulate');
  await page.locator('[data-kind=assembly]').getByRole('radio', { name: 'Edit' }).click();
  expect(await page.evaluate(() => window.__digitalMatterLab!.assembly.mode())).toBe('edit');
  await expect.poll(async () => page.evaluate(() => window.__digitalMatterLab!.assembly.partCount())).toBeGreaterThan(3);
});

test('assembly editor remains navigable on laptop and narrow viewports', async ({ page }) => {
  for (const size of [{ width: 1100, height: 700 }, { width: 720, height: 700 }]) {
    await page.setViewportSize(size);
    await page.getByRole('tab', { name: 'Assembly' }).click();
    const editor = page.locator('[data-kind=assembly]');
    const controls = editor.locator('.assembly-editor');
    const viewport = editor.locator('.assembly-viewport');
    const controlsBox = await controls.boundingBox();
    const viewportBox = await viewport.boundingBox();
    expect(controlsBox?.width).toBeGreaterThanOrEqual(270);
    expect(viewportBox?.width).toBeGreaterThan(300);
    await expect(editor.getByTestId('place-part')).toBeVisible();
    const weld = editor.getByRole('radio', { name: 'Add welds' });
    await weld.scrollIntoViewIfNeeded();
    await expect(weld).toBeVisible();
    await weld.click();
    await expect(editor.getByTestId('brush-radius')).toBeVisible();
    await expect(editor.getByTestId('assembly-status')).toBeVisible();
  }
});

test('assembly simulation controls expose state and safety feedback', async ({ page }) => {
  await page.getByRole('tab', { name: 'Assembly' }).click();
  const editor = page.locator('[data-kind=assembly]');
  await editor.getByRole('radio', { name: 'Simulate' }).click();
  const grab = editor.getByRole('radio', { name: 'Grab' });
  await expect(grab).toHaveAttribute('aria-checked', 'true');
  await expect(editor.getByTestId('simulation-play')).toHaveText('Play');
  await expect(editor.getByTestId('assembly-status')).toContainText('paused');
  await editor.getByRole('radio', { name: 'Edit' }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await editor.getByTestId('clear-assembly').scrollIntoViewIfNeeded();
  await editor.getByTestId('clear-assembly').click();
  expect(await page.evaluate(() => window.__digitalMatterLab!.assembly.partCount())).toBe(3);
});

test('creator workflows walk every example through three authoring paths', async ({ page }) => {
  await page.getByRole('tab', { name: 'Creator workflows' }).click();
  const workspace = page.getByTestId('creator-workflow');
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('.workflow-card')).toHaveCount(3);
  await expect(workspace.getByRole('heading', { name: 'Engine-generated shell' })).toBeVisible();
  await expect(workspace.getByRole('heading', { name: 'Creator simulation plane' })).toBeVisible();
  await expect(workspace.getByRole('heading', { name: 'Engine-thickened surface' })).toBeVisible();

  const asset = workspace.getByTestId('workflow-asset');
  const ids = ['tshirt', 'ruffled-skirt', 'puffer-jacket', 'sheet-metal', 'hooded-jacket', 'fish-flag'];
  for (const id of ids) {
    await asset.selectOption(id);
    await expect(workspace.locator('.workflow-card[aria-busy=true]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__digitalMatterLab!.creator.meshSources())).toEqual([
      'authored',
      'authored',
      'authored',
    ]);
    await workspace.getByTestId('workflow-cap-1').click();
    await workspace.getByTestId('workflow-stage-simulate').click();
    await workspace.getByTestId('workflow-simulation-play').click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Math.min(...window.__digitalMatterLab!.creator.simulationStats().map((entry) => entry.maxDeformation)),
        ),
      )
      .toBeGreaterThan(0.003);
    const stats = await page.evaluate(() => window.__digitalMatterLab!.creator.simulationStats());
    expect(stats.every((entry) => entry.vertexCount > 20), id).toBe(true);
    await workspace.getByTestId('workflow-stage-submit').click();
  }

  await workspace.getByTestId('workflow-stage-build').click();
  await expect(workspace.locator('.workflow-stage-badge')).toHaveText(['Build', 'Build', 'Build']);
  await expect(workspace.getByTestId('workflow-thickness')).toBeVisible();
  await workspace.getByTestId('workflow-thickness').fill('2.5');
  await expect(workspace.getByTestId('workflow-caption-shell')).toContainText('render but are not simulated');
  await expect(workspace.getByTestId('workflow-caption-thicken')).toContainText('boundary UVs');
  await workspace.getByTestId('workflow-next').click();
  await expect(workspace.getByTestId('workflow-simulation-controls')).toBeVisible();
  await workspace.getByTestId('workflow-wind').fill('4');
  await workspace.getByTestId('workflow-simulation-play').click();
  await expect(workspace.getByTestId('workflow-simulation-play')).toHaveText('Pause');
  await workspace.getByTestId('workflow-simulation-play').click();
  await workspace.getByTestId('workflow-simulation-reset').click();
  const state = await page.evaluate(() => window.__digitalMatterLab!.creator.state());
  expect(state).toMatchObject({ assetId: 'fish-flag', stage: 'simulate', endCaps: [1], thicknessCm: 2.5, wind: 4, simulationPaused: true });
});

test('creator marks end caps by clicking the arbitrary mesh in path 1', async ({ page }) => {
  await page.getByRole('tab', { name: 'Creator workflows' }).click();
  const workspace = page.getByTestId('creator-workflow');
  await expect(workspace.locator('.workflow-card[aria-busy=true]')).toHaveCount(0);
  await expect(workspace.getByTestId('workflow-cap-status')).toHaveText('No end caps: full mesh simulates');
  const before = await page.evaluate(() => window.__digitalMatterLab!.creator.proxyParticleCounts());

  const cuff = await page.evaluate(() => window.__digitalMatterLab!.creator.capScreenPoint(4));
  expect(cuff).not.toBeNull();
  await page.mouse.move(cuff!.x, cuff!.y);
  await expect(workspace.getByTestId('workflow-caption-shell')).toContainText('Right cuff');
  await page.mouse.down();
  await page.mouse.up();
  await expect(workspace.getByTestId('workflow-cap-4')).toHaveAttribute('aria-pressed', 'true');
  await expect(workspace.getByTestId('workflow-cap-status')).toContainText('1 end cap marked');

  await workspace.getByTestId('workflow-cap-1').click();
  await workspace.getByTestId('workflow-cap-2').click();
  await workspace.getByTestId('workflow-cap-3').click();
  await expect
    .poll(async () => page.evaluate(() => window.__digitalMatterLab!.creator.proxyParticleCounts()[0]))
    .toBeLessThan(before[0]);
  const after = await page.evaluate(() => window.__digitalMatterLab!.creator.proxyParticleCounts());
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(await page.evaluate(() => window.__digitalMatterLab!.creator.state().endCaps)).toEqual([1, 2, 3, 4]);

  await workspace.getByTestId('workflow-caps-clear').click();
  await expect(workspace.getByTestId('workflow-cap-status')).toHaveText('No end caps: full mesh simulates');
});

test('creator workflow hides the render mesh to show the simulation mesh alone', async ({ page }) => {
  await page.getByRole('tab', { name: 'Creator workflows' }).click();
  const workspace = page.getByTestId('creator-workflow');
  await expect(workspace.locator('.workflow-card[aria-busy=true]')).toHaveCount(0);
  const toggle = workspace.getByTestId('workflow-render');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  expect((await page.evaluate(() => window.__digitalMatterLab!.creator.state())).showRender).toBe(false);
  await workspace.getByTestId('workflow-stage-simulate').click();
  await expect(toggle).not.toBeChecked();
  await expect(workspace.getByTestId('workflow-mapping')).toBeDisabled();
  await toggle.check();
  await expect(workspace.getByTestId('workflow-mapping')).toBeEnabled();
});

test('creator workflow step stepper supports keyboard navigation', async ({ page }) => {
  await page.getByRole('tab', { name: 'Creator workflows' }).click();
  const submit = page.getByTestId('workflow-stage-submit');
  await submit.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('workflow-stage-build')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('End');
  await expect(page.getByTestId('workflow-stage-simulate')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Home');
  await expect(submit).toHaveAttribute('aria-checked', 'true');
});

test('creator workflow pans on two-finger trackpad scroll and resets the view', async ({ page }) => {
  await page.getByRole('tab', { name: 'Creator workflows' }).click();
  const workspace = page.getByTestId('creator-workflow');
  await expect(workspace.getByTestId('workflow-camera-hint')).toContainText('Two-finger scroll');
  const initialTargets = await page.evaluate(() => window.__digitalMatterLab!.creator.cameraTargets());
  const initialCameras = await page.evaluate(() => window.__digitalMatterLab!.creator.cameraPositions());
  const bounds = await workspace.getByTestId('workflow-viewport-thicken').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(14, 9);

  await expect
    .poll(async () => page.evaluate(() => window.__digitalMatterLab!.creator.cameraTargets()[0][0]))
    .toBeGreaterThan(initialTargets[0][0] + 0.02);
  const targets = await page.evaluate(() => window.__digitalMatterLab!.creator.cameraTargets());
  const cameras = await page.evaluate(() => window.__digitalMatterLab!.creator.cameraPositions());
  for (let panel = 1; panel < 3; panel += 1) {
    for (let axis = 0; axis < 3; axis += 1) expect(targets[panel][axis]).toBeCloseTo(targets[0][axis], 6);
  }
  // Panning keeps the distance to the target: it is not a zoom.
  const distance = (camera: number[], target: number[]) => Math.hypot(...camera.map((value, axis) => value - target[axis]));
  expect(distance(cameras[0], targets[0])).toBeCloseTo(distance(initialCameras[0], initialTargets[0]), 2);

  await workspace.getByTestId('workflow-reset-view').click();
  await expect
    .poll(async () => page.evaluate(() => window.__digitalMatterLab!.creator.cameraTargets()))
    .toEqual(initialTargets);
});

test('creator workflow cameras remain synchronized and narrow layout does not overflow', async ({ page }) => {
  await page.getByRole('tab', { name: 'Creator workflows' }).click();
  const workspace = page.getByTestId('creator-workflow');
  const initial = await page.evaluate(() => window.__digitalMatterLab!.creator.cameraPositions());
  const firstViewport = workspace.getByTestId('workflow-viewport-plane');
  const bounds = await firstViewport.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.55, bounds!.y + bounds!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.72, bounds!.y + bounds!.height * 0.65, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => page.evaluate(() => window.__digitalMatterLab!.creator.cameraPositions()))
    .not.toEqual(initial);
  const cameras = await page.evaluate(() => window.__digitalMatterLab!.creator.cameraPositions());
  for (const camera of cameras.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) expect(camera[axis]).toBeCloseTo(cameras[0][axis], 10);
  }

  await page.setViewportSize({ width: 600, height: 800 });
  await expect(workspace.locator('.workflow-card').first()).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
