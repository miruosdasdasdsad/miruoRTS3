// Team knowledge belongs to the simulation. Rendering and input share these cells.
export const FOG_CELL_SIZE = 24;
export const UNIT_VISION = Object.freeze({ infantry: 320, tank: 350, sniper: 420, rocketeer: 350, striker: 310, scout: 560, heavyTank: 330, artillery: 380 });
export const BUILDING_VISION = Object.freeze({ hq: 650, power: 330, barracks: 360, factory: 380, tower: 440, academy: 360, arsenal: 360, mobility: 400 });

export function visionRadius(entity) {
  if (entity.hp <= 0 || entity.team < 0) return 0;
  if (entity.kind === 'core') return entity.dock ? 0 : 180;
  if (entity.kind === 'unit') return UNIT_VISION[entity.type] || 320;
  if (entity.kind === 'building') return entity.construction ? entity.r + 24 : BUILDING_VISION[entity.type] || 330;
  return 0;
}

export class FogOfWar {
  constructor(width, height, cellSize = FOG_CELL_SIZE) {
    this.width = width; this.height = height; this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize); this.rows = Math.ceil(height / cellSize); this.revision = 0;
    this.teams = Array.from({ length: 2 }, () => ({ visible: new Uint8Array(this.cols * this.rows), explored: new Uint8Array(this.cols * this.rows), buildings: new Map(), sources: [] }));
  }
  index(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return Math.floor(y / this.cellSize) * this.cols + Math.floor(x / this.cellSize);
  }
  stateAt(team, x, y) {
    const state = this.teams[team], index = this.index(x, y);
    return !state || index < 0 ? 0 : state.visible[index] ? 2 : state.explored[index] ? 1 : 0;
  }
  update(entities) {
    const sources = [[], []], living = new Map();
    for (const entity of entities) {
      if (entity.hp <= 0) continue;
      living.set(entity.id, entity);
      const radius = visionRadius(entity);
      if (radius) sources[entity.team].push({ x: entity.x, y: entity.y, radius });
    }
    for (let team = 0; team < 2; team++) {
      const state = this.teams[team], next = sources[team];
      const changed = next.length !== state.sources.length || next.some((source, i) => {
        const previous = state.sources[i];
        return source.x !== previous.x || source.y !== previous.y || source.radius !== previous.radius;
      });
      if (changed) {
        state.visible.fill(0);
        for (const source of next) this.reveal(state, source);
        state.sources = next; this.revision++;
      }
      // Only refresh or remove a remembered building when its location is seen again.
      for (const [id, memory] of state.buildings) if (this.stateAt(team, memory.x, memory.y) === 2 && !living.has(id)) state.buildings.delete(id);
      for (const entity of living.values()) if (entity.kind === 'building' && entity.team !== team && this.stateAt(team, entity.x, entity.y) === 2) {
        const { id, kind, type, team: owner, x, y, r } = entity;
        state.buildings.set(id, Object.freeze({ id, kind, type, team: owner, x, y, r }));
      }
    }
  }
  reveal(state, { x, y, radius }) {
    const size = this.cellSize;
    const left = Math.max(0, Math.floor((x - radius) / size)), right = Math.min(this.cols - 1, Math.floor((x + radius) / size));
    const top = Math.max(0, Math.floor((y - radius) / size)), bottom = Math.min(this.rows - 1, Math.floor((y + radius) / size));
    for (let row = top; row <= bottom; row++) {
      const dy = (row + .5) * size - y, span = radius * radius - dy * dy;
      for (let col = left; col <= right; col++) if (((col + .5) * size - x) ** 2 <= span) {
        const index = row * this.cols + col; state.visible[index] = 1; state.explored[index] = 1;
      }
    }
  }
  rememberedBuildings(team) {
    return [...this.teams[team].buildings.values()].filter(entity => this.stateAt(team, entity.x, entity.y) !== 2);
  }
  summary(team) {
    const state = this.teams[team];
    return { visibleCells: state.visible.reduce((sum, value) => sum + value, 0), exploredCells: state.explored.reduce((sum, value) => sum + value, 0), rememberedBuildings: this.rememberedBuildings(team) };
  }
}
