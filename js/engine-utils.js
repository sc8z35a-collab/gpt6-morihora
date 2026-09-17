/* Small engine utilities. Shared buffers and static geometry batches, no runtime dependencies beyond Three.js. */
'use strict';
(() => {
  class GridNavigation {
    constructor(size, tile) {
      this.size = size;
      this.tile = tile;
      this.total = size * size;
      this.queue = new Int16Array(this.total);
      this.neighbors = new Int16Array(this.total * 4);
      this.neighbors.fill(-1);
      this.positions = new Array(this.total);
      this.builds = 0;
      for (let i = 0; i < this.total; i++) {
        const x = i % size, y = Math.floor(i / size), base = i * 4;
        this.positions[i] = Object.freeze({ x: x * tile, z: -y * tile });
        if (x > 0) this.neighbors[base] = i - 1;
        if (x < size - 1) this.neighbors[base + 1] = i + 1;
        if (y > 0) this.neighbors[base + 2] = i - size;
        if (y < size - 1) this.neighbors[base + 3] = i + size;
      }
    }

    distances(grid, start, output = new Int16Array(this.total)) {
      output.fill(-1);
      if (start < 0 || start >= this.total || grid[start] !== 0) return output;
      const queue = this.queue, neighbors = this.neighbors;
      let head = 0, tail = 1;
      queue[0] = start;
      output[start] = 0;
      this.builds++;
      while (head < tail) {
        const current = queue[head++], base = current * 4, depth = output[current] + 1;
        for (let k = 0; k < 4; k++) {
          const next = neighbors[base + k];
          if (next >= 0 && grid[next] === 0 && output[next] < 0) {
            output[next] = depth;
            queue[tail++] = next;
          }
        }
      }
      return output;
    }

    descend(grid, field, current) {
      let best = current, depth = field[current];
      for (let k = current * 4, end = k + 4; k < end; k++) {
        const next = this.neighbors[k];
        if (next >= 0 && grid[next] === 0 && field[next] >= 0 && field[next] < depth) {
          best = next;
          depth = field[next];
        }
      }
      return best;
    }

    blocked(grid, col, row) { return col < 0 || row < 0 || col >= this.size || row >= this.size || grid[row * this.size + col] !== 0; }

    // Supercover DDA visits every crossed grid cell, including both sides of exact corners.
    lineClear(grid, ax, az, bx, bz) {
      const size = this.size, tile = this.tile;
      const x0 = ax / tile + .5, y0 = -az / tile + .5;
      const x1 = bx / tile + .5, y1 = -bz / tile + .5;
      let col = Math.floor(x0), row = Math.floor(y0);
      const endCol = Math.floor(x1), endRow = Math.floor(y1);
      if (this.blocked(grid, col, row) || this.blocked(grid, endCol, endRow)) return false;
      const dx = x1 - x0, dy = y1 - y0, stepX = Math.sign(dx), stepY = Math.sign(dy);
      const deltaX = dx ? 1 / Math.abs(dx) : Infinity, deltaY = dy ? 1 / Math.abs(dy) : Infinity;
      let nextX = dx ? (dx > 0 ? col + 1 - x0 : x0 - col) * deltaX : Infinity;
      let nextY = dy ? (dy > 0 ? row + 1 - y0 : y0 - row) * deltaY : Infinity;
      for (let guard = 0; guard <= size * 2; guard++) {
        if (col === endCol && row === endRow) return true;
        if (Math.abs(nextX - nextY) < 1e-10) {
          if (this.blocked(grid, col + stepX, row) || this.blocked(grid, col, row + stepY)) return false;
          col += stepX; row += stepY; nextX += deltaX; nextY += deltaY;
        } else if (nextX < nextY) { col += stepX; nextX += deltaX; }
        else { row += stepY; nextY += deltaY; }
        if (this.blocked(grid, col, row)) return false;
      }
      return false;
    }

    corridorClear(grid, ax, az, bx, bz, radius = .22) {
      if (!this.lineClear(grid, ax, az, bx, bz)) return false;
      const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
      if (length < .001) return true;
      const nx = -dz / length * radius, nz = dx / length * radius;
      return this.lineClear(grid, ax + nx, az + nz, bx + nx, bz + nz) &&
        this.lineClear(grid, ax - nx, az - nz, bx - nx, bz - nz);
    }
  }

  function mergeGeometry(entries, withColor) {
    let vertexCount = 0, indexCount = 0;
    for (const entry of entries) {
      vertexCount += entry.geometry.attributes.position.count;
      indexCount += entry.geometry.index ? entry.geometry.index.count : entry.geometry.attributes.position.count;
    }
    const positions = new Float32Array(vertexCount * 3), normals = new Int16Array(vertexCount * 3);
    const colors = withColor ? new Uint16Array(vertexCount * 3) : null;
    const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    const normalMatrix = new THREE.Matrix3(), point = new THREE.Vector3(), normal = new THREE.Vector3();
    let offset = 0, indexOffset = 0;
    for (const entry of entries) {
      const { geometry, matrix, color } = entry, p = geometry.attributes.position, n = geometry.attributes.normal;
      normalMatrix.getNormalMatrix(matrix);
      for (let i = 0; i < p.count; i++) {
        point.fromBufferAttribute(p, i).applyMatrix4(matrix);
        normal.fromBufferAttribute(n, i).applyNormalMatrix(normalMatrix);
        const target = (offset + i) * 3;
        positions[target] = point.x; positions[target + 1] = point.y; positions[target + 2] = point.z;
        normals[target] = Math.round(normal.x * 32767); normals[target + 1] = Math.round(normal.y * 32767); normals[target + 2] = Math.round(normal.z * 32767);
        if (colors) { colors[target] = Math.round(color.r * 65535); colors[target + 1] = Math.round(color.g * 65535); colors[target + 2] = Math.round(color.b * 65535); }
      }
      if (geometry.index) for (let i = 0; i < geometry.index.count; i++) indices[indexOffset++] = offset + geometry.index.getX(i);
      else for (let i = 0; i < p.count; i++) indices[indexOffset++] = offset + i;
      offset += p.count;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true));
    if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  }

  // World-space transforms are baked only once. Each 24m sector becomes one opaque draw call.
  function batchStatic(parent, material, sectorSize = 24) {
    const groups = new Map(), sources = [], matrix = new THREE.Matrix4(), local = new THREE.Matrix4();
    function add(source, transform) {
      const x = transform.elements[12], z = transform.elements[14];
      const key = `${Math.floor(x / sectorSize)},${Math.floor(z / sectorSize)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ geometry: source.geometry, matrix: transform.clone(), color: source.material.color });
    }
    for (const child of parent.children) {
      if (!child.isMesh || child.isSprite || child.material.transparent || child.material.map || (child.material.emissiveIntensity && child.material.emissive?.getHex() !== 0)) continue;
      child.updateMatrix();
      if (child.isInstancedMesh) {
        for (let i = 0; i < child.count; i++) { child.getMatrixAt(i, local); matrix.multiplyMatrices(child.matrix, local); add(child, matrix); }
      } else add(child, child.matrix);
      sources.push(child);
    }
    const chunks = [];
    for (const entries of groups.values()) {
      const chunk = new THREE.Mesh(mergeGeometry(entries, true), material);
      chunk.userData.ownedGeometry = true;
      chunk.matrixAutoUpdate = false;
      parent.add(chunk); chunks.push(chunk);
    }
    for (const child of sources) { parent.remove(child); if (child.isInstancedMesh) child.dispose(); }
    return chunks;
  }

  // Rigid subparts share a draw call by material, while the parent still animates normally.
  function batchRigid(parent) {
    const groups = new Map(), sources = [];
    for (const child of parent.children) {
      if (!child.isMesh || child.isInstancedMesh || child.isSprite || child.material.transparent) continue;
      child.updateMatrix();
      if (!groups.has(child.material)) groups.set(child.material, []);
      groups.get(child.material).push({ geometry: child.geometry, matrix: child.matrix.clone() });
      sources.push(child);
    }
    for (const [material, entries] of groups) {
      if (entries.length === 1) continue;
      const merged = new THREE.Mesh(mergeGeometry(entries, false), material);
      merged.userData.ownedGeometry = true; merged.matrixAutoUpdate = false; parent.add(merged);
      for (const source of sources) if (source.material === material) {
        parent.remove(source);
        if (source.userData.ownedGeometry) source.geometry.dispose();
      }
    }
    parent.traverse(child => { if (child.isMesh && !child.isSprite) { child.updateMatrix(); child.matrixAutoUpdate = false; } });
  }

  function updateChunks(chunks, x, z, range = 70) {
    const max = range * range;
    for (const chunk of chunks) {
      const box = chunk.geometry.boundingBox;
      const dx = Math.max(box.min.x - x, 0, x - box.max.x), dz = Math.max(box.min.z - z, 0, z - box.max.z);
      chunk.visible = dx * dx + dz * dz < max;
    }
  }

  class FixedStepper {
    constructor() { this.step = 1 / 60; this.accumulator = 0; this.droppedSeconds = 0; }
    reset() { this.accumulator = 0; }
    advance(seconds, tick) {
      if (!Number.isFinite(seconds) || seconds <= 0) return 0;
      const bounded = Math.min(seconds, .1); this.droppedSeconds += seconds - bounded;
      this.accumulator += bounded;
      let steps = 0;
      while (this.accumulator + 1e-9 >= this.step && steps < 6) {
        this.accumulator = Math.max(0, this.accumulator - this.step); tick(this.step); steps++;
      }
      return steps;
    }
  }

  window.ForestEngine = Object.freeze({ GridNavigation, batchStatic, batchRigid, updateChunks, FixedStepper });
})();
