"""FloodShield AI — flow-path + heightmap engine (NumPy, CPU).

Production contract:
- `generate_from_grid(grid, cell_m, building)` traces a REAL surveyed DEM grid.
  This is the production path — callers supply elevation in meters.
- `generate_synthetic(seed, size, cell_m, building)` builds an analytical test
  terrain. It is explicitly labelled synthetic and must only be used for
  local dev / CI, never as a substitute for a survey.
Single source of truth for Leaflet 2D + R3F 3D.
"""
import numpy as np


def _fade(t):
    return t * t * (3 - 2 * t)


def _synthetic_dem(size, seed=42, scale=8.0):
    rng = np.random.default_rng(seed)
    gx = int(size / scale) + 3
    gy = int(size / scale) + 3
    grad = rng.uniform(-1, 1, (gy, gx))
    out = np.zeros((size, size))
    for y in range(size):
        for x in range(size):
            fx, fy = x / scale, y / scale
            x0, y0 = int(fx), int(fy)
            tx, ty = _fade(fx - x0), _fade(fy - y0)
            a = grad[y0, x0] * (1 - tx) + grad[y0, x0 + 1] * tx
            b = grad[y0 + 1, x0] * (1 - tx) + grad[y0 + 1, x0 + 1] * tx
            out[y, x] = a * (1 - ty) + b * ty
    out = (out - out.min()) / (out.max() - out.min() + 1e-9)
    yy, xx = np.mgrid[0:size, 0:size]
    tilt = (xx + yy) / (2 * size) * 0.6
    # Gentle-plains relief (~7m): analytical fallback must not look like mountains.
    elev = 14.0 - out * 3.5 - tilt * 4.0  # ~6.5..14m
    return elev


def trace_flow(grid):
    grid = np.asarray(grid, dtype=float)
    if grid.ndim != 2 or grid.shape[0] < 4 or grid.shape[1] < 4:
        raise ValueError("elevation grid must be at least 4x4")
    h, w = grid.shape
    y, x = np.unravel_index(np.argmax(grid), grid.shape)
    path = []
    visited = set()
    for _ in range(h * w):
        path.append((float(x) / (w - 1), float(y) / (h - 1), float(grid[y, x])))
        visited.add((y, x))
        best, bv = None, grid[y, x]
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and (ny, nx) not in visited:
                    if grid[ny, nx] < bv:
                        bv = grid[ny, nx]
                        best = (ny, nx)
        if best is None:
            break
        y, x = best
    return path


def _package(grid, path, size, cell_m, building, source):
    intersects = False
    if building:
        bx, by = building.get("x", 0.4), building.get("y", 0.4)
        bw, bd = building.get("w", 0.2), building.get("d", 0.2)
        for px, py, _ in path:
            if bx <= px <= bx + bw and by <= py <= by + bd:
                intersects = True
                break
    step = max(1, len(path) // 120)
    return {
        "size": size,
        "cell_m": cell_m,
        "grid": [[round(float(v), 2) for v in row] for row in grid.tolist()],
        "flow_path": [
            {"x": round(px, 4), "y": round(py, 4), "h": round(ph, 2)}
            for px, py, ph in path[::step]
        ],
        "intersects": intersects,
        "outlet": {"x": path[-1][0], "y": path[-1][1]} if path else {"x": 1, "y": 1},
        "source": source,
        "synthetic": source != "surveyed-dem",
    }


def burn_drains(grid, burn_lines, depth_m=1.0):
    """Carve registry drains into the DEM so traced flow snaps to real drains.

    burn_lines: list of normalized polylines [[[x,y],...]] in 0..1 site frame.
    Each cell crossed by a line is lowered by depth_m (per-line depth when the
    item is a dict {pts, depth_m}). Bresenham rasterization, 1-cell wide.
    """
    import numpy as np  # local import keeps module import light
    n = grid.shape[0]
    carved = 0
    items = burn_lines or []
    for item in items:
        pts = item.get("pts") if isinstance(item, dict) else item
        dep = float(item.get("depth_m", depth_m)) if isinstance(item, dict) else float(depth_m)
        dep = max(0.2, min(3.0, dep))
        if not pts or len(pts) < 2:
            continue
        idx = []
        for x, y in pts:
            try:
                ix = int(round(float(x) * (n - 1)))
                iy = int(round(float(y) * (n - 1)))
            except (TypeError, ValueError):
                continue
            idx.append((max(0, min(n - 1, ix)), max(0, min(n - 1, iy))))
        for (x0, y0), (x1, y1) in zip(idx, idx[1:]):
            dx, dy = abs(x1 - x0), abs(y1 - y0)
            steps = max(dx, dy, 1)
            for s in range(steps + 1):
                t = s / steps
                ix = int(round(x0 + (x1 - x0) * t))
                iy = int(round(y0 + (y1 - y0) * t))
                if 0 <= iy < n and 0 <= ix < n:
                    grid[iy, ix] -= dep
                    carved += 1
    return grid, carved


def generate_from_grid(elevation_grid, cell_m=5.0, building=None, burn_lines=None, burn_depth_m=1.0):
    """Production entry point: trace flow over a surveyed DEM grid (meters)."""
    grid = np.asarray(elevation_grid, dtype=float)
    if grid.ndim != 2:
        raise ValueError("elevation_grid must be a 2D array [rows][cols] in meters")
    n = grid.shape[0]
    if grid.shape[0] != grid.shape[1]:
        raise ValueError("elevation_grid must be square (NxN)")
    if not (8 <= n <= 256):
        raise ValueError("elevation_grid size must be 8..256")
    if not np.isfinite(grid).all():
        raise ValueError("elevation_grid contains non-finite values")
    grid = grid.copy()
    carved = 0
    if burn_lines:
        grid, carved = burn_drains(grid, burn_lines, burn_depth_m)
    path = trace_flow(grid)
    out = _package(grid, path, n, cell_m, building, "surveyed-dem")
    if burn_lines:
        out["source"] = "surveyed-dem+burned-drains"
        out["burned_cells"] = carved
    return out


def generate_synthetic(seed=42, size=64, cell_m=5.0, building=None):
    """Test/dev-only analytical terrain. Response is labelled synthetic."""
    if not (8 <= size <= 256):
        raise ValueError("size must be 8..256")
    grid = _synthetic_dem(size, seed=seed)
    path = trace_flow(grid)
    return _package(grid, path, size, cell_m, building, "analytical-synthetic-v1")


# Back-compat alias — behaves as synthetic and is labelled as such.
def generate_heightmap(seed=42, size=64, cell_m=5.0, building=None):
    return generate_synthetic(seed=seed, size=size, cell_m=cell_m, building=building)


def perlin(size, seed=42, scale=8.0):
    return _synthetic_dem(size, seed=seed, scale=scale)
