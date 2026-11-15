# Dry Run

A DurHack camera-to-3D workbench: capture an object, confirm its identity, watch
it materialize in inventory, then click to place it in the workshop.

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/viewer/>. The workbench starts empty. Capture **Box**
once and click its card repeatedly to build a visual stack. Capture the
**Cylindrical Sweeper**, place it once and adjust its tilt and stick rotation.
Unfamiliar objects use manually chosen, explicitly approximate primitive shapes.
All final physical models use opaque monochrome materials.

Photographs and scene placement stay in memory for the tab. Known GLBs are
permanent repository assets and are loaded once, then cloned. No frontend build,
runtime Blender or image-to-3D service is required.

See [model generation, architecture, demo and tests](docs/models.md) and
[camera instructions](docs/camera-inventory.md). The original historical plan is
in [docs/PRD.md](docs/PRD.md); newer scoped requirements supersede its older exclusions.
