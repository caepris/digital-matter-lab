/** Dense spatial hash for neighbour queries among particles (after Müller, "Ten Minute Physics"). */
export class SpatialHash {
  private readonly tableSize: number;
  private readonly cellStart: Int32Array;
  private readonly cellEntries: Int32Array;
  private readonly queryMarks: Int32Array;
  private queryStamp = 0;
  readonly queryIds: Int32Array;
  querySize = 0;

  constructor(
    private readonly spacing: number,
    maxObjects: number,
  ) {
    this.tableSize = 2 * maxObjects;
    this.cellStart = new Int32Array(this.tableSize + 1);
    this.cellEntries = new Int32Array(maxObjects);
    this.queryIds = new Int32Array(maxObjects);
    this.queryMarks = new Int32Array(maxObjects);
  }

  private hashCoords(xi: number, yi: number, zi: number): number {
    const h = (xi * 92837111) ^ (yi * 689287499) ^ (zi * 283923481);
    return Math.abs(h) % this.tableSize;
  }

  private cell(coordinate: number): number {
    return Math.floor(coordinate / this.spacing);
  }

  create(positions: Float32Array, count = positions.length / 3): void {
    this.cellStart.fill(0);
    this.cellEntries.fill(0);
    for (let i = 0; i < count; i++) {
      const h = this.hashCoords(
        this.cell(positions[i * 3]),
        this.cell(positions[i * 3 + 1]),
        this.cell(positions[i * 3 + 2]),
      );
      this.cellStart[h]++;
    }
    let start = 0;
    for (let i = 0; i < this.tableSize; i++) {
      start += this.cellStart[i];
      this.cellStart[i] = start;
    }
    this.cellStart[this.tableSize] = start;
    for (let i = 0; i < count; i++) {
      const h = this.hashCoords(
        this.cell(positions[i * 3]),
        this.cell(positions[i * 3 + 1]),
        this.cell(positions[i * 3 + 2]),
      );
      this.cellStart[h]--;
      this.cellEntries[this.cellStart[h]] = i;
    }
  }

  /** Collects candidate ids within `maxDistance` of particle `index` into `queryIds[0..querySize)`. */
  query(positions: Float32Array, index: number, maxDistance: number): void {
    const x0 = this.cell(positions[index * 3] - maxDistance);
    const y0 = this.cell(positions[index * 3 + 1] - maxDistance);
    const z0 = this.cell(positions[index * 3 + 2] - maxDistance);
    const x1 = this.cell(positions[index * 3] + maxDistance);
    const y1 = this.cell(positions[index * 3 + 1] + maxDistance);
    const z1 = this.cell(positions[index * 3 + 2] + maxDistance);
    this.querySize = 0;
    this.queryStamp++;
    if (this.queryStamp === 0x7fffffff) {
      this.queryMarks.fill(0);
      this.queryStamp = 1;
    }
    for (let xi = x0; xi <= x1; xi++) {
      for (let yi = y0; yi <= y1; yi++) {
        for (let zi = z0; zi <= z1; zi++) {
          const h = this.hashCoords(xi, yi, zi);
          for (let i = this.cellStart[h]; i < this.cellStart[h + 1]; i++) {
            const id = this.cellEntries[i];
            // Distinct grid cells can hash to the same bucket. Return each object once so
            // callers never overrun the fixed-size query buffer or solve a contact repeatedly.
            if (this.queryMarks[id] === this.queryStamp) continue;
            this.queryMarks[id] = this.queryStamp;
            this.queryIds[this.querySize++] = id;
          }
        }
      }
    }
  }
}
