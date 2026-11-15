# GEKKO

Real decentralized MuJoCo planning. Three terminals from the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1                   # viewer files
.venv312/bin/python -m swarm.server --workers 6 --demo         # agents on ws://localhost:8765
.venv312/bin/python -m sim.server                              # manual sweeps on ws://localhost:8766
```

Open `http://localhost:8080/viewer/`. `--demo` starts planning the three-box demo at
launch (about a minute to a validated plan); otherwise click **Load Three-Box Demo**.
**Send to Arduino** is a human-confirmed dry run: it logs the servo commands
(`G 0 <start>`, `P 0 <start> <end> <speed>`) and sends nothing to hardware.
Viewer options: `?observer=ws://host:port` and `?physics=ws://host:port` change the
server addresses; `?offline=1` uses the vendored three.js in `viewer/vendor/three`
and system fonts (also automatic when the browser reports no network). See [docs/swarm.md](docs/swarm.md) for setup,
architecture, controls, reliability reports and physical limitations.
UNO Q execution is disabled at the operator's request. The old fake observer
is a legacy development tool, not the real planning backend.

# Gekko

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
